import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

/**
 * Concern 2 (docs/deployment/supabase-edge-api.md, "Agent turns" and "Fast paths"). Before this,
 * POST /v1/messages with `agent` ran the whole agent turn, model call included, inside its request
 * transaction while holding edge:account:<id> and edge:business:<id>; every other write of that
 * account (a read marker, typing, a send in another chat) waited up to lock_timeout and answered
 * 503. These tests drive the real Edge pipeline against PostgreSQL with a slow fake model.
 */

const model = vi.hoisted(() => ({
  delayMs: 0,
  calls: 0,
  /** Runs at the start of every model call, before it answers. */
  onCall: null as null | (() => Promise<void>),
  reply: "Hello from the fixture model."
}));

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
      provider: "fixture-slow-model",
      executionTarget: "local",
      canRun: async () => ({ available: true, errorCode: null, message: null }),
      healthCheck: async () => ({
        available: true,
        modelId,
        provider: "fixture-slow-model",
        executionTarget: "local",
        latencyMs: 1,
        responsePreview: "GROGONI_MODEL_OK",
        errorCode: null,
        message: null,
        retryable: false
      }),
      generate: async () => {
        model.calls += 1;
        await model.onCall?.();
        await new Promise((resolve) => setTimeout(resolve, model.delayMs));
        return {
          text: JSON.stringify({ type: "response", message: model.reply }),
          modelId,
          provider: "fixture-slow-model",
          executionTarget: "local",
          latencyMs: model.delayMs
        };
      }
    })
  })
}));

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

async function setup() {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const transactionsOpen = { count: 0 };
  /** The production request transaction: lock_timeout 10s and the shared store lock. */
  async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    transactionsOpen.count += 1;
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '10s'");
      await client.query(
        "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))"
      );
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      transactionsOpen.count -= 1;
      client.release();
    }
  }
  /** The production record transaction: no store lock. */
  async function independent<T>(work: (client: PoolClient) => Promise<T>) {
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
    destination: `edge-async-${randomUUID()}@example.invalid`,
    pin: "1234"
  });
  const businessId = store.createBusiness({
    sessionId: owner.session.id,
    name: `Synthetic async turns ${randomUUID()}`,
    language: "en",
    phoneNumber: `+25471${Date.now().toString().slice(-7)}`,
    phoneCountry: "KE"
  }).business.id;
  const chat = store.createConversation({
    sessionId: owner.session.id,
    kind: "personal",
    activeShopId: businessId
  }).conversation;
  const otherChat = store.createConversation({
    sessionId: owner.session.id,
    kind: "personal",
    activeShopId: businessId
  }).conversation;
  await transaction((client) => saveTransactionalCp2Snapshot(client, store.snapshot(), baseline));
  const edge = await createEdgeDomainRoutes({ transaction, approvalTransaction: independent });
  const call = async (path: string, method: string, body?: unknown) => {
    const started = Date.now();
    const response = await edge.routes(
      new Request(`https://grogoni.com${path}`, {
        method,
        headers: {
          cookie: `grogoni_session=${owner.session.id}`,
          "content-type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      path
    );
    if (response === null) throw new Error(`No route for ${method} ${path}`);
    return { response, ms: Date.now() - started, json: () => response.clone().json() };
  };
  const ask = (text: string, conversationId = chat.id, clientMessageId: string = randomUUID()) =>
    call("/v1/messages", "POST", {
      conversationId,
      clientMessageId,
      content: { type: "text", text },
      agent: { businessId, message: text }
    });
  /** Holds the request locks a running write would hold, on its own connection. */
  const holdLocks = async () => {
    const holder = await pool.connect();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `edge:account:${owner.account.id}`
    ]);
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `edge:business:${businessId}`
    ]);
    return async () => {
      await holder.query("rollback");
      holder.release();
    };
  };
  /** From a fresh connection: nothing holds the request locks, and no transaction is open. */
  const nothingLocked = async () => {
    const checker = await pool.connect();
    try {
      await checker.query("begin");
      const locks = (
        await checker.query<{ account: boolean; business: boolean; store: boolean }>(
          `select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as account,
                  pg_try_advisory_xact_lock(hashtextextended($2, 0)) as business,
                  pg_try_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store')) as store`,
          [`edge:account:${owner.account.id}`, `edge:business:${businessId}`]
        )
      ).rows[0]!;
      await checker.query("rollback");
      const open = (
        await checker.query<{ open: string }>(
          `select count(*) as open from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid()
             and state in ('idle in transaction', 'active') and backend_type = 'client backend'`
        )
      ).rows[0]!.open;
      return {
        ...locks,
        openTransactions: Number(open),
        requestTransactions: transactionsOpen.count
      };
    } finally {
      checker.release();
    }
  };
  const turnRow = (messageId: string) =>
    pool
      .query(
        "select id, status, attempts, error_code, retryable, session_id from agent_chat_turns where message_id = $1",
        [messageId]
      )
      .then((result) => result.rows[0]);
  // The first requests of a process load and compile the route modules (seconds on a busy
  // machine); warm the same paths so the timings below measure waiting, not first-load cost.
  for (const warm of [
    () => call(`/v1/conversations/${chat.id}`, "GET"),
    () => call(`/v1/conversations/${chat.id}`, "PATCH", { read: true }),
    () => call(`/v1/conversations/${chat.id}/typing`, "POST", { typing: false }),
    () =>
      call("/v1/messages", "POST", {
        conversationId: otherChat.id,
        clientMessageId: randomUUID(),
        content: { type: "text", text: "warm up" }
      })
  ])
    expect((await warm()).response.status).toBe(200);
  return {
    pool,
    edge,
    call,
    ask,
    holdLocks,
    nothingLocked,
    turnRow,
    owner,
    businessId,
    chat,
    otherChat
  };
}

describe.skipIf(!databaseUrl)("Edge async agent turns and fast paths on PostgreSQL", () => {
  it("answers read markers and typing while another write holds the account and business locks", async () => {
    const t = await setup();
    try {
      model.delayMs = 0;
      model.onCall = null;
      const release = await t.holdLocks();
      try {
        const read = await t.call(`/v1/conversations/${t.chat.id}`, "PATCH", { read: true });
        expect(read.response.status, await read.response.clone().text()).toBe(200);
        expect(read.ms).toBeLessThan(2000);
        const pinned = await t.call(`/v1/conversations/${t.chat.id}`, "PATCH", { pinned: true });
        expect(pinned.response.status).toBe(200);
        expect(pinned.ms).toBeLessThan(2000);
        const typing = await t.call(`/v1/conversations/${t.chat.id}/typing`, "POST", {
          typing: true
        });
        expect(typing.response.status, await typing.response.clone().text()).toBe(200);
        expect(typing.ms).toBeLessThan(2000);
        console.log(
          JSON.stringify({
            event: "edge_fast_path_under_held_locks",
            readMarkerMs: read.ms,
            settingsMs: pinned.ms,
            typingMs: typing.ms
          })
        );
        // Control: an ordinary send still takes the account lock, so it waits for the holder.
        let sendSettled = false;
        const send = t
          .call("/v1/messages", "POST", {
            conversationId: t.otherChat.id,
            clientMessageId: randomUUID(),
            content: { type: "text", text: "a plain send" }
          })
          .finally(() => {
            sendSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(sendSettled).toBe(false);
        await release();
        expect((await send).response.status).toBe(200);
      } finally {
        await release().catch(() => {});
      }
    } finally {
      await t.edge.settled();
      await t.pool.end();
    }
  }, 90_000);

  it("queues a turn that needs a model, runs the model with no transaction open, and keeps other writes fast", async () => {
    const t = await setup();
    try {
      model.calls = 0;
      model.delayMs = 4000;
      const duringModel: Record<string, unknown>[] = [];
      let modelStarted!: () => void;
      const started = new Promise<void>((resolve) => (modelStarted = resolve));
      model.onCall = async () => {
        duringModel.push(await t.nothingLocked());
        modelStarted();
      };
      const clientMessageId = randomUUID();
      const sent = await t.ask(
        "Hello there, what can you help me with today?",
        t.chat.id,
        clientMessageId
      );
      expect(sent.response.status, await sent.response.clone().text()).toBe(200);
      const accepted = await sent.json();
      expect(accepted.processing.status).toBe("pending");
      expect(accepted.agentMessage).toBeUndefined();
      expect(sent.ms).toBeLessThan(2000);
      const turnId = accepted.processing.turnId as string;
      expect(await t.turnRow(accepted.id)).toMatchObject({ id: turnId });

      await started;
      // While the model answers: a read marker in the same chat and a send in another chat.
      const read = await t.call(`/v1/conversations/${t.chat.id}`, "PATCH", { read: true });
      const other = await t.call("/v1/messages", "POST", {
        conversationId: t.otherChat.id,
        clientMessageId: randomUUID(),
        content: { type: "text", text: "Sent while the agent works" }
      });
      // A plain send in the same chat while it runs: the reply answers what came before its
      // message, so this changes nothing the model was asked and the call is not made again.
      const sameChat = await t.call("/v1/messages", "POST", {
        conversationId: t.chat.id,
        clientMessageId: randomUUID(),
        content: { type: "text", text: "A note sent while the agent works" }
      });
      expect(sameChat.response.status).toBe(200);
      expect(read.response.status).toBe(200);
      expect(other.response.status).toBe(200);
      console.log(
        JSON.stringify({
          event: "edge_write_during_agent_turn",
          postMs: sent.ms,
          readMarkerMs: read.ms,
          otherConversationSendMs: other.ms
        })
      );
      expect(read.ms).toBeLessThan(2000);
      expect(other.ms).toBeLessThan(2000);
      // A resend of the same message while its turn runs answers with that turn, no second one.
      const resent = await t.ask(
        "Hello there, what can you help me with today?",
        t.chat.id,
        clientMessageId
      );
      expect((await resent.json()).processing).toMatchObject({ status: "pending", turnId });

      const pendingPoll = await t.call(`/v1/agent-turns/${turnId}`, "GET");
      expect((await pendingPoll.json()).processing.status).toBe("pending");

      await t.edge.settled();
      expect(duringModel).toEqual([
        { account: true, business: true, store: true, openTransactions: 0, requestTransactions: 0 }
      ]);
      expect(model.calls).toBe(1);
      const done = await (await t.call(`/v1/agent-turns/${turnId}`, "GET")).json();
      expect(done.processing.status).toBe("completed");
      expect(done.agentMessage.content.text).toContain("Hello from the fixture model.");
      expect(done.agentMessage.replyToMessageId).toBe(accepted.id);
      // It sorts right after its message, before the send made while it ran.
      expect(Date.parse(done.agentMessage.createdAt)).toBe(Date.parse(accepted.createdAt) + 1);
      expect(await t.turnRow(accepted.id)).toMatchObject({
        status: "completed",
        attempts: 1,
        session_id: null
      });
      // Resending after completion returns the same reply and runs nothing.
      const again = await (
        await t.ask("Hello there, what can you help me with today?", t.chat.id, clientMessageId)
      ).json();
      expect(again.agentMessage.id).toBe(done.agentMessage.id);
      expect(model.calls).toBe(1);
      const replies = await t.pool.query(
        "select count(*)::int as n from cp2_conversation_messages where record->>'replyToMessageId' = $1",
        [accepted.id]
      );
      expect(replies.rows[0].n).toBe(1);
      // Another account cannot read the turn.
      const stranger = await t.edge.routes(
        new Request(`https://grogoni.com/v1/agent-turns/${turnId}`, {
          headers: { cookie: `grogoni_session=${randomUUID()}` }
        }),
        `/v1/agent-turns/${turnId}`
      );
      expect(stranger?.status).toBe(404);
    } finally {
      model.onCall = null;
      await t.edge.settled();
      await t.pool.end();
    }
  }, 120_000);

  it("retries a run that died once, then fails it with a retry the client can trigger", async () => {
    const t = await setup();
    try {
      model.calls = 0;
      model.delayMs = 0;
      model.onCall = null;
      // Queue a turn whose worker "dies": its row is claimed, then its lease runs out.
      const clientMessageId = randomUUID();
      const blocked = new Promise<void>(() => {});
      model.onCall = () => blocked; // the first run never finishes: an isolate that was killed
      const accepted = await (
        await t.ask("Tell me something about my shop", t.chat.id, clientMessageId)
      ).json();
      const turnId = accepted.processing.turnId as string;
      for (let waited = 0; model.calls === 0 && waited < 20_000; waited += 50)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(model.calls).toBe(1);
      model.onCall = null;
      await t.pool.query(
        "update agent_chat_turns set lease_until = now() - interval '1 second' where id = $1",
        [turnId]
      );
      // The client's next poll finds the dead run and starts it again (attempt 2).
      const poll = await (await t.call(`/v1/agent-turns/${turnId}`, "GET")).json();
      expect(poll.processing.status).not.toBe("failed");
      for (let waited = 0; waited < 20_000; waited += 100) {
        if ((await t.turnRow(accepted.id)).status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await t.turnRow(accepted.id)).toMatchObject({ status: "completed", attempts: 2 });

      // A second message whose run dies on its last attempt is failed, never left pending.
      const second = await (await t.ask("And how are sales?", t.chat.id)).json();
      const secondId = second.processing.turnId as string;
      await t.edge.settled();
      await t.pool.query(
        "update agent_chat_turns set status = 'running', attempts = max_attempts, lease_token = gen_random_uuid(), lease_until = now() - interval '1 second', result = null where id = $1",
        [secondId]
      );
      const lost = await (await t.call(`/v1/agent-turns/${secondId}`, "GET")).json();
      expect(lost.processing).toMatchObject({
        status: "failed",
        errorCode: "AGENT_TURN_LOST",
        retryable: true
      });
      // The client's retry is a resend of the same message: the same row runs again.
      await t.pool.query(
        "delete from cp2_conversation_messages where record->>'replyToMessageId' = $1",
        [second.id]
      );
      const retried = await (
        await t.call("/v1/messages", "POST", {
          conversationId: t.chat.id,
          clientMessageId: second.clientMessageId,
          content: { type: "text", text: "And how are sales?" },
          agent: { businessId: t.businessId, message: "And how are sales?" }
        })
      ).json();
      expect(retried.processing).toMatchObject({ status: "pending", turnId: secondId });
      await t.edge.settled();
      expect(await t.turnRow(second.id)).toMatchObject({ status: "completed", attempts: 1 });
    } finally {
      model.onCall = null;
      await t.edge.settled();
      await t.pool.end();
    }
  }, 120_000);

  it("never gives two concurrent writes of one account the same sync journal number", async () => {
    const t = await setup();
    try {
      const count = async (collection: string) =>
        Number(
          (
            await t.pool.query(
              "select count(*) as n from account_sync_changes where account_id = $1 and collection = $2",
              [t.owner.account.id, collection]
            )
          ).rows[0].n
        );
      const typingBefore = await count("conversation_typing");
      const sends = Array.from({ length: 3 }, (_, index) =>
        t.call("/v1/messages", "POST", {
          conversationId: t.otherChat.id,
          clientMessageId: randomUUID(),
          content: { type: "text", text: `concurrent send ${index}` }
        })
      );
      // Typing takes no account lock, so it journals while the sends hold it.
      const typing = Array.from({ length: 6 }, (_, index) =>
        t.call(`/v1/conversations/${t.chat.id}/typing`, "POST", { typing: index % 2 === 0 })
      );
      const responses = await Promise.all([...sends, ...typing]);
      for (const { response } of responses)
        expect(response.status, await response.clone().text()).toBe(200);
      const sent = await Promise.all(sends.map(async (send) => (await send).json()));
      for (const message of sent) {
        const journal = await t.pool.query(
          "select count(*)::int as n from account_sync_changes where account_id = $1 and collection = 'conversation_messages' and entity_id = $2",
          [t.owner.account.id, message.id]
        );
        expect(journal.rows[0].n, `journal row of ${message.id}`).toBe(1);
      }
      expect(await count("conversation_typing")).toBe(typingBefore + 6);
    } finally {
      await t.edge.settled();
      await t.pool.end();
    }
  }, 90_000);

  it("keeps the synchronous runtime route's model call outside its transaction", async () => {
    const t = await setup();
    try {
      model.delayMs = 500;
      const duringModel: Record<string, unknown>[] = [];
      model.onCall = async () => {
        duringModel.push(await t.nothingLocked());
      };
      const session = await (
        await t.call(`/businesses/${t.businessId}/runtime/sessions`, "POST", {})
      ).json();
      const turn = await t.call(`/businesses/${t.businessId}/runtime/turns`, "POST", {
        runtimeSessionId: session.id ?? session.session?.id,
        message: "What should I restock this week?"
      });
      expect(turn.response.status, await turn.response.clone().text()).toBe(200);
      expect(duringModel.length).toBeGreaterThan(0);
      for (const state of duringModel)
        expect(state).toEqual({
          account: true,
          business: true,
          store: true,
          openTransactions: 0,
          requestTransactions: 0
        });
    } finally {
      model.onCall = null;
      await t.edge.settled();
      await t.pool.end();
    }
  }, 90_000);
});
