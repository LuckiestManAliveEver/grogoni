import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPurchaseOrderStore,
  purchaseDraftDigest,
  type PurchaseOrderDelivery,
  type PurchaseOrderSubmission
} from "./purchase-order-store.js";
import type { PurchaseDraft } from "./inventory-procurement-store.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("durable approved purchase orders", () => {
  const schema = `orders_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const buyer = { sessionId: "buyer-user", businessId: "buyer" };
  const supplier = { sessionId: "supplier-user", businessId: "supplier" };
  const authorize = (actor: { sessionId: string | null; businessId: string }) => {
    if (actor.sessionId !== `${actor.businessId}-user`) throw new Error("unauthorized");
    return { userId: actor.sessionId };
  };
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
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
  };
  const delivery: PurchaseOrderDelivery = {
    check: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ providerMessageId: "provider-1" }))
  };
  const store = createPurchaseOrderStore(transaction, authorize, delivery);
  let draft: PurchaseDraft;
  let input: PurchaseOrderSubmission;
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    await pool.query(`create table cp2_businesses(entity_id text primary key,record jsonb);
      create table business_purchase_drafts(business_id text,draft_id text,actor_id text,record jsonb,created_at timestamptz default now(),primary key(business_id,draft_id));
      create table business_environment_task_verifications(business_id text,task_id text,actor_id text,status text,claim_eligible boolean,evidence_sequence integer);
      create table business_supplier_quotes(business_id text,quote_id text,record jsonb);
      create table cp2_suppliers(entity_id text,business_id text,record jsonb);
      create table cp2_supplier_contact_links(entity_id text,record jsonb);
      create table cp2_network_nodes(entity_id text,record jsonb);`);
    await pool.query(
      await readFile(
        new URL(
          "../../../../../../infra/db/migrations/122_purchase_order_delivery.sql",
          import.meta.url
        ),
        "utf8"
      )
    );
  });
  beforeEach(async () => {
    vi.mocked(delivery.check).mockReset().mockResolvedValue(undefined);
    vi.mocked(delivery.send).mockReset().mockResolvedValue({ providerMessageId: "provider-1" });
    await pool.query(
      "truncate cp2_businesses,business_purchase_drafts,business_purchase_orders,business_environment_task_verifications,business_supplier_quotes,cp2_suppliers,cp2_supplier_contact_links,cp2_network_nodes cascade"
    );
    await pool.query(
      "insert into cp2_businesses values ('buyer','{}'),('supplier','{}'),('other','{}')"
    );
    draft = {
      id: "draft",
      businessId: "buyer",
      taskId: "task",
      actionId: "prepare",
      supplierId: "supplier-record",
      status: "DRAFT",
      submissionStatus: "NOT_SUBMITTED",
      requiresSubmissionApproval: true,
      currency: "KES",
      totalMinor: 12000,
      units: { beans: "kg" },
      createdAt: new Date().toISOString(),
      items: [
        {
          productId: "beans",
          supplierId: "supplier-record",
          quoteId: "quote",
          quantityMilli: 2000,
          totalMinor: 12000,
          stockoutDays: 1,
          comparedQuoteIds: ["other-supplier-secret"],
          evidenceRefs: ["private-invoice"]
        }
      ],
      recommendation: {
        status: "READY",
        businessId: "buyer",
        currency: "KES",
        budgetMinor: 15000,
        totalMinor: 12000,
        remainingBudgetMinor: 3000,
        horizonDays: 3,
        observedAt: new Date().toISOString(),
        sourceRefs: ["private-sales"],
        items: [],
        issues: []
      }
    };
    input = {
      draftId: draft.id,
      draftDigest: purchaseDraftDigest(draft),
      channel: "grogoni",
      recipient: "supplier"
    };
    await pool.query(
      "insert into business_purchase_drafts(business_id,draft_id,actor_id,record) values ('buyer','draft','buyer-user',$1)",
      [JSON.stringify(draft)]
    );
    await pool.query(
      "insert into business_environment_task_verifications values ('buyer','task','buyer-user','PASSED',true,1)"
    );
    await pool.query("insert into business_supplier_quotes values ('buyer','quote',$1)", [
      JSON.stringify({ expiresAt: new Date(Date.now() + 86400000).toISOString() })
    ]);
    await pool.query("insert into cp2_suppliers values ('supplier-record','buyer',$1)", [
      JSON.stringify({
        id: "supplier-record",
        businessId: "buyer",
        email: "supplier@example.test",
        phone: "+254700000001"
      })
    ]);
    await pool.query("insert into cp2_supplier_contact_links values ('link',$1)", [
      JSON.stringify({
        businessId: "buyer",
        supplierId: "supplier-record",
        linkType: "supplier",
        networkNodeId: "node"
      })
    ]);
    await pool.query("insert into cp2_network_nodes values ('node',$1)", [
      JSON.stringify({
        ownerUserId: "buyer-user",
        grogoniBusinessId: "supplier",
        consentStatus: "granted",
        visibilityStatus: "direct"
      })
    ]);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it("submits once to a consented supplier inbox without changing the immutable draft", async () => {
    const order = await store.submit(buyer, input, "approved-action");
    expect(order.status).toBe("SUBMITTED_IN_APP");
    expect((await store.orders(supplier)).incoming).toHaveLength(1);
    expect((await store.orders({ sessionId: "other-user", businessId: "other" })).incoming).toEqual(
      []
    );
    expect(
      (await pool.query("select record from business_purchase_drafts")).rows[0].record
    ).toEqual(draft);
    expect(JSON.stringify(order.snapshot)).not.toMatch(
      /private|other-supplier-secret|recommendation|comparedQuoteIds/
    );
    expect(delivery.send).not.toHaveBeenCalled();
    expect((await store.submit(buyer, input, "another-approval")).order_id).toBe(order.order_id);
  });
  it("requires the original actor and exact reviewed digest", async () => {
    await expect(
      store.submit({ ...buyer, sessionId: "supplier-user" }, input, "action")
    ).rejects.toThrow("unauthorized");
    await expect(store.submit(supplier, input, "action")).rejects.toThrow("not found");
    await expect(
      store.submit(buyer, { ...input, draftDigest: "0".repeat(64) }, "action")
    ).rejects.toThrow("changed");
    expect((await store.orders(buyer)).outgoing).toEqual([]);
  });
  it("blocks unlinked, revoked, self and wrong supplier recipients", async () => {
    for (const recipient of ["other", "buyer", "missing"])
      await expect(store.submit(buyer, { ...input, recipient }, "action")).rejects.toThrow(
        "linked"
      );
    await pool.query(
      'update cp2_network_nodes set record=record||\'{"consentStatus":"revoked"}\'::jsonb'
    );
    await expect(store.submit(buyer, input, "action")).rejects.toThrow("linked");
  });
  it("blocks expired quotes and failed latest independent verification", async () => {
    await pool.query(
      "insert into business_environment_task_verifications values ('buyer','task','buyer-user','FAILED',false,2)"
    );
    await expect(store.submit(buyer, input, "action")).rejects.toThrow("verification");
    await pool.query(
      "delete from business_environment_task_verifications where evidence_sequence=2"
    );
    await pool.query(
      'update business_supplier_quotes set record=\'{"expiresAt":"2000-01-01T00:00:00Z"}\''
    );
    await expect(store.submit(buyer, input, "action")).rejects.toThrow("expired");
  });
  it("requires exact saved external destination, consent and available transport", async () => {
    const email = {
      ...input,
      channel: "email" as const,
      recipient: "supplier@example.test",
      mailboxId: "mailbox",
      optInConfirmed: true
    };
    await expect(
      store.submit(buyer, { ...email, recipient: "attacker@example.test" }, "action")
    ).rejects.toThrow("saved address");
    await expect(
      store.submit(buyer, { ...email, optInConfirmed: false }, "action")
    ).rejects.toThrow("approval");
    const unavailable = createPurchaseOrderStore(transaction, authorize);
    await expect(unavailable.submit(buyer, email, "action")).rejects.toThrow("not configured");
    expect(delivery.send).not.toHaveBeenCalled();
  });
  it.each(["email", "whatsapp"] as const)(
    "commits before %s dispatch, sends once under concurrency and does not claim supplier acceptance",
    async (channel) => {
      const external = {
        ...input,
        channel,
        recipient: channel === "email" ? "supplier@example.test" : "+254700000001",
        optInConfirmed: true,
        ...(channel === "email" ? { mailboxId: "mailbox" } : {})
      };
      vi.mocked(delivery.send).mockImplementation(async () => {
        expect(
          (await pool.query("select status from business_purchase_orders")).rows[0].status
        ).toBe("DISPATCHING");
        return { providerMessageId: "provider-1" };
      });
      await Promise.all([store.submit(buyer, external, "a"), store.submit(buyer, external, "b")]);
      expect(delivery.send).toHaveBeenCalledTimes(1);
      expect((await store.orders(buyer)).outgoing[0]?.status).toBe("PROVIDER_ACCEPTED");
      await expect(store.submit(buyer, input, "new-channel")).rejects.toThrow(
        "different submission"
      );
    }
  );
  it("retains ambiguous delivery without sending again after an outer request rollback", async () => {
    vi.mocked(delivery.send).mockRejectedValue(new Error("timeout with SECRET provider body"));
    const external = {
      ...input,
      channel: "email" as const,
      recipient: "supplier@example.test",
      mailboxId: "mailbox",
      optInConfirmed: true
    };
    const outer = await pool.connect();
    try {
      await outer.query("begin");
      expect((await store.submit(buyer, external, "action")).status).toBe("DELIVERY_UNKNOWN");
      await outer.query("rollback");
      expect((await store.submit(buyer, external, "replay")).status).toBe("DELIVERY_UNKNOWN");
      expect(delivery.send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((await store.orders(buyer)).outgoing)).not.toContain("SECRET");
    } finally {
      outer.release();
    }
  });
  it("requires the supplier's current revision for a single accept/reject response", async () => {
    const order = await store.submit(buyer, input, "action");
    const response = { orderId: order.order_id, revision: 0, decision: "ACCEPTED" as const };
    await expect(store.respond(buyer, response)).rejects.toThrow("unavailable");
    await expect(store.respond(supplier, { ...response, revision: 1 })).rejects.toThrow(
      "unavailable"
    );
    expect((await store.respond(supplier, response)).status).toBe("ACCEPTED");
    await expect(store.respond(supplier, { ...response, decision: "REJECTED" })).rejects.toThrow(
      "already answered"
    );
  });
  it("cascades native draft and receiver deletion without leaving inbox records", async () => {
    await store.submit(buyer, input, "action");
    await pool.query("delete from cp2_businesses where entity_id='supplier'");
    expect((await store.orders(buyer)).outgoing).toEqual([]);
    await pool.query("insert into cp2_businesses values ('supplier','{}')");
    await store.submit(buyer, input, "action2");
    await pool.query("delete from business_purchase_drafts");
    expect((await store.orders(supplier)).incoming).toEqual([]);
  });
});
