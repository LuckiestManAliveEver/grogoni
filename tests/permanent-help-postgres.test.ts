import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Pool as PgPool } from "pg";
import { describe, expect, it } from "vitest";
import { createCp2Store, serializeSessionCookie } from "../services/api/src/cp2/store";
import {
  createEdgeSnapshotScope,
  prepareEdgeHydration,
  prepareEdgePersistence
} from "../services/api/src/cp2/edge-snapshot-scope";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };
describe.skipIf(!url)("Help persistence on Edge", () => {
  it("keeps the same private threads, seed guides, and question after request hydration", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      const baseline = await loadTransactionalCp2Snapshot(client);
      const store = createCp2Store();
      store.hydrateSnapshot(prepareEdgeHydration(baseline));
      const session = store.continueWithChannelPin({
        channel: "email",
        destination: `help-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const help = store.ensureHelpConversations({ sessionId: session.session.id });
      store.createConversationMessage({
        sessionId: session.session.id,
        conversationId: help.conversationId,
        clientMessageId: "help-question-1",
        content: { type: "text", text: "How do I upload a receipt?" }
      });
      await saveTransactionalCp2Snapshot(
        client,
        prepareEdgePersistence(store.snapshot(), baseline),
        baseline
      );
      const request = new Request("https://grogoni.com/api/v1/conversations", {
        headers: { cookie: serializeSessionCookie(session.session.id).split(";")[0]! }
      });
      const scope = await createEdgeSnapshotScope(client, request, "/v1/conversations", undefined);
      const loaded = await loadTransactionalCp2Snapshot(client, scope);
      const restored = createCp2Store();
      restored.hydrateSnapshot(prepareEdgeHydration(loaded));
      expect(
        restored.ensureHelpConversations({ sessionId: session.session.id }).conversationId
      ).toBe(help.conversationId);
      expect(restored.snapshot().conversations.filter((item) => item.helpTopic)).toHaveLength(7);
      const messages = restored.getConversation({
        sessionId: session.session.id,
        conversationId: help.conversationId
      }).messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]!.content).toMatchObject({ text: "How do I upload a receipt?" });
      expect(loaded.conversations.every((item) => item.accountId === session.account.id)).toBe(
        true
      );
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
