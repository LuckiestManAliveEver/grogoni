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
      pin: "1234"
    });
    const other = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254712345679",
      pin: "4321"
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
