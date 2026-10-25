import { signupPhone } from "./fixtures/account-auth";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalRegistryConnection } from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("external registry connections (GitHub / Hugging Face token connect)", () => {
  const previousFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  function mockGitHubValid(scopesHeader = "repo, read:user") {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 42, login: "octocat" }), {
          status: 200,
          headers: { "x-oauth-scopes": scopesHeader }
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  function mockGitHubInvalid() {
    globalThis.fetch = (async () =>
      new Response("Bad credentials", { status: 401 })) as typeof fetch;
  }

  function mockHuggingFaceValid() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://huggingface.co/api/whoami-v2") {
        return new Response(
          JSON.stringify({
            id: "hf-user-1",
            name: "hf-owner",
            auth: { accessToken: { role: "read" } }
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    }) as typeof fetch;
  }

  async function signUp(app: ReturnType<typeof buildApi>, email: string): Promise<string> {
    return (await signupPhone(app, email)).cookie;
  }

  it("connects GitHub with a valid token and never returns the secret in the response", async () => {
    mockGitHubValid();
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const cookie = await signUp(app, "gh-connect@example.test");

    const response = await post(
      app,
      "/v1/external-connections/github",
      { token: "gh_valid_token_abc" },
      cookie
    );
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      provider: "github",
      status: "connected",
      externalAccountId: "42",
      externalUsername: "octocat",
      scopes: ["repo", "read:user"]
    });
    expect(body.encryptedToken).toBeUndefined();
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("gh_valid_token_abc");

    const listed = await get(app, "/v1/external-connections", cookie);
    const connections = listed.json<{ connections: ExternalRegistryConnection[] }>().connections;
    expect(connections).toHaveLength(1);
    expect(JSON.stringify(connections)).not.toContain("gh_valid_token_abc");

    await app.close();
  });

  it("rejects an invalid token (401 from the provider) and stores nothing", async () => {
    mockGitHubInvalid();
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const cookie = await signUp(app, "gh-invalid@example.test");

    const response = await post(
      app,
      "/v1/external-connections/github",
      { token: "gh_bad_token" },
      cookie
    );
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "external_connection_token_invalid" });

    const listed = await get(app, "/v1/external-connections", cookie);
    expect(listed.json<{ connections: ExternalRegistryConnection[] }>().connections).toHaveLength(
      0
    );

    await app.close();
  });

  it("upserts on a second connect for the same account+provider instead of duplicating", async () => {
    mockGitHubValid();
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const cookie = await signUp(app, "gh-reconnect@example.test");

    const first = await post(
      app,
      "/v1/external-connections/github",
      { token: "token-one" },
      cookie
    );
    const firstBody = first.json<ExternalRegistryConnection>();

    mockGitHubValid("repo");
    const second = await post(
      app,
      "/v1/external-connections/github",
      { token: "token-two" },
      cookie
    );
    const secondBody = second.json<ExternalRegistryConnection>();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.scopes).toEqual(["repo"]);

    const listed = await get(app, "/v1/external-connections", cookie);
    expect(listed.json<{ connections: ExternalRegistryConnection[] }>().connections).toHaveLength(
      1
    );

    await app.close();
  });

  it("connects Hugging Face with a valid token, parsing whoami-v2's own metadata", async () => {
    mockHuggingFaceValid();
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const cookie = await signUp(app, "hf-connect@example.test");

    const response = await post(
      app,
      "/v1/external-connections/huggingface",
      { token: "hf_token_xyz" },
      cookie
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "huggingface",
      status: "connected",
      externalAccountId: "hf-user-1",
      externalUsername: "hf-owner",
      scopes: ["read"]
    });

    await app.close();
  });

  it("disconnect actually clears the encrypted token, not just a status flag", async () => {
    mockGitHubValid();
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await signUp(app, "gh-disconnect@example.test");

    const connected = await post(
      app,
      "/v1/external-connections/github",
      { token: "will-be-revoked" },
      cookie
    );
    const body = connected.json<ExternalRegistryConnection>();
    expect(store.resolveExternalConnectionToken(body.accountId, "github")).toBe("will-be-revoked");

    const disconnected = await del(app, `/v1/external-connections/${body.id}`, cookie);
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toMatchObject({ disconnected: true, id: body.id });

    // The credential is gone server-side, not merely hidden behind a status flag.
    expect(store.resolveExternalConnectionToken(body.accountId, "github")).toBeNull();

    const listed = await get(app, "/v1/external-connections", cookie);
    const [connection] = listed.json<{ connections: ExternalRegistryConnection[] }>().connections;
    expect(connection?.status).toBe("revoked");

    await app.close();
  });

  it("rejects disconnecting a connection that belongs to a different account", async () => {
    mockGitHubValid();
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const ownerCookie = await signUp(app, "gh-owner@example.test");
    const connected = await post(
      app,
      "/v1/external-connections/github",
      { token: "owner-token" },
      ownerCookie
    );
    const { id } = connected.json<ExternalRegistryConnection>();

    const otherCookie = await signUp(app, "gh-other@example.test");
    const attempt = await del(app, `/v1/external-connections/${id}`, otherCookie);
    expect(attempt.statusCode).toBe(404);

    const listed = await get(app, "/v1/external-connections", ownerCookie);
    expect(
      listed.json<{ connections: ExternalRegistryConnection[] }>().connections[0]?.status
    ).toBe("connected");

    await app.close();
  });

  it("rejects unauthenticated requests on every route", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });

    expect((await app.inject({ method: "GET", url: "/v1/external-connections" })).statusCode).toBe(
      401
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/external-connections/github",
          headers: { "content-type": "application/json" },
          payload: { token: "x" }
        })
      ).statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: "DELETE", url: "/v1/external-connections/some-id" })).statusCode
    ).toBe(401);

    await app.close();
  });

  it("keeps a connection discovery-only: inference billing authorization was removed", async () => {
    // Billing hosted inference to a user's own Hugging Face account was removed with the
    // local-first runtime (docs/local-first-cloud-audit.md). Connecting still serves discovery.
    mockHuggingFaceValid();
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await signUp(app, "hf-discovery-only@example.test");

    const connected = await post(
      app,
      "/v1/external-connections/huggingface",
      { token: "hf_token_discovery" },
      cookie
    );
    expect(connected.statusCode).toBe(200);
    const body = connected.json<ExternalRegistryConnection & Record<string, unknown>>();
    expect(body).not.toHaveProperty("inferenceAuthorized");
    expect(store.resolveExternalConnectionToken(body.accountId, "huggingface")).toBe(
      "hf_token_discovery"
    );

    const authorize = await post(
      app,
      `/v1/external-connections/${body.id}/inference-authorization`,
      { authorized: true },
      cookie
    );
    expect(authorize.statusCode).toBe(404);

    await app.close();
  });

  it("rejects an unsupported provider", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const cookie = await signUp(app, "gh-badprovider@example.test");

    const response = await post(app, "/v1/external-connections/bitbucket", { token: "x" }, cookie);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "external_connection_provider_invalid" });

    await app.close();
  });
});

function post(app: ReturnType<typeof buildApi>, url: string, payload: unknown, cookie?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload
  });
}

function get(app: ReturnType<typeof buildApi>, url: string, cookie: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

function del(app: ReturnType<typeof buildApi>, url: string, cookie: string) {
  return app.inject({ method: "DELETE", url, headers: { cookie } });
}
