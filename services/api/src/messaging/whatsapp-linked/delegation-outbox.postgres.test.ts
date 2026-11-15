import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresCp2Store, type PostgresCp2Store } from "../../cp2/postgres-store.js";
import type { ChannelDelegationResolution } from "../../cp2/domains/agent-runtime/channel-delegation-result.js";

// Two real CP2 Postgres stores on the migrated test database stand in for two processes: the Edge
// API that records a delegated result and the Node connector host that settles it.
// CP2_POSTGRES_TEST_DATABASE_URL=postgresql://... npx vitest run <this file>
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;

const run = randomUUID();
const servedBusiness = `wa-outbox-served-${run}`;
const otherBusiness = `wa-outbox-other-${run}`;
const resolution = (businessId: string, turnId: string): ChannelDelegationResolution => ({
  businessId,
  turnId,
  delegation: {
    channelId: `channel-${run}`,
    grantId: "grant",
    ownerId: "owner",
    sourceMessageId: "source",
    actorId: "254711111111@s.whatsapp.net"
  },
  toolName: "product.create",
  outcome: "executed",
  resolvedBy: "owner"
});

describe.skipIf(!url)("delegated-result outbox on PostgreSQL", { timeout: 60_000 }, () => {
  const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
  const turns = {
    edge: `edge-${run}`,
    node: `node-${run}`,
    other: `other-${run}`
  };
  const rows = async () =>
    (
      await pool!.query<{ entity_id: string; record: { status: string; reason: string | null } }>(
        "select entity_id, record from cp2_whatsapp_linked_delegation_results where business_id = any($1) order by entity_id",
        [[servedBusiness, otherBusiness]]
      )
    ).rows;
  afterAll(async () => {
    await pool?.query(
      "delete from cp2_whatsapp_linked_delegation_results where business_id = any($1)",
      [[servedBusiness, otherBusiness]]
    );
    await pool?.query("delete from cp2_audit_events where record->>'aggregateId' = any($1)", [
      Object.values(turns)
    ]);
    await pool?.end();
  });

  it("keeps rows another process inserted, loads them, and settles only served businesses", async () => {
    let node: PostgresCp2Store | undefined;
    let edge: PostgresCp2Store | undefined;
    try {
      // The Node host boots first, so its snapshot predates the Edge's write.
      node = await createPostgresCp2Store({ databaseUrl: url! });
      edge = await createPostgresCp2Store({ databaseUrl: url! });
      await edge.deliverLinkedDelegationResult(resolution(servedBusiness, turns.edge));
      await edge.deliverLinkedDelegationResult(resolution(otherBusiness, turns.other));
      await edge.flush();
      await edge.close();
      edge = undefined;
      expect((await rows()).map((row) => row.entity_id).sort()).toEqual(
        [`whatsapp-result:${turns.edge}`, `whatsapp-result:${turns.other}`].sort()
      );

      // The Node host changes the same collection without knowing those rows. A full save used
      // to delete every row missing from memory; this one must not.
      await node.deliverLinkedDelegationResult(resolution(servedBusiness, turns.node));
      await node.flush();
      expect(await rows()).toHaveLength(3);

      const stored = await node.loadPendingLinkedDelegationResults();
      expect(
        stored
          .map((row) => (row as { id: string }).id)
          .filter((id) => id.endsWith(run))
          .sort()
      ).toEqual(
        [
          `whatsapp-result:${turns.edge}`,
          `whatsapp-result:${turns.node}`,
          `whatsapp-result:${turns.other}`
        ].sort()
      );

      // The fake channel does not exist, so authority checks suppress; nothing is sent.
      const report = await node.drainLinkedDelegationResults({
        ready: (businessId) => businessId === servedBusiness,
        stored
      });
      expect(report).toMatchObject({ sent: 0, suppressed: 2, failed: 0 });
      await node.flush();
      const settled = Object.fromEntries((await rows()).map((row) => [row.entity_id, row.record]));
      expect(settled[`whatsapp-result:${turns.edge}`]).toMatchObject({
        status: "suppressed",
        reason: "channel_unavailable"
      });
      expect(settled[`whatsapp-result:${turns.node}`]).toMatchObject({ status: "suppressed" });
      // Not served by this host: left untouched for whichever worker holds that business.
      expect(settled[`whatsapp-result:${turns.other}`]).toMatchObject({ status: "pending" });
      expect(
        node.linkedDelegationResultEntries(otherBusiness).map((entry) => entry.status)
      ).toEqual([]);
    } finally {
      await edge?.close();
      await node?.close();
    }
  });

  it("refuses rows whose identity does not match their turn", async () => {
    await expect(
      pool!.query(
        "insert into cp2_whatsapp_linked_delegation_results (entity_id, business_id, record) values ($1, $2, $3::jsonb)",
        [
          `whatsapp-result:forged-${run}`,
          servedBusiness,
          JSON.stringify({
            id: `whatsapp-result:forged-${run}`,
            idempotencyKey: `whatsapp-result:forged-${run}`,
            turnId: `other-${run}`,
            businessId: servedBusiness,
            status: "pending"
          })
        ]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
