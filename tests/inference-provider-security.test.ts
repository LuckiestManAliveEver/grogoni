import { describe, expect, it } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { redactRecord, redactSecrets } from "../services/api/src/inference/providers/redaction";
import {
  catalogModel,
  createTestPlatform,
  failingDeviceProvider,
  localProviderConfig
} from "./fixtures/inference-provider-fakes";

// Hosted providers and BYOK keys were removed with the local-first runtime
// (docs/local-first-cloud-audit.md). What remains to guard: the retired key routes stay gone,
// operators cannot re-register a hosted provider, and failure logs stay redacted.

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}

async function signUp(app: ReturnType<typeof buildApi>, contact: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  return {
    cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] as string,
    accountId: signup.json<{ account: { id: string } }>().account.id
  };
}

function appWithPlatform() {
  const { platform } = createTestPlatform({ catalog: [] });
  const store = createCp2Store({ inferencePlatform: platform });
  return { app: buildApi({ cp2: { store } }), store };
}

describe("retired BYOK provider connections", () => {
  it("no longer serves any provider-connection route", async () => {
    const { app } = appWithPlatform();
    try {
      const person = await signUp(app, "+254700007101");
      for (const [method, url] of [
        ["GET", "/v1/ai/provider-connections"],
        ["POST", "/v1/ai/provider-connections"],
        ["POST", "/v1/ai/provider-connections/conn-1/test"],
        ["DELETE", "/v1/ai/provider-connections/conn-1"]
      ] as const) {
        const response = await app.inject({
          method,
          url,
          // Fastify rejects an empty JSON body with 400, so only POST declares one.
          headers: method === "POST" ? jsonHeaders(person.cookie) : { cookie: person.cookie },
          ...(method === "POST"
            ? {
                payload: JSON.stringify({
                  providerId: "openai",
                  apiKey: "sk-should-never-be-accepted-000000000000"
                })
              }
            : {})
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
        expect(response.body).not.toContain("sk-should-never-be-accepted");
      }
    } finally {
      await app.close();
    }
  });

  it("lists only the device-local provider, with no credential fields", async () => {
    const { app } = appWithPlatform();
    try {
      const person = await signUp(app, "+254700007102");
      const response = await app.inject({
        method: "GET",
        url: "/v1/ai/providers",
        headers: { cookie: person.cookie }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        providers: [
          {
            id: "local",
            displayName: "Local AI (this device)",
            type: "local",
            executionTarget: "browser-local",
            enabled: true
          }
        ]
      });
      expect(response.body).not.toMatch(/byok|credential|baseUrl/iu);
    } finally {
      await app.close();
    }
  });
});

describe("operator provider management", () => {
  it("rejects every hosted provider type and accepts only device-local rows", async () => {
    const { app, store } = appWithPlatform();
    try {
      const operator = await signUp(app, "+254700007103");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test" });
      for (const type of ["openai", "anthropic", "zai", "openai-compatible", "chatgpt-web"]) {
        const rejected = await app.inject({
          method: "PUT",
          url: "/v1/platform/ai/providers/team-gateway",
          headers: jsonHeaders(operator.cookie),
          payload: JSON.stringify({
            displayName: "Team gateway",
            type,
            baseUrl: "https://gateway.example.com/v1",
            credentialRef: "env:TEAM_GATEWAY_KEY"
          })
        });
        expect(rejected.statusCode, type).toBe(400);
      }
      const remoteTarget = await app.inject({
        method: "PUT",
        url: "/v1/platform/ai/providers/team-device",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify({
          displayName: "Team device",
          type: "local",
          executionTarget: "remote-inference"
        })
      });
      expect(remoteTarget.statusCode).toBe(400);
      const accepted = await app.inject({
        method: "PUT",
        url: "/v1/platform/ai/providers/team-device",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify({
          displayName: "Team device",
          type: "local",
          executionTarget: "installed-app"
        })
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({
        id: "team-device",
        type: "local",
        executionTarget: "installed-app",
        enabled: true
      });
    } finally {
      await app.close();
    }
  });
});

describe("secret handling", () => {
  it("redacts known and pattern-shaped secrets from text and records", () => {
    const text = `Incorrect API key sk-proj-abcdefgh12345678 and Bearer abc.def.ghi-123456 and hf_abcdefghijk and x-api-key: zzzzzzzz`;
    const redacted = redactSecrets(text, ["zzzzzzzz"]);
    expect(redacted).not.toMatch(/sk-proj|abc\.def|hf_abc|zzzzzzzz/u);
    expect(
      redactRecord({ apiKey: "anything", nested: { note: "token sk-abcdefgh123456" } })
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: { note: "token [REDACTED]" }
    });
  });

  it("keeps secret-shaped text out of failure logs", async () => {
    const logged: unknown[] = [];
    const leaky = failingDeviceProvider("device-a");
    const { platform } = createTestPlatform({
      catalog: [catalogModel({ id: "phi-a", providerId: "device-a" })],
      providers: [localProviderConfig("device-a")],
      devices: {
        "device-a": {
          ...leaky,
          async generate() {
            throw new Error("device said: Bearer sk-leaked-from-device-0000000000");
          }
        }
      },
      options: { log: (event, fields) => logged.push({ event, ...fields }) }
    });
    await platform.refresh();
    const error = await platform.router
      .generate(
        { requestId: "r", modelId: "phi-a", messages: [{ role: "user", content: "hi" }] },
        { agentId: "a", tenantId: "t", userId: "u" }
      )
      .catch((caught: unknown) => caught);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain("sk-leaked-from-device");
    expect(JSON.stringify(error)).not.toContain("sk-leaked-from-device");
  });
});
