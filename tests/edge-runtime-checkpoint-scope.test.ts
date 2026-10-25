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
import {
  prunableRuntimeCheckpoints,
  runtimeCheckpointRecentVersions
} from "../services/api/src/cp2/domains/runtime-handoff/checkpoint-retention";
import { readFile } from "node:fs/promises";
import type { RuntimeHandoff } from "@grogoni/shared-types";

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

  /** One owner, one shop, one conversation with one agent turn, on its own pool. */
  async function ownerConversation(label: string) {
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
    const store = createCp2Store();
    const baseline = store.snapshot();
    const owner = store.continueWithChannelPin({
      channel: "email",
      destination: `edge-${label}-${randomUUID()}@example.invalid`,
      pin: "1234"
    });
    const businessId = store.createBusiness({
      sessionId: owner.session.id,
      name: `Synthetic ${label} ${randomUUID()}`,
      language: "en",
      phoneNumber: `+25479${Date.now().toString().slice(-7)}`,
      phoneCountry: "KE"
    }).business.id;
    const conversation = store.createConversation({
      sessionId: owner.session.id,
      kind: "personal",
      activeShopId: businessId
    }).conversation;
    const outsider = store.continueWithChannelPin({
      channel: "email",
      destination: `edge-${label}-outsider-${randomUUID()}@example.invalid`,
      pin: "1234"
    });
    await transaction((client) => saveTransactionalCp2Snapshot(client, store.snapshot(), baseline));
    const edge = await createEdgeDomainRoutes({ transaction, approvalTransaction: transaction });
    const call = (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
      sessionId = owner.session.id
    ) =>
      edge.routes(
        new Request(`https://grogoni.com${path}`, {
          method,
          headers: {
            cookie: `grogoni_session=${sessionId}`,
            origin: "https://grogoni.com",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        path.split("?")[0]!
      );
    const send = async (text: string) => {
      const response = await call("POST", "/v1/messages", {
        conversationId: conversation.id,
        clientMessageId: randomUUID(),
        content: { type: "text", text },
        agent: { businessId, message: text }
      });
      expect(response?.status, await response?.clone().text()).toBe(200);
    };
    const loadAs = (sessionId: string, path = "/v1/conversations") =>
      transaction(async (client) => {
        const request = new Request(`https://grogoni.com${path}`, {
          headers: { cookie: `grogoni_session=${sessionId}` }
        });
        const scope = await createEdgeSnapshotScope(client, request, path);
        return loadTransactionalCp2Snapshot(client, scope);
      });
    const stored = async () =>
      (
        await pool.query<{ record: RuntimeHandoff }>(
          "select record from cp2_runtime_handoffs where task_id = $1 order by checkpoint_version",
          [conversation.id]
        )
      ).rows.map((row) => row.record);
    await send("Add 5 bags of sugar to stock");
    return { pool, call, send, loadAs, stored, owner, outsider, conversation, transaction };
  }

  it("prunes superseded checkpoints on write and loads only the ones a reader can still need", async () => {
    const { pool, call, send, loadAs, stored, owner, conversation } =
      await ownerConversation("retention");
    try {
      // A backlog from before pruning, written straight to the table: versions up to 60 in one
      // chain written two months ago, a branch (version 10, from version 5, never promoted, not
      // merged yet) and the task instance on version 7.
      const [first] = await stored();
      expect(first).toBeDefined();
      const base = (await stored()).at(-1)!;
      const byVersion = new Map<number, RuntimeHandoff>(
        (await stored()).map((handoff) => [handoff.checkpointVersion!, handoff])
      );
      const startVersion = base.checkpointVersion! + 1;
      for (let version = startVersion; version <= 60; version += 1) {
        const parent =
          version === 10 ? byVersion.get(5)! : byVersion.get(version === 11 ? 9 : version - 1)!;
        const handoff: RuntimeHandoff = {
          ...base,
          id: randomUUID(),
          parentHandoffId: parent.id,
          checkpointVersion: version,
          currentState: `Backlog checkpoint ${version}.`,
          createdAt: new Date(Date.now() - 60 * 86_400_000 + version * 1000).toISOString(),
          ...(version === 10 ? { branchedAt: new Date().toISOString() } : {})
        };
        byVersion.set(version, handoff);
        await pool.query(
          "insert into cp2_runtime_handoffs (entity_id, record) values ($1, $2::jsonb)",
          [handoff.id, JSON.stringify(handoff)]
        );
      }
      const head = byVersion.get(60)!;
      await pool.query(
        "update cp2_runtime_task_heads set record = record || $2::jsonb where entity_id = $1",
        [conversation.id, JSON.stringify({ activeHandoffId: head.id, nextCheckpointVersion: 61 })]
      );
      await pool.query(
        `insert into cp2_runtime_task_instances (entity_id, record) values ($1, $2::jsonb)
         on conflict (entity_id) do update set record = excluded.record`,
        [
          conversation.id,
          JSON.stringify({
            taskId: conversation.id,
            activeHandoffId: byVersion.get(7)!.id,
            status: "READY",
            ...base.runtime,
            lastError: null,
            updatedAt: new Date().toISOString(),
            fenceToken: 0,
            executionId: `legacy:${conversation.id}`
          })
        ]
      );
      const versionsOf = (handoffs: readonly RuntimeHandoff[] | undefined) =>
        (handoffs ?? [])
          .filter((handoff) => handoff.taskId === conversation.id)
          .map((handoff) => handoff.checkpointVersion!)
          .sort((left, right) => left - right);
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_value, index) => from + index);
      expect(versionsOf(await stored())).toEqual(range(1, 60));

      // A member's request loads only what a reader can still need: the latest 20 versions
      // (head included), the instance's checkpoint, and the unmerged branch with the checkpoint
      // it started from. Not the other 36.
      expect(runtimeCheckpointRecentVersions).toBe(20);
      expect(versionsOf((await loadAs(owner.session.id)).runtimeHandoffs)).toEqual([
        5,
        7,
        10,
        ...range(41, 60)
      ]);

      // The next turn adds version 61 and deletes everything superseded, backlog included.
      await send("Add 3 bags of rice to stock");
      expect(versionsOf(await stored())).toEqual([5, 7, 10, ...range(42, 61)]);
      // The in-memory rule and the SQL rule agree: nothing stored is prunable, all of it loads.
      const all = await stored();
      const heads = await pool.query(
        "select record from cp2_runtime_task_heads where entity_id = $1",
        [conversation.id]
      );
      const instances = await pool.query(
        "select record from cp2_runtime_task_instances where entity_id = $1",
        [conversation.id]
      );
      expect(
        prunableRuntimeCheckpoints(
          {
            handoffs: all,
            head: heads.rows[0]?.record,
            instance: instances.rows[0]?.record,
            transfers: []
          },
          new Date()
        )
      ).toEqual([]);
      expect(versionsOf((await loadAs(owner.session.id)).runtimeHandoffs)).toEqual(versionsOf(all));

      // Every reader still answers for what is kept, and says plainly what is gone.
      const taskPath = `/v1/runtime/${conversation.id}`;
      const resolved = await call("GET", taskPath);
      expect(resolved?.status, await resolved?.clone().text()).toBe(200);
      const current = ((await resolved!.json()) as { activeHandoff: RuntimeHandoff }).activeHandoff;
      expect(current.checkpointVersion).toBe(61);
      expect((await call("GET", `${taskPath}/handoff?version=42`))?.status).toBe(200);
      expect((await call("GET", `${taskPath}/handoff?version=41`))?.status).toBe(404);
      // The unmerged branch (version 10) is 50 versions behind and still there to merge.
      expect((await call("GET", `${taskPath}/handoffs/${byVersion.get(10)!.id}`))?.status).toBe(
        200
      );
      expect((await call("GET", `${taskPath}/handoffs/${byVersion.get(7)!.id}`))?.status).toBe(200);
      const target = byVersion.get(45)!;
      const rollback = await call("POST", `${taskPath}/rollback`, {
        targetHandoffId: target.id,
        expectedHandoffId: current.id
      });
      expect(rollback?.status, await rollback?.clone().text()).toBe(200);
      const resume = await call("POST", `${taskPath}/resume`, {});
      expect(resume?.status, await resume?.clone().text()).toBe(200);
      expect(((await resume!.json()) as { activeHandoff: RuntimeHandoff }).activeHandoff.id).toBe(
        target.id
      );
      // Resume moved the instance off version 7, and the next turn branches from version 45
      // (version 62): version 7 (two months old, nothing descends from it any more) and version
      // 42 go; the abandoned head (version 61) is in reach, the branch stays.
      await send("Add 2 bags of flour to stock");
      expect(versionsOf(await stored())).toEqual([5, 10, ...range(43, 62)]);
      const latest = (await stored()).at(-1)!;
      expect(latest.parentHandoffId).toBe(target.id);
      expect((await call("GET", `${taskPath}/handoffs/${byVersion.get(7)!.id}`))?.status).toBe(404);
      // The branch merges into the head.
      const merge = await call("POST", `${taskPath}/merge`, {
        branchHandoffIds: [latest.id, byVersion.get(10)!.id],
        expectedHandoffId: latest.id
      });
      expect(merge?.status, await merge?.clone().text()).toBe(200);
      expect(
        ((await merge!.json()) as { handoff: RuntimeHandoff }).handoff.mergedFromHandoffIds
      ).toEqual([byVersion.get(10)!.id]);
    } finally {
      await pool.end();
    }
  }, 120000);

  it("loads only the caller's idempotency records and recognizes a retried checkpoint on Edge", async () => {
    const { pool, call, loadAs, stored, owner, outsider, conversation } =
      await ownerConversation("dedup");
    try {
      const create = () =>
        call(
          "POST",
          `/v1/runtime/${conversation.id}/checkpoints`,
          { currentState: "Counted the shelf." },
          { "idempotency-key": "count-shelf-1" }
        );
      const before = (await stored()).length;
      const firstResponse = await create();
      expect(firstResponse?.status, await firstResponse?.clone().text()).toBe(200);
      const retry = await create();
      expect(retry?.status, await retry?.clone().text()).toBe(200);
      const firstId = ((await firstResponse!.json()) as { handoff: RuntimeHandoff }).handoff.id;
      expect(((await retry!.json()) as { handoff: RuntimeHandoff }).handoff.id).toBe(firstId);
      expect((await stored()).length).toBe(before + 1);

      const rows = await pool.query<{ account_id: string | null; task_id: string | null }>(
        "select account_id, task_id from cp2_runtime_operation_dedup where task_id = $1",
        [conversation.id]
      );
      expect(rows.rows).toEqual([{ account_id: owner.account.id, task_id: conversation.id }]);
      const mine = (await loadAs(owner.session.id)).runtimeOperationDedup ?? [];
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.every((record) => record.accountId === owner.account.id)).toBe(true);
      expect((await loadAs(outsider.session.id)).runtimeOperationDedup ?? []).toEqual([]);

      // A request that names a task loads only that task's records.
      const otherTask = randomUUID();
      const freshOther = randomUUID();
      const expiredId = randomUUID();
      const dedupRow = (id: string, taskId: string, createdAt: string) => [
        id,
        owner.account.id,
        JSON.stringify({
          id,
          accountId: owner.account.id,
          taskId,
          operationType: "checkpoint",
          idempotencyKey: randomUUID(),
          result: { taskHead: { taskId } },
          createdAt
        })
      ];
      const insertDedup =
        "insert into cp2_runtime_operation_dedup (entity_id, account_id, record) values ($1, $2, $3::jsonb)";
      await pool.query(insertDedup, dedupRow(freshOther, otherTask, new Date().toISOString()));
      // Expired (8 days old, records answer for 7): never loaded, deleted by the next write.
      await pool.query(
        insertDedup,
        dedupRow(expiredId, conversation.id, new Date(Date.now() - 8 * 86_400_000).toISOString())
      );
      const ids = (records: { id: string }[] | undefined) => (records ?? []).map((r) => r.id);
      const accountWide = ids((await loadAs(owner.session.id)).runtimeOperationDedup);
      expect(accountWide).toContain(freshOther);
      expect(accountWide).not.toContain(expiredId);
      const taskOnly = ids(
        (await loadAs(owner.session.id, `/v1/runtime/${conversation.id}/checkpoints`))
          .runtimeOperationDedup
      );
      expect(taskOnly.length).toBeGreaterThanOrEqual(1);
      expect(taskOnly).not.toContain(freshOther);
      expect(taskOnly).not.toContain(expiredId);
      const recorded = await call(
        "POST",
        `/v1/runtime/${conversation.id}/checkpoints`,
        { currentState: "Counted the till." },
        { "idempotency-key": "count-till-1" }
      );
      expect(recorded?.status, await recorded?.clone().text()).toBe(200);
      const remaining = await pool.query<{ entity_id: string }>(
        "select entity_id from cp2_runtime_operation_dedup where entity_id = any($1::text[])",
        [[expiredId, freshOther]]
      );
      expect(remaining.rows.map((row) => row.entity_id)).toEqual([freshOther]);

      // Migration 124 backfills a record stored before it, and running it again changes nothing.
      const legacyId = randomUUID();
      await pool.query(
        "insert into cp2_runtime_operation_dedup (entity_id, record) values ($1, $2::jsonb)",
        [
          legacyId,
          JSON.stringify({
            id: legacyId,
            operationType: "rollback",
            idempotencyKey: randomUUID(),
            result: { taskHead: { taskId: conversation.id } },
            createdAt: new Date().toISOString()
          })
        ]
      );
      const migration = await readFile(
        new URL("../infra/db/migrations/127_runtime_operation_dedup_tenant.sql", import.meta.url),
        "utf8"
      );
      await pool.query(migration);
      const backfilled = await pool.query(
        "select account_id, task_id, record->>'accountId' as record_account, xmin::text as version from cp2_runtime_operation_dedup where entity_id = $1",
        [legacyId]
      );
      expect(backfilled.rows[0]).toMatchObject({
        account_id: owner.account.id,
        task_id: conversation.id,
        record_account: owner.account.id
      });
      await pool.query(migration);
      const again = await pool.query(
        "select xmin::text as version from cp2_runtime_operation_dedup where entity_id = $1",
        [legacyId]
      );
      expect(again.rows[0].version).toBe(backfilled.rows[0].version);
      expect(
        ((await loadAs(owner.session.id)).runtimeOperationDedup ?? []).some(
          (record) => record.id === legacyId
        )
      ).toBe(true);
    } finally {
      await pool.end();
    }
  }, 120000);

  it("still refuses a checkpoint whose parent does not exist (migration 123's trigger)", async () => {
    const { pool, stored } = await ownerConversation("parent-trigger");
    try {
      const base = (await stored()).at(-1)!;
      const checkpoint = (id: string, parentHandoffId: string | null) =>
        JSON.stringify({ ...base, id, parentHandoffId, checkpointVersion: null });
      const orphan = randomUUID();
      await expect(
        pool.query("insert into cp2_runtime_handoffs (entity_id, record) values ($1, $2::jsonb)", [
          orphan,
          checkpoint(orphan, randomUUID())
        ])
      ).rejects.toMatchObject({ code: "23503" });
      // Parent and child in one statement (an offline chain saved at once) are accepted.
      const parent = randomUUID();
      const child = randomUUID();
      await pool.query(
        "insert into cp2_runtime_handoffs (entity_id, record) values ($1, $2::jsonb), ($3, $4::jsonb)",
        [child, checkpoint(child, parent), parent, checkpoint(parent, base.id)]
      );
      const rows = await pool.query(
        "select entity_id from cp2_runtime_handoffs where entity_id = any($1::text[])",
        [[orphan, parent, child]]
      );
      expect(rows.rows).toHaveLength(2);
      // Pruning a parent is allowed: its child keeps the id as recorded ancestry.
      await pool.query("delete from cp2_runtime_handoffs where entity_id = $1", [parent]);
      await pool.query("delete from cp2_runtime_handoffs where entity_id = $1", [child]);
    } finally {
      await pool.end();
    }
  }, 120000);

  it("keeps a synced offline batch on Edge, so the same 25 checkpoints can be sent again", async () => {
    const { pool, call, stored, loadAs, owner, conversation } = await ownerConversation("resync");
    try {
      const taskPath = `/v1/runtime/${conversation.id}`;
      const head = (await stored()).at(-1)!;
      // Made offline 40 days ago, synced now: kept from when it was synced.
      const createdAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const checkpoints = Array.from({ length: 25 }, (_value, index) => ({
        id: randomUUID(),
        goal: head.goal,
        currentState: `Offline step ${index}.`,
        runtime: head.runtime,
        createdAt
      })).map((checkpoint, index, all) => ({
        ...checkpoint,
        parentHandoffId: index === 0 ? head.id : all[index - 1]!.id
      }));
      const sync = () => call("POST", `${taskPath}/checkpoints/sync`, { checkpoints });
      const first = await sync();
      expect(first?.status, await first?.clone().text()).toBe(200);
      const firstBody = (await first!.json()) as { syncedHandoffs: RuntimeHandoff[] };
      // The hosted line goes on for 22 checkpoints, past the batch's whole version range.
      for (let index = 0; index < 22; index += 1) {
        const current = (
          (await (await call("GET", taskPath))!.json()) as { activeHandoff: RuntimeHandoff }
        ).activeHandoff;
        const created = await call("POST", `${taskPath}/checkpoints`, {
          currentState: `Hosted step ${index}.`,
          promote: true,
          expectedHandoffId: current.id
        });
        expect(created?.status, await created?.clone().text()).toBe(200);
      }
      // No idempotency key: the client lost the first answer and sends the same batch again.
      const retry = await sync();
      expect(retry?.status, await retry?.clone().text()).toBe(200);
      const retryBody = (await retry!.json()) as { syncedHandoffs: RuntimeHandoff[] };
      expect(retryBody.syncedHandoffs).toEqual(firstBody.syncedHandoffs);
      const versions = (await stored()).map((handoff) => handoff.checkpointVersion);
      // Kept: the head's line from version 30 on (the latest 20), the whole synced batch
      // (versions 3 to 27) and version 2 it started from. Gone: version 1, and versions 28 and 29
      // of the hosted line.
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_value, index) => from + index);
      expect(versions).toEqual([...range(2, 27), ...range(30, 49)]);
      // Both rules keep exactly what is stored, and the member loads all of it.
      const all = await stored();
      const headRow = await pool.query(
        "select record from cp2_runtime_task_heads where entity_id = $1",
        [conversation.id]
      );
      expect(
        prunableRuntimeCheckpoints(
          { handoffs: all, head: headRow.rows[0]?.record, instance: undefined, transfers: [] },
          new Date()
        )
      ).toEqual([]);
      expect(
        ((await loadAs(owner.session.id)).runtimeHandoffs ?? [])
          .filter((handoff) => handoff.taskId === conversation.id)
          .map((handoff) => handoff.checkpointVersion)
          .sort((left, right) => left! - right!)
      ).toEqual(versions);
    } finally {
      await pool.end();
    }
  }, 240000);
});
