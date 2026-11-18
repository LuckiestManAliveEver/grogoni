import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Pool as PgPool } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createNodeAgentTurns } from "../services/api/src/node-agent-turns";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("durable Node messaging queue on PostgreSQL", () => {
  it("persists acceptance and resumes the same turn after worker replacement", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    let turns: ReturnType<typeof createNodeAgentTurns> | undefined;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await client.query("begin");
      let persisted = await loadTransactionalCp2Snapshot(client);
      const complete = vi.fn(async () => {
        await blocked;
        return {
          provider: "fixture",
          status: "available" as const,
          outputText: JSON.stringify({ type: "response", message: "The saved answer." }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      });
      const store = createCp2Store({ runtimeModelProvider: { name: "fixture", complete } });
      // Other persistence fixtures may disable catalogue entries. This rollback-only test
      // uses the deterministic provider's own catalogue, never a live provider selection.
      store.hydrateSnapshot({ ...persisted, modelCatalog: store.snapshot().modelCatalog });
      const owner = store.continueWithChannelPin({
        channel: "email",
        destination: `instant-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const business = store.createBusiness({
        sessionId: owner.session.id,
        name: "Queue fixture",
        language: "en",
        phoneNumber: "+254711456789",
        phoneCountry: "KE"
      }).business;
      const chat = store.createConversation({
        sessionId: owner.session.id,
        kind: "personal",
        activeShopId: business.id
      }).conversation;
      const durable = Object.assign(store, {
        agentTurnDatabase: client,
        flush: async () => {
          const next = store.snapshot();
          await saveTransactionalCp2Snapshot(client, next, persisted);
          persisted = next;
        }
      });
      const failures: unknown[] = [];
      turns = createNodeAgentTurns(durable, (error) => failures.push(error));
      const input = {
        sessionId: owner.session.id,
        conversationId: chat.id,
        businessId: business.id,
        clientMessageId: "durable-fixture-message",
        content: { type: "text" as const, text: "Please answer my saved question." },
        message: "Please answer my saved question."
      };
      const accepted = await turns.accept(await store.createAgentConversationMessage(input));
      expect(accepted.processing.status).toBe("pending");
      const turnId = accepted.processing.turnId!;
      expect(
        (await client.query("select message_id from agent_chat_turns where id = $1", [turnId]))
          .rows[0]?.message_id
      ).toBe(accepted.message.id);
      const saved = await loadTransactionalCp2Snapshot(client);
      expect(saved.conversationMessages.some((message) => message.id === accepted.message.id)).toBe(
        true
      );
      const repeated = await turns.accept(await store.createAgentConversationMessage(input));
      expect(repeated.processing.turnId).toBe(turnId);
      release();
      await vi.waitFor(async () => {
        expect(failures).toEqual([]);
        expect((await turns!.poll(turnId, owner.session.id)).processing.status).toBe("completed");
      });
      await turns.close();
      const finishedSnapshot = await loadTransactionalCp2Snapshot(client);
      const restored = createCp2Store();
      restored.hydrateSnapshot(finishedSnapshot);
      expect(
        restored.listRuntimeSessions({ sessionId: owner.session.id, businessId: business.id })
      ).toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: chat.id })]));
      turns = createNodeAgentTurns(durable);
      expect((await turns.poll(turnId, owner.session.id)).processing.status).toBe("completed");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(
        (
          await client.query(
            "select count(*)::int as n from agent_chat_turns where message_id = $1",
            [accepted.message.id]
          )
        ).rows[0]?.n
      ).toBe(1);
    } finally {
      release();
      await turns?.close();
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  }, 60_000);
});
