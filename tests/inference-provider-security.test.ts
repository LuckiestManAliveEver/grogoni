import { inspect } from "node:util";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  isBlockedAddress,
  strictEndpointPolicy,
  validateProviderEndpoint
} from "../services/api/src/inference/providers/endpoint-policy";
import { InferenceError } from "../services/api/src/inference/providers/errors";
import {
  createPinnedLookup,
  transportFromFetch,
  type AddressResolver
} from "../services/api/src/inference/providers/http-transport";
import { redactRecord, redactSecrets } from "../services/api/src/inference/providers/redaction";
import { SecretValue } from "../services/api/src/inference/providers/secret-value";
import {
  catalogModel,
  createTestPlatform,
  jsonResponse,
  openAiCompletion,
  scriptedFetch,
  testSecrets
} from "./fixtures/inference-provider-fakes";

describe("provider endpoint SSRF policy", () => {
  it.each([
    "http://api.example.com/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://127.1.2.3/v1",
    "https://10.0.0.5/v1",
    "https://172.16.4.4/v1",
    "https://192.168.1.1/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/v1",
    "https://0.0.0.0/v1",
    "https://[::1]/v1",
    "https://[fd00::1]/v1",
    "https://[fe80::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://[::ffff:a9fe:a9fe]/v1",
    "https://2130706433/v1",
    "https://0x7f000001/v1",
    "https://metadata.google.internal/computeMetadata/v1",
    "https://service.internal/v1",
    "https://printer.local/v1",
    "https://kubernetes.default.svc/v1",
    "https://intranet/v1",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com:22/v1",
    "https://api.example.com:6379/v1",
    "https://api.example.com/v1?redirect=http://127.0.0.1",
    "ftp://api.example.com/v1",
    "file:///etc/passwd",
    "not a url"
  ])("rejects %s", (url) => {
    expect(() => validateProviderEndpoint(url, strictEndpointPolicy)).toThrow(InferenceError);
  });

  it("accepts ordinary public HTTPS endpoints", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://api.z.ai/api/paas/v4",
      "https://inference.grogoni.com/v1",
      "https://gateway.example.com:8443/openai/v1"
    ]) {
      expect(validateProviderEndpoint(url, strictEndpointPolicy).protocol).toBe("https:");
    }
  });

  it("lets only an operator-configured provider opt into a private network", () => {
    expect(() =>
      validateProviderEndpoint("http://10.0.0.8:8080/v1", {
        allowHttp: true,
        allowPrivateNetwork: true
      })
    ).not.toThrow();
  });

  it("classifies addresses the way the DNS pin uses them", () => {
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:10.1.1.1")).toBe(true);
    expect(isBlockedAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
  });

  it("rejects hostnames that resolve to private addresses at connect time (DNS rebinding)", async () => {
    const resolver =
      (addresses: LookupAddress[]): AddressResolver =>
      (_host, callback) =>
        callback(null, addresses);
    const lookup = (addresses: LookupAddress[]) =>
      new Promise<unknown>((resolve) => {
        createPinnedLookup(strictEndpointPolicy, resolver(addresses))(
          "rebind.example.com",
          { all: true },
          (error, result) => resolve(error ?? result)
        );
      });
    expect(await lookup([{ address: "93.184.216.34", family: 4 }])).toEqual([
      { address: "93.184.216.34", family: 4 }
    ]);
    expect(await lookup([{ address: "169.254.169.254", family: 4 }])).toBeInstanceOf(
      InferenceError
    );
    // One private answer among public ones is enough to refuse the connection.
    expect(
      await lookup([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ])
    ).toBeInstanceOf(InferenceError);
  });

  it("never follows redirects, so a public endpoint cannot bounce a request inward", async () => {
    const { fetch, requests } = scriptedFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" }
        })
    );
    const transport = transportFromFetch(fetch, strictEndpointPolicy);
    await expect(
      transport(new URL("https://api.example.com/v1/chat/completions"), {
        method: "POST",
        headers: {},
        body: "{}"
      })
    ).rejects.toMatchObject({ code: "ENDPOINT_FORBIDDEN" });
    expect(requests).toHaveLength(1);
  });

  it("blocks custom BYOK endpoints that point inward, even for an allowed provider", async () => {
    const { fetch, requests } = scriptedFetch(() => jsonResponse({ data: [] }));
    const { platform } = createTestPlatform({ catalog: [], fetch });
    // Operators may allow per-credential endpoints on a compatible provider; users still cannot aim them inward.
    const llama = platform.registry.get("grogoni-llama")!;
    Object.assign(llama.config, { byokAllowed: true, allowCredentialEndpoint: true });
    for (const baseUrl of [
      "https://169.254.169.254/v1",
      "http://gateway.example.com/v1",
      "https://localhost:8080/v1"
    ]) {
      await expect(
        platform.connections.connect({
          scope: "user",
          tenantId: null,
          userId: "account-a",
          actorId: "user-a",
          providerId: "grogoni-llama",
          apiKey: "custom-endpoint-key-0000000000",
          baseUrl
        })
      ).rejects.toMatchObject({ code: "inference_custom_endpoint_forbidden" });
    }
    expect(requests).toHaveLength(0);
  });
});

describe("secret handling", () => {
  it("SecretValue never serializes its value", () => {
    const secret = new SecretValue("sk-live-should-never-print-000000000000");
    expect(String(secret)).toBe("[REDACTED]");
    expect(`${secret}`).toBe("[REDACTED]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}');
    expect(inspect({ secret })).not.toContain("sk-live");
    expect(secret.reveal()).toBe("sk-live-should-never-print-000000000000");
    expect(secret.suffix()).toBe("0000");
    expect(new SecretValue("short").suffix()).toBeNull();
  });

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

  it("keeps provider credentials out of failure logs", async () => {
    const logged: unknown[] = [];
    const { fetch } = scriptedFetch(() =>
      jsonResponse({ error: { message: `Invalid key ${testSecrets.openai}` } }, 500)
    );
    const { platform } = createTestPlatform({
      catalog: [catalogModel({ id: "gpt-test", providerId: "openai", providerModelId: "gpt" })],
      fetch,
      options: { log: (event, fields) => logged.push({ event, ...fields }) }
    });
    const error = await platform.router
      .generate(
        { requestId: "r", modelId: "gpt-test", messages: [{ role: "user", content: "hi" }] },
        { agentId: "a", tenantId: "t", userId: "u" }
      )
      .catch((caught: unknown) => caught);
    expect(JSON.stringify(logged)).not.toContain(testSecrets.openai);
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(error)).not.toContain(testSecrets.openai);
    expect((error as InferenceError).message).not.toContain(testSecrets.openai);
  });
});

describe("AI provider API: leakage and tenant isolation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function jsonHeaders(cookie?: string) {
    return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
  }

  async function owner(app: ReturnType<typeof buildApi>, contact: string, name: string) {
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
    });
    expect(signup.statusCode).toBe(200);
    const setCookie = signup.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] as string;
    const business = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: jsonHeaders(cookie),
      payload: JSON.stringify({ name, language: "en" })
    });
    expect(business.statusCode).toBe(200);
    return { cookie, businessId: business.json<{ business: { id: string } }>().business.id };
  }

  function appWithPlatform() {
    const { fetch } = scriptedFetch((recorded) =>
      recorded.method === "GET"
        ? jsonResponse({ data: [] })
        : jsonResponse(openAiCompletion({ content: "ok" }))
    );
    const { platform } = createTestPlatform({ catalog: [], fetch });
    const store = createCp2Store({ inferencePlatform: platform });
    return { app: buildApi({ cp2: { store } }), platform };
  }

  it("never returns API keys or ciphertext from any provider endpoint", async () => {
    const { app } = appWithPlatform();
    try {
      const shop = await owner(app, "+254700007101", "Key Shop");
      const apiKey = "sk-route-level-secret-0000000000000KEYS";
      const connected = await app.inject({
        method: "POST",
        url: "/v1/ai/provider-connections",
        headers: jsonHeaders(shop.cookie),
        payload: JSON.stringify({
          providerId: "openai",
          apiKey,
          scope: "tenant",
          businessId: shop.businessId
        })
      });
      expect(connected.statusCode).toBe(200);
      const connection = connected.json<{ id: string; secretHint: string; connected: boolean }>();
      expect(connection).toMatchObject({ connected: true, secretHint: "KEYS", scope: "tenant" });

      const responses = [
        connected,
        await app.inject({
          method: "GET",
          url: "/v1/ai/providers",
          headers: { cookie: shop.cookie }
        }),
        await app.inject({
          method: "GET",
          url: `/v1/ai/provider-connections?businessId=${shop.businessId}`,
          headers: { cookie: shop.cookie }
        }),
        await app.inject({
          method: "POST",
          url: `/v1/ai/provider-connections/${connection.id}/test`,
          headers: { cookie: shop.cookie }
        }),
        await app.inject({ method: "GET", url: "/v1/ai/models", headers: { cookie: shop.cookie } })
      ];
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(apiKey);
        expect(response.body).not.toMatch(/v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:/u);
        expect(response.body).not.toContain(testSecrets.openai);
        expect(response.body).not.toContain("encryptedSecret");
      }
      const providers = responses[1]!.json<{
        providers: Array<{ id: string; managedCredentialConfigured: boolean }>;
      }>();
      expect(providers.providers.find((provider) => provider.id === "openai")).toMatchObject({
        managedCredentialConfigured: true
      });
    } finally {
      await app.close();
    }
  });

  it("stops tenant A from reading, testing, or deleting tenant B's connection", async () => {
    const { app } = appWithPlatform();
    try {
      const shopA = await owner(app, "+254700007102", "Shop A");
      const shopB = await owner(app, "+254700007103", "Shop B");
      const created = await app.inject({
        method: "POST",
        url: "/v1/ai/provider-connections",
        headers: jsonHeaders(shopB.cookie),
        payload: JSON.stringify({
          providerId: "anthropic",
          apiKey: "sk-ant-shop-b-000000000000000000BBBB",
          scope: "tenant",
          businessId: shopB.businessId
        })
      });
      expect(created.statusCode).toBe(200);
      const idB = created.json<{ id: string }>().id;

      const listAsA = await app.inject({
        method: "GET",
        url: `/v1/ai/provider-connections?businessId=${shopB.businessId}`,
        headers: { cookie: shopA.cookie }
      });
      expect([403, 404]).toContain(listAsA.statusCode);
      const ownList = await app.inject({
        method: "GET",
        url: "/v1/ai/provider-connections",
        headers: { cookie: shopA.cookie }
      });
      expect(ownList.json<{ connections: unknown[] }>().connections).toEqual([]);

      const testAsA = await app.inject({
        method: "POST",
        url: `/v1/ai/provider-connections/${idB}/test`,
        headers: { cookie: shopA.cookie }
      });
      expect(testAsA.statusCode).toBe(404);
      const deleteAsA = await app.inject({
        method: "DELETE",
        url: `/v1/ai/provider-connections/${idB}`,
        headers: { cookie: shopA.cookie }
      });
      expect(deleteAsA.statusCode).toBe(404);

      const connectIntoB = await app.inject({
        method: "POST",
        url: "/v1/ai/provider-connections",
        headers: jsonHeaders(shopA.cookie),
        payload: JSON.stringify({
          providerId: "openai",
          apiKey: "sk-injected-into-b-000000000000",
          scope: "tenant",
          businessId: shopB.businessId
        })
      });
      expect([403, 404]).toContain(connectIntoB.statusCode);

      const stillThere = await app.inject({
        method: "GET",
        url: `/v1/ai/provider-connections?businessId=${shopB.businessId}`,
        headers: { cookie: shopB.cookie }
      });
      expect(
        stillThere.json<{ connections: Array<{ id: string; connected: boolean }> }>().connections
      ).toEqual([expect.objectContaining({ id: idB, connected: true })]);
    } finally {
      await app.close();
    }
  });

  it("requires a session and rejects unknown providers and the device-local provider", async () => {
    const { app } = appWithPlatform();
    try {
      const anonymous = await app.inject({ method: "GET", url: "/v1/ai/provider-connections" });
      expect(anonymous.statusCode).toBe(401);
      const shop = await owner(app, "+254700007104", "Validation Shop");
      for (const providerId of ["no-such-provider", "local"]) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/ai/provider-connections",
          headers: jsonHeaders(shop.cookie),
          payload: JSON.stringify({ providerId, apiKey: "sk-whatever-000000000000000000" })
        });
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });
});
