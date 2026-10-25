import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

vi.mock("../services/api/src/edge-store-dependencies", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeStoreDependencies: () => ({
    platformDefaultRuntime: {
      agentId: "builtin:shopkeeper:v1",
      agentName: "Shopkeeper",
      agentRuntimeAdapterId: "grogoni",
      modelId: "smollm2-360m",
      executionTarget: "local"
    },
    modelRuntimeAdapterResolver: ({ modelId }: { modelId: string }) => ({
      provider: "fixture-deterministic-task",
      executionTarget: "local",
      canRun: async () => ({ available: true, errorCode: null, message: null }),
      healthCheck: async () => ({
        available: true,
        modelId,
        provider: "fixture-deterministic-task",
        executionTarget: "local",
        latencyMs: 1,
        responsePreview: "GROGONI_MODEL_OK",
        errorCode: null,
        message: null,
        retryable: false
      }),
      generate: async () => {
        throw new Error("These turns are deterministic and must not invoke a model.");
      }
    })
  })
}));

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

/**
 * Found by the October 2026 browser journey: on the Edge API, the second agent message in any
 * conversation answered 503. Runtime checkpoint rows (cp2_runtime_handoffs, task heads) carry no
 * tenant columns, so the request's scoped snapshot never loaded them; the second turn saw no
 * checkpoint, bootstrapped version 1 again, and hit cp2_runtime_handoffs_task_version_idx (23505).
 */
describe.skipIf(!databaseUrl)("Edge runtime checkpoints on PostgreSQL", () => {
  it("answers every agent turn in a conversation, writing only its own rows and unused sequences", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    try {
      const store = createCp2Store();
      const baseline = store.snapshot();
      const owner = store.continueWithChannelPin({
        channel: "email",
        destination: `edge-checkpoints-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const ownerShop = store.createBusiness({
        sessionId: owner.session.id,
        name: `Synthetic checkpoints ${randomUUID()}`,
        language: "en",
        phoneNumber: `+25478${Date.now().toString().slice(-7)}`,
        phoneCountry: "KE"
      }).business;
      const businessId = ownerShop.id;
      const conversation = store.createConversation({
        sessionId: owner.session.id,
        kind: "personal",
        activeShopId: businessId
      }).conversation;
      const outsider = store.continueWithChannelPin({
        channel: "email",
        destination: `edge-outsider-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const otherShopId = store.createBusiness({
        sessionId: outsider.session.id,
        name: `Another tenant ${randomUUID()}`,
        language: "en",
        phoneNumber: `+25477${Date.now().toString().slice(-7)}`,
        phoneCountry: "KE"
      }).business.id;
      // A customer's chat with the shop: a conversation the shop owns.
      const storefrontChat = store.createConversation({
        sessionId: outsider.session.id,
        kind: "storefront",
        activeShopId: businessId
      }).conversation;
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      // Another shop has used offline change sequences this owner cannot see. They are unique
      // across every shop, so the owner's writes must allocate past them.
      const highest = await pool.query<{ sequence: string | null }>(
        "select max((record->>'sequence')::bigint) as sequence from cp2_offline_changes"
      );
      const taken = Number(highest.rows[0]?.sequence ?? 0) + 1;
      for (const sequence of [taken, taken + 1, taken + 2])
        await pool.query(
          "insert into cp2_offline_changes (entity_id, business_id, record) values ($1, $2, $3::jsonb)",
          [
            randomUUID(),
            otherShopId,
            JSON.stringify({ id: randomUUID(), businessId: otherShopId, sequence })
          ]
        );
      const edge = await createEdgeDomainRoutes({
        transaction,
        approvalTransaction: transaction
      });
      const send = (text: string) =>
        edge.routes(
          new Request("https://grogoni.com/v1/messages", {
            method: "POST",
            headers: {
              cookie: `grogoni_session=${owner.session.id}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              conversationId: conversation.id,
              clientMessageId: randomUUID(),
              content: { type: "text", text },
              agent: { businessId, message: text }
            })
          }),
          "/v1/messages"
        );
      const messageRows = () =>
        pool.query<{ entity_id: string; record: unknown; updated_at: Date }>(
          "select entity_id, record, updated_at from cp2_conversation_messages where record->>'conversationId' = $1",
          [conversation.id]
        );
      const first = await send("Add 5 bags of sugar to stock");
      expect(first?.status, await first?.clone().text()).toBe(200);
      // The reply runs in the background after the message's request (agent_chat_turns).
      await edge.settled();
      const firstExchange = (await messageRows()).rows;
      expect(firstExchange.length).toBeGreaterThanOrEqual(1);
      // Every existing row's version, across all normalized tables. xmin changes on every write;
      // updated_at printed as a Date keeps whole seconds and missed rewrites in the same second.
      const tables = (
        await pool.query<{ table_name: string }>(
          `select distinct table_name from information_schema.columns
           where table_schema = 'public' and column_name = 'entity_id' and table_name like 'cp2_%'
             and table_name in (select table_name from information_schema.columns
               where table_schema = 'public' and column_name = 'updated_at')`
        )
      ).rows.map((row) => row.table_name);
      const writeTimes = async () => {
        const times = new Map<string, string>();
        for (const table of tables)
          for (const row of (
            await pool.query(`select entity_id, xmin::text as version from ${table}`)
          ).rows)
            times.set(`${table}|${row.entity_id}`, String(row.version));
        return times;
      };
      const beforeSecond = await writeTimes();
      const second = await send("Add 3 bags of rice to stock");
      expect(second?.status, await second?.clone().text()).toBe(200);
      await edge.settled();
      // A send rewrites only rows it really changes: its conversation's latest activity, its
      // agent task head, and the shop's offline change watermark. A row rewritten on every
      // request (notifications re-stamped, messages re-normalized) collides with any concurrent
      // request on the same rows and turns into a 503.
      const writeTimesAfter = await writeTimes();
      const rewritten = new Map<string, number>();
      for (const [key, time] of beforeSecond)
        if (writeTimesAfter.get(key) !== time) {
          const table = key.split("|")[0]!;
          rewritten.set(table, (rewritten.get(table) ?? 0) + 1);
        }
      expect(Object.fromEntries(rewritten)).toEqual({
        cp2_conversations: 1,
        cp2_offline_metadata: 1,
        cp2_runtime_task_heads: 1
      });
      // The second send writes only its own messages. Loading filled defaults into the first
      // exchange's rows; rewriting them each time made a concurrent read marker fail the send.
      const afterSecond = (await messageRows()).rows;
      for (const row of firstExchange)
        expect(afterSecond.find((candidate) => candidate.entity_id === row.entity_id)).toEqual(row);
      const checkpoints = await pool.query<{ checkpoint_version: string }>(
        "select checkpoint_version from cp2_runtime_handoffs where task_id = $1 order by checkpoint_version",
        [conversation.id]
      );
      const versions = checkpoints.rows.map((row) => Number(row.checkpoint_version));
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(new Set(versions).size).toBe(versions.length);

      // Scoped to who can see the conversation: the owner loads them, an outsider does not.
      const loadAs = (sessionId: string | null, path = "/v1/conversations") =>
        transaction(async (client) => {
          const request = new Request(`https://grogoni.com${path}`, {
            headers: sessionId === null ? {} : { cookie: `grogoni_session=${sessionId}` }
          });
          const scope = await createEdgeSnapshotScope(client, request, path);
          return loadTransactionalCp2Snapshot(client, scope);
        });
      const mine = await loadAs(owner.session.id);
      expect(mine.runtimeTaskHeads?.some((head) => head.taskId === conversation.id)).toBe(true);
      expect(
        mine.runtimeHandoffs?.filter((handoff) => handoff.taskId === conversation.id)
      ).toHaveLength(versions.length);
      // Runtime checkpoints (which grow with every agent turn) load only for people who work in
      // the conversation: never for a storefront visitor, and never a stranger's.
      const taskScope = (sessionId: string | null, path: string) =>
        transaction(async (client) => {
          const request = new Request(`https://grogoni.com${path}`, {
            headers: sessionId === null ? {} : { cookie: `grogoni_session=${sessionId}` }
          });
          const scope = await createEdgeSnapshotScope(client, request, path);
          for (const key of [
            "runtimeHandoffs",
            "runtimeTaskHeads",
            "runtimeExecutionEvents"
          ] as const)
            expect(scope.predicate(key)).toContain("edge_task_conversation_ids");
          return (
            await client.query<{ id: string }>(
              `${scope.withClause} select id from edge_task_conversation_ids`
            )
          ).rows.map((row) => row.id);
        });
      const storefrontPath = `/public/storefronts/${encodeURIComponent(ownerShop.grogoniId ?? businessId)}`;
      expect(await taskScope(null, storefrontPath)).toEqual([]);
      const ownerTasks = await taskScope(owner.session.id, "/v1/conversations");
      expect(ownerTasks).toContain(conversation.id);
      expect(ownerTasks).not.toContain(storefrontChat.id);
      const customerTasks = await taskScope(outsider.session.id, "/v1/conversations");
      expect(customerTasks).toContain(storefrontChat.id);
      expect(customerTasks).not.toContain(conversation.id);
      const visitor = await loadAs(
        null,
        `/public/storefronts/${encodeURIComponent(ownerShop.grogoniId ?? businessId)}`
      );
      expect(visitor.runtimeHandoffs?.some((handoff) => handoff.taskId === conversation.id)).toBe(
        false
      );
      expect(visitor.runtimeTaskHeads?.some((head) => head.taskId === conversation.id)).toBe(false);
      const theirs = await loadAs(outsider.session.id);
      expect(theirs.runtimeTaskHeads?.some((head) => head.taskId === conversation.id)).toBe(false);
      expect(theirs.runtimeHandoffs?.some((handoff) => handoff.taskId === conversation.id)).toBe(
        false
      );
    } finally {
      await pool.end();
    }
  }, 60000);

  it("gives two shops writing at the same moment distinct offline change sequences", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    try {
      const store = createCp2Store();
      const baseline = store.snapshot();
      const shops = ["first", "second"].map((label, index) => {
        const owner = store.continueWithChannelPin({
          channel: "email",
          destination: `edge-sequence-${label}-${randomUUID()}@example.invalid`,
          pin: "1234"
        });
        const businessId = store.createBusiness({
          sessionId: owner.session.id,
          name: `Synthetic sequence ${label} ${randomUUID()}`,
          language: "en",
          phoneNumber: `+2547${index}${Date.now().toString().slice(-7)}`,
          phoneCountry: "KE"
        }).business.id;
        return { sessionId: owner.session.id, businessId };
      });
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction, approvalTransaction: transaction });
      const create = (shop: (typeof shops)[number], index: number) =>
        edge.routes(
          new Request(`https://grogoni.com/businesses/${shop.businessId}/products`, {
            method: "POST",
            headers: {
              cookie: `grogoni_session=${shop.sessionId}`,
              "content-type": "application/json",
              origin: "https://grogoni.com"
            },
            body: JSON.stringify({ name: `Product ${index}`, unit: "kg", quantity: 1 })
          }),
          `/businesses/${shop.businessId}/products`
        );
      // Both shops at once: each request sees only its own shop's changes.
      const responses = await Promise.allSettled(
        [0, 1, 2, 3].flatMap((index) => shops.map((shop) => create(shop, index)))
      );
      const failures = responses.flatMap((outcome) =>
        outcome.status === "rejected"
          ? [String((outcome.reason as { code?: string; message?: string }).code ?? outcome.reason)]
          : outcome.value?.status === 200
            ? []
            : [String(outcome.value?.status)]
      );
      expect(failures).toEqual([]);
      const sequences = await pool.query<{ sequence: string }>(
        "select record->>'sequence' as sequence from cp2_offline_changes where business_id = any($1::text[])",
        [shops.map((shop) => shop.businessId)]
      );
      expect(sequences.rows.length).toBeGreaterThanOrEqual(8);
      expect(new Set(sequences.rows.map((row) => row.sequence)).size).toBe(sequences.rows.length);
    } finally {
      await pool.end();
    }
  }, 60000);
});
