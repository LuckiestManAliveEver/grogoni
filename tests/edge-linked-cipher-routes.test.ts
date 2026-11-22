import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cp2Store, createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

// With WHATSAPP_LINKED_SESSION_KEY set, every Edge request's store must get the linked-WhatsApp
// attachment cipher exactly once: shared-app (API) requests and MCP/OAuth requests, which build
// their own app. Registering it twice threw, failing every MCP and OAuth request with a 500.
const state = vi.hoisted(() => ({ snapshot: undefined as unknown }));
vi.mock("../services/api/src/cp2/postgres-store", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    loadTransactionalCp2Snapshot: async () => structuredClone(state.snapshot),
    saveTransactionalCp2Snapshot: async () => undefined
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("linked WhatsApp cipher on Edge requests", () => {
  it("registers the cipher once per request on API and on MCP/OAuth paths", async () => {
    vi.stubEnv("WHATSAPP_LINKED_SESSION_KEY", "a".repeat(64));
    const seed = createCp2Store();
    const actor = seed.continueWithChannelPin({
      channel: "phone",
      destination: "+254712345679",
      pin: "3927"
    });
    state.snapshot = seed.snapshot() as Cp2Snapshot;
    const registered = vi.spyOn(Cp2Store.prototype, "registerConversationAttachmentCipher");
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const domain = await createEdgeDomainRoutes({
      transaction: async (action) => action(client as unknown as PoolClient)
    });

    const api = await domain.routes(
      new Request("https://grogoni.com/v1/conversations", {
        headers: { cookie: `grogoni_session=${actor.session.id}` }
      }),
      "/v1/conversations"
    );
    expect(api?.status, await api?.clone().text()).toBe(200);
    expect(registered.mock.calls.map(([prefix]) => prefix)).toEqual(["encrypted/whatsapp-linked/"]);

    registered.mockClear();
    const discovery = await domain.routes(
      new Request("https://grogoni.com/.well-known/oauth-authorization-server"),
      "/.well-known/oauth-authorization-server"
    );
    expect(discovery?.status, await discovery?.clone().text()).toBe(200);
    expect(registered.mock.calls.map(([prefix]) => prefix)).toEqual(["encrypted/whatsapp-linked/"]);
  }, 60_000);
});
