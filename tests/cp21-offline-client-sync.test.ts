import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LocalSyncMutation, LocalSyncSnapshot, SyncPullPage } from "@grogoni/shared-types";
import { applySyncPullPage } from "../packages/sync-core/src/index";
import {
  catchUpAccountSync,
  createLocalSyncMutation,
  flushLocalSyncMutations,
  type AccountSyncRepository
} from "../apps/web/src/sync/sync-client";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface SessionResponse {
  account: { id: string };
}

interface ConversationResponse {
  conversation: { id: string };
}

describe("CP21 offline client sync", () => {
  it("pages an account-scoped journal and resumes from an opaque cursor after hydration", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createSession(app, "254700000121");
    const stranger = await createSession(app, "254700000122");
    const businessResponse = await postJson<{ business: { id: string } }>(
      app,
      "/businesses",
      { name: "Phase Two Shop", language: "en" },
      owner.cookie
    );
    const conversation = await postJson<ConversationResponse>(
      app,
      "/v1/conversations",
      { kind: "storefront", activeShopId: businessResponse.business.id },
      owner.cookie
    );
    await postJson(
      app,
      "/v1/messages",
      {
        conversationId: conversation.conversation.id,
        clientMessageId: "phase-two-message-0001",
        content: { type: "text", text: "Sync this message" }
      },
      owner.cookie
    );

    const changes: SyncPullPage["changes"] = [];
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
      const page = await getJson<SyncPullPage>(
        app,
        `/v1/sync/changes?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        owner.cookie
      );
      expect(page.accountId).toBe(owner.accountId);
      expect(page.fromCursor).toBe(cursor);
      changes.push(...page.changes);
      cursor = page.nextCursor;
      hasMore = page.hasMore;
    }

    expect(changes.length).toBeGreaterThanOrEqual(6);
    expect(new Set(changes.map((change) => change.collection))).toEqual(
      new Set(["session_context", "shops", "conversations", "conversation_messages"])
    );
    expect(changes.every((change) => change.accountId === owner.accountId)).toBe(true);
    expect(changes.map((change) => change.sequence)).toEqual(
      [...changes.map((change) => change.sequence)].sort((left, right) => left - right)
    );

    const crossAccountCursor = await app.inject({
      method: "GET",
      url: `/v1/sync/changes?cursor=${encodeURIComponent(changes[0]!.cursor)}`,
      headers: { cookie: stranger.cookie }
    });
    expect(crossAccountCursor.statusCode).toBe(409);
    expect(crossAccountCursor.json().code).toBe("sync_cursor_invalid");

    const snapshot = store.snapshot();
    await app.close();
    const restoredStore = createCp2Store();
    restoredStore.hydrateSnapshot(snapshot);
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    const resumed = await getJson<SyncPullPage>(
      restoredApp,
      `/v1/sync/changes?cursor=${encodeURIComponent(cursor ?? "")}`,
      owner.cookie
    );
    expect(resumed.changes).toEqual([]);
    expect(resumed.nextCursor).toBe(cursor);
    await restoredApp.close();
  });

  it("catches up multiple pages and resets an expired local cursor once", async () => {
    const repository = new MemorySyncRepository("account-1", "expired-cursor");
    const pages = [syncPage(null, "cursor-1", true, 1), syncPage("cursor-1", "cursor-2", false, 2)];
    let requestCount = 0;
    const snapshot = await catchUpAccountSync({
      accountId: "account-1",
      repository,
      fetcher: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ code: "sync_cursor_invalid" }), { status: 409 });
        }
        const page = pages[requestCount - 2];
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(repository.clearCount).toBe(1);
    expect(snapshot.cursor).toBe("cursor-2");
    expect(snapshot.records.map((record) => record.entityId)).toEqual([
      "conversation-1",
      "conversation-2"
    ]);
  });

  it("transfers durable local mutations in order and replays each affected business", async () => {
    const repository = new MemoryMutationRepository([
      createLocalSyncMutation({
        id: "mutation-0001",
        accountId: "account-1",
        actorId: "user-1",
        businessId: "business-1",
        mutationType: "product.create",
        payload: { name: "Offline Rice", buyingPrice: 100, sellingPrice: 140 },
        now: new Date("2026-07-12T12:00:00.000Z")
      }),
      createLocalSyncMutation({
        id: "mutation-0002",
        accountId: "account-1",
        actorId: "user-1",
        businessId: "business-1",
        mutationType: "inventory.adjust",
        payload: { productId: "product-1", quantityAfter: 4 },
        now: new Date("2026-07-12T12:00:01.000Z")
      })
    ]);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await flushLocalSyncMutations({
      accountId: "account-1",
      repository,
      apiBaseUrl: "https://grogoni.com/",
      fetcher: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url, body });
        if (url.endsWith("/replay")) {
          return Response.json({ results: [], summary: {} });
        }
        return Response.json({
          id: `server-${requests.length}`,
          businessId: "business-1",
          idempotencyKey: body.idempotencyKey
        });
      }
    });

    expect(result).toEqual({
      transferred: 2,
      replayedBusinesses: ["business-1"],
      remaining: 0
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://grogoni.com/businesses/business-1/sync-queue",
      "https://grogoni.com/businesses/business-1/sync-queue",
      "https://grogoni.com/businesses/business-1/sync-queue/replay"
    ]);
    expect(requests.slice(0, 2).map((request) => request.body.mutationType)).toEqual([
      "product.create",
      "inventory.adjust"
    ]);
    expect(repository.removed).toEqual(["mutation-0001", "mutation-0002"]);
  });
});

class MemoryMutationRepository {
  readonly removed: string[] = [];

  constructor(private mutations: LocalSyncMutation[]) {}

  async listMutations(accountId: string): Promise<LocalSyncMutation[]> {
    return this.mutations.filter((mutation) => mutation.accountId === accountId);
  }

  async putMutation(mutation: LocalSyncMutation): Promise<void> {
    this.mutations.push(mutation);
  }

  async removeMutation(id: string): Promise<void> {
    this.removed.push(id);
    this.mutations = this.mutations.filter((mutation) => mutation.id !== id);
  }
}

class MemorySyncRepository implements AccountSyncRepository {
  clearCount = 0;
  private snapshot: LocalSyncSnapshot = { accountId: "", cursor: null, records: [] };

  constructor(accountId: string, cursor: string | null) {
    this.snapshot = { accountId, cursor, records: [] };
  }

  async loadSnapshot<T>(accountId: string): Promise<LocalSyncSnapshot<T>> {
    expect(accountId).toBe(this.snapshot.accountId);
    return this.snapshot as LocalSyncSnapshot<T>;
  }

  async applyPullPage<T>(page: SyncPullPage<T>): Promise<LocalSyncSnapshot<T>> {
    this.snapshot = applySyncPullPage(this.snapshot as LocalSyncSnapshot<T>, page);
    return this.snapshot as LocalSyncSnapshot<T>;
  }

  async clearAccount(accountId: string): Promise<void> {
    this.clearCount += 1;
    this.snapshot = { accountId, cursor: null, records: [] };
  }
}

function syncPage(
  fromCursor: string | null,
  nextCursor: string,
  hasMore: boolean,
  sequence: number
): SyncPullPage {
  return {
    accountId: "account-1",
    fromCursor,
    nextCursor,
    hasMore,
    serverTime: "2026-07-12T12:00:00.000Z",
    changes: [
      {
        accountId: "account-1",
        collection: "conversations",
        entityId: `conversation-${sequence}`,
        operation: "upsert",
        sequence,
        cursor: nextCursor,
        shopId: null,
        entity: { id: `conversation-${sequence}` },
        changedAt: "2026-07-12T11:59:00.000Z",
        tombstoneExpiresAt: null
      }
    ]
  };
}

async function createSession(
  app: FastifyInstance,
  destination: string
): Promise<{ accountId: string; cookie: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(response.statusCode).toBe(200);
  const session = response.json<SessionResponse>();
  return { accountId: session.account.id, cookie: extractCookie(response.headers["set-cookie"]) };
}

async function postJson<T = unknown>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function getJson<T>(app: FastifyInstance, url: string, cookie: string): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function extractCookie(value: string | string[] | undefined): string {
  const cookie = Array.isArray(value) ? value[0] : value;
  if (cookie === undefined) {
    throw new Error("Session cookie missing.");
  }
  return cookie.split(";")[0] ?? "";
}
