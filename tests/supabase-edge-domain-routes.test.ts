import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

const state = vi.hoisted(() => ({
  snapshot: undefined as Cp2Snapshot | undefined,
  saves: 0,
  protocol: null as unknown
}));
vi.mock("../services/api/src/cp2/postgres-store", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    loadTransactionalCp2Snapshot: async () => structuredClone(state.snapshot),
    saveTransactionalCp2Snapshot: async (_client: unknown, snapshot: Cp2Snapshot) => {
      state.snapshot = structuredClone(snapshot);
      state.saves++;
    }
  };
});

describe("Edge shared user and business routes", () => {
  beforeEach(() => {
    state.snapshot = createCp2Store().snapshot();
    state.saves = 0;
    state.protocol = null;
  });
  async function setup() {
    const store = createCp2Store();
    const owner = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254712345678",
      pin: "3927"
    });
    const other = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254712345679",
      pin: "6180"
    });
    state.snapshot = store.snapshot();
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.startsWith("select record from cp2_edge_protocol_state"))
          return { rows: state.protocol ? [{ record: state.protocol }] : [], rowCount: 0 };
        if (sql.startsWith("insert into cp2_edge_protocol_state"))
          state.protocol = JSON.parse(String(values![0]));
        return { rows: [], rowCount: 0 };
      })
    } as unknown as PoolClient;
    const domain = await createEdgeDomainRoutes({ transaction: async (action) => action(client) });
    const call = (
      path: string,
      cookie = owner.session.id,
      method = "GET",
      body?: unknown,
      headers: Record<string, string> = {}
    ) =>
      domain.routes(
        new Request(`https://example.com${path}`, {
          method,
          headers: {
            cookie: `grogoni_session=${cookie}`,
            "content-type": "application/json",
            origin: "https://grogoni.com",
            ...headers
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        path.split("?")[0]
      );
    return { ...domain, call, owner, other, client };
  }
  it("registers the complete domain inventory, including shops, products, staff, and security", async () => {
    const { inventory } = await setup();
    for (const path of [
      "/businesses",
      "/v1/shops",
      "/businesses/:businessId/products",
      "/auth/mfa/totp/setup"
    ])
      expect(
        inventory.some((route) => route.path === path),
        path
      ).toBe(true);
    expect(inventory.length).toBeGreaterThan(200);
  });
  it("persists a new business across requests and denies another account product access", async () => {
    const { call, other } = await setup();
    const created = await call("/businesses", undefined, "POST", {
      name: "Edge shop",
      language: "en"
    });
    expect(created!.status).toBe(200);
    const business = (await created!.json()).business;
    expect(state.snapshot!.businesses).toHaveLength(1);
    const shops = await call("/v1/shops");
    expect(shops!.status).toBe(200);
    expect(JSON.stringify(await shops!.json())).toContain(business.id);
    const denied = await call(`/businesses/${business.id}/products`, other.session.id);
    expect([403, 404]).toContain(denied!.status);
  });
  it("authenticates image reading in a short lookup and performs model inference without snapshot locks", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    let lookupOpen = false;
    const transaction = vi.fn(async () => {
      throw new Error("Image inference must not open a snapshot transaction");
    });
    const findUser = vi.fn(async () => {
      lookupOpen = true;
      await Promise.resolve();
      lookupOpen = false;
      return { userId: "owner" };
    });
    const fetch = vi.fn(async () => {
      expect(lookupOpen).toBe(false);
      return Response.json({
        model: "openai/gpt-6-luna",
        choices: [
          {
            message: { content: JSON.stringify({ type: "response", message: "Receipt total 570" }) }
          }
        ]
      });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const { routes } = await createEdgeDomainRoutes({
        transaction,
        daemon: { queue: {} as never, hint: null, findUser }
      });
      const path = "/v1/chat/images/read";
      const response = await routes(
        new Request(`https://grogoni.com${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "grogoni_session=test" },
          body: JSON.stringify({
            fileName: "receipt.png",
            contentType: "image/png",
            contentBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64")
          })
        }),
        path
      );
      expect(response!.status).toBe(200);
      expect(findUser).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("serves guest voice from one capability lookup, with no snapshot transaction", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const { createHash } = await import("node:crypto");
    const transaction = vi.fn(async () => {
      throw new Error("Guest voice must not open a snapshot transaction");
    });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const capabilities: Record<string, Record<string, unknown>> = {
      [createHash("sha256").update("guest-token").digest("hex")]: {
        id: "cap-1",
        revokedAt: null,
        expiresAt: future
      },
      [createHash("sha256").update("revoked-token").digest("hex")]: {
        id: "cap-2",
        revokedAt: "2026-11-01T00:00:00.000Z",
        expiresAt: future
      },
      [createHash("sha256").update("expired-token").digest("hex")]: {
        id: "cap-3",
        revokedAt: null,
        expiresAt: "2026-01-01T00:00:00.000Z"
      }
    };
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      expect(sql).toContain("customer_runtime_capabilities");
      const record = capabilities[String(values[0])];
      return { rows: record ? [{ record }] : [] };
    });
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([0x49, 0x44, 0x33, 4]), {
          headers: { "content-type": "audio/mpeg" }
        })
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const { routes } = await createEdgeDomainRoutes({
        transaction,
        daemon: { queue: { query } as never, hint: null, findUser: vi.fn(async () => null) }
      });
      const path = "/public/storefronts/mama-mboga/voice/speak";
      const say = (capabilityToken: string) =>
        routes(
          new Request(`https://grogoni.com${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ capabilityToken, text: "Karibu." })
          }),
          path
        );
      expect((await say("guest-token"))!.status).toBe(200);
      for (const token of ["revoked-token", "expired-token", "unknown-token"])
        expect((await say(token))!.status).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("serves voice transcription and speech without a snapshot transaction, signed-in only", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const transaction = vi.fn(async () => {
      throw new Error("Voice must not open a snapshot transaction");
    });
    let signedIn = true;
    const findUser = vi.fn(async () => (signedIn ? { userId: "owner" } : null));
    const fetch = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/audio/transcriptions")
        ? Response.json({ text: "two crates of soda" })
        : new Response(new Uint8Array([0x49, 0x44, 0x33, 4]), {
            headers: { "content-type": "audio/mpeg" }
          })
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const { routes } = await createEdgeDomainRoutes({
        transaction,
        daemon: { queue: {} as never, hint: null, findUser }
      });
      const post = (path: string, body: unknown) =>
        routes(
          new Request(`https://grogoni.com${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: "grogoni_session=test" },
            body: JSON.stringify(body)
          }),
          path
        );
      const lines = vi.spyOn(console, "log").mockImplementation(() => {});
      const heard = await post("/v1/voice/transcribe", {
        audioBase64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString("base64"),
        contentType: "audio/webm"
      });
      expect(heard!.status).toBe(200);
      expect(await heard!.json()).toEqual({
        text: "two crates of soda",
        model: "openai/gpt-4o-transcribe"
      });
      // One redacted trace line on Edge too: model and sizes, never the words or the account.
      const traced = lines.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"voice.transcribed"'));
      expect(traced).toHaveLength(1);
      expect(JSON.parse(traced[0]!)).toMatchObject({
        event: "voice.transcribed",
        model: "openai/gpt-4o-transcribe",
        format: "webm",
        audioBytes: 4,
        transcriptChars: 18
      });
      expect(traced[0]).not.toContain("crates");
      expect(traced[0]).not.toContain("owner");
      lines.mockRestore();
      const spoken = await post("/v1/voice/speak", { text: "Your order is ready." });
      expect(spoken!.status).toBe(200);
      expect((await spoken!.json()).audioBase64).toBe(
        Buffer.from([0x49, 0x44, 0x33, 4]).toString("base64")
      );
      const invalid = await post("/v1/voice/transcribe", {
        audioBase64: "AAAA",
        contentType: "video/mp4"
      });
      expect(invalid!.status).toBe(400);
      expect((await invalid!.json()).code).toBe("voice_audio_unsupported");
      signedIn = false;
      expect((await post("/v1/voice/speak", { text: "Hello." }))!.status).toBe(401);
      expect(
        (await post("/v1/voice/transcribe", { audioBase64: "AAAA", contentType: "audio/webm" }))!
          .status
      ).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
  it("coordinates GET handlers before loading a snapshot because session maintenance can write", async () => {
    const { call, client } = await setup();
    expect((await call("/v1/shops"))!.status).toBe(200);
    const statements = vi.mocked(client.query).mock.calls.map((call) => String(call[0]));
    expect(
      statements.some(
        (sql) => sql.includes("edge:business:") && sql.includes("pg_advisory_xact_lock")
      )
    ).toBe(true);
  });
  it("does not open a database transaction for an unknown route", async () => {
    const transaction = vi.fn();
    const { routes } = await createEdgeDomainRoutes({ transaction });
    expect(await routes(new Request("https://example.com/unknown"), "/unknown")).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("persists OAuth state created by anonymous GET starts", async () => {
    vi.stubEnv("OAUTH_GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("OAUTH_GOOGLE_ENABLED", "true");
    vi.stubEnv("OAUTH_GOOGLE_CLIENT_SECRET", "test-secret");
    try {
      const { call } = await setup();
      const response = await call("/auth/oauth/google/start", "");
      expect(response!.status).toBe(200);
      const body = await response!.json();
      expect(body.state).toBeTruthy();
      expect(state.snapshot!.oauthSessions).toHaveLength(1);
      const restored = createCp2Store();
      restored.hydrateSnapshot(state.snapshot!);
      expect(
        restored.getOAuthExchangeData({
          provider: "google",
          state: body.state,
          csrfToken: body.csrfToken
        }).codeVerifier
      ).toBeTruthy();
      expect(state.saves).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("authorizes SSE previews and allows cancellation without holding a DB transaction", async () => {
    const { call } = await setup();
    const path = "/v1/ai/turn-stream/00000000-0000-4000-8000-000000000001";
    const denied = await call(path, "invalid-session");
    expect(denied!.status).toBe(401);
    const response = await call(path);
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/event-stream");
    const reader = response!.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
    await reader.cancel();
  });
  it("persists MCP sessions across separate request handlers", async () => {
    const { call } = await setup();
    const tokenResponse = await call("/v1/mcp/tokens", undefined, "POST", {
      name: "Edge test",
      scopes: ["mcp:read"],
      shopId: null
    });
    expect(tokenResponse!.status).toBe(200);
    const { accessToken } = await tokenResponse!.json();
    const initialized = await call(
      "/mcp",
      undefined,
      "POST",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" }
        }
      },
      { authorization: `Bearer ${accessToken}` }
    );
    expect(initialized!.status).toBe(200);
    const sessionId = initialized!.headers.get("mcp-session-id")!;
    expect(sessionId).toBeTruthy();
    const next = await call(
      "/mcp",
      undefined,
      "POST",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { authorization: `Bearer ${accessToken}`, "mcp-session-id": sessionId }
    );
    expect(next!.status).toBe(200);
    expect(await next!.json()).toMatchObject({ result: { tools: expect.any(Array) } });
  });
});
