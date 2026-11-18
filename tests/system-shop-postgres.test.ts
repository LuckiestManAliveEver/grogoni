import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import { deleteLiveFixtureAccounts } from "../scripts/live-fixture-cleanup.mjs";
import { seedCatalogue } from "../services/api/src/cp2/domains/catalogue-sharing/seed-catalogue";
import {
  systemShop,
  systemShopProductId
} from "../services/api/src/cp2/domains/system-shop/catalogue";
import {
  createEdgeSnapshotScope,
  prepareEdgeHydration,
  systemShopProvisionPath
} from "../services/api/src/cp2/edge-snapshot-scope";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createCp2Store } from "../services/api/src/cp2/store";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("Jane's Shop on PostgreSQL (Edge scoping)", () => {
  it("provisions once through an Edge-scoped marketplace request and sells as the operator", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Other PostgreSQL tests in the lane (and Edge routes they drive) provision and commit
      // Jane's Shop in the shared database. Remove it inside this rollback-only transaction, under
      // the same lock the Edge system-shop test takes, so this test starts from "never
      // provisioned" without changing what any other test sees.
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      for (const sql of [
        "delete from payments where business_id = $1",
        "delete from invoice_items where invoice_id in (select id from invoices where business_id = $1)",
        "delete from invoices where business_id = $1",
        "delete from invoice_number_counters where business_id = $1",
        "delete from inventory_movements where business_id = $1"
      ])
        await client.query(sql, [systemShop.businessId]);
      await deleteLiveFixtureAccounts(client, {
        accountIds: [systemShop.accountId],
        businessIds: [systemShop.businessId]
      });
      // Fixture isolation: this rollback-only transaction must start without the shop.
      const existing = await client.query(
        "select 1 from businesses where id = $1 or grogoni_id = $2",
        [systemShop.businessId, systemShop.grogoniId]
      );
      expect(existing.rowCount, "test database already holds Jane's Shop").toBe(0);

      const marketplaceRequest = () =>
        new Request(`https://edge.internal${systemShopProvisionPath}`, { method: "POST" });
      const scope = await createEdgeSnapshotScope(
        client,
        marketplaceRequest(),
        systemShopProvisionPath
      );
      expect(scope.systemShopInScope).toBe(true);

      // First marketplace request: absent in scope, so provisioning creates it.
      const loaded = await loadTransactionalCp2Snapshot(client, scope);
      const first = createCp2Store();
      first.hydrateSnapshot(prepareEdgeHydration(loaded));
      expect(first.provisionSystemShop().status).toBe("provisioned");
      await saveTransactionalCp2Snapshot(client, first.snapshot(), loaded);

      const rows = await client.query<{ count: string }>(
        "select count(*) from products where business_id = $1",
        [systemShop.businessId]
      );
      expect(Number(rows.rows[0]!.count)).toBe(seedCatalogue.products.length);

      // Next marketplace request: present in scope, so provisioning is a no-op and writes nothing.
      const scopeAgain = await createEdgeSnapshotScope(
        client,
        marketplaceRequest(),
        systemShopProvisionPath
      );
      const reloaded = await loadTransactionalCp2Snapshot(client, scopeAgain);
      expect(reloaded.products.filter((p) => p.businessId === systemShop.businessId)).toHaveLength(
        seedCatalogue.products.length
      );
      expect(
        reloaded.products.find((p) => p.id === systemShopProductId("nuvita-wafers"))
          ?.catalogueSource
      ).toMatchObject({ datasetId: seedCatalogue.id, sourceProductId: "nuvita-wafers" });
      const second = createCp2Store();
      second.hydrateSnapshot(prepareEdgeHydration(reloaded));
      expect(second.provisionSystemShop().status).toBe("unchanged");
      expect(second.listPublicStorefronts({ limit: 24 })[0]).toMatchObject({
        businessName: "Jane's Shop",
        pinned: true
      });

      // Marketplace routes, the public list included, never load the shop's records.
      const unrelated = await createEdgeSnapshotScope(
        client,
        new Request("https://grogoni.com/api/public/storefronts?limit=24"),
        "/public/storefronts"
      );
      expect(unrelated.systemShopInScope).toBe(false);
      const unrelatedSnapshot = await loadTransactionalCp2Snapshot(client, unrelated);
      expect(unrelatedSnapshot.products.some((p) => p.businessId === systemShop.businessId)).toBe(
        false
      );
      // Buyer search matches Jane's 713 product names, yet must not load (or lock) the shop.
      for (const query of ["nuvita", "janes", ""]) {
        const search = await createEdgeSnapshotScope(
          client,
          new Request(`https://grogoni.com/api/buy/search?query=${query}`),
          "/buy/search"
        );
        const searched = await loadTransactionalCp2Snapshot(client, search);
        expect(
          searched.businesses.some((b) => b.id === systemShop.businessId),
          query
        ).toBe(false);
        expect(
          searched.products.some((p) => p.businessId === systemShop.businessId),
          query
        ).toBe(false);
      }

      // A buyer checkout: the sale and the automatic restock reference the operator's user row.
      const full = await loadTransactionalCp2Snapshot(client);
      const shop = createCp2Store();
      shop.hydrateSnapshot(prepareEdgeHydration(full));
      const baseline = shop.snapshot();
      const buyer = shop.continueWithChannelPin({
        channel: "email",
        destination: `jane-buyer-${Date.now()}@example.invalid`,
        pin: "3927"
      });
      const productId = systemShopProductId("nuvita-wafers");
      const checkout = shop.createUnifiedCheckout({
        sessionId: buyer.session.id,
        items: [
          {
            sourceKind: "catalogue",
            sourceId: systemShop.grogoniId,
            sourceLabel: "Jane's Shop",
            title: "Nuvita Wafers",
            quantity: 95,
            agentId: systemShop.grogoniId,
            productId
          }
        ]
      });
      expect(checkout.handoffs[0]?.status).toBe("completed");
      await saveTransactionalCp2Snapshot(client, shop.snapshot(), baseline);
      const movements = await client.query<{ type: string; actor_id: string }>(
        `select record->>'type' as type, record->>'actorId' as actor_id from cp2_inventory_movements
         where record->>'productId' = $1 order by record->>'createdAt', record->>'type' desc`,
        [productId]
      );
      expect(movements.rows).toEqual([
        { type: "sale", actor_id: systemShop.userId },
        { type: "manual_adjustment", actor_id: systemShop.userId }
      ]);
      const stock = await client.query<{ quantity: string }>(
        "select quantity from products where id = $1",
        [productId]
      );
      expect(Number(stock.rows[0]!.quantity)).toBe(100);

      // Retention: a later order, more than a day on, deletes the earlier order's rows from the
      // database through the ordinary scoped persistence diff.
      const oldInvoiceId = shop
        .snapshot()
        .buyOrders!.find((o) => o.id === checkout.handoffs[0]!.orderId)!.invoiceId;
      const afterFirst = await loadTransactionalCp2Snapshot(client);
      const later = createCp2Store();
      later.hydrateSnapshot(prepareEdgeHydration(afterFirst));
      const laterBaseline = later.snapshot();
      const dayLater = new Date(Date.now() + 26 * 60 * 60 * 1000);
      const laterSession = later.continueWithChannelPin({
        channel: "email",
        destination: `jane-later-buyer-${Date.now()}@example.invalid`,
        pin: "3927",
        now: dayLater
      });
      const laterCheckout = later.createUnifiedCheckout({
        sessionId: laterSession.session.id,
        now: dayLater,
        items: [
          {
            sourceKind: "catalogue",
            sourceId: systemShop.grogoniId,
            sourceLabel: "Jane's Shop",
            title: "Nuvita Wafers",
            quantity: 1,
            agentId: systemShop.grogoniId,
            productId
          }
        ]
      });
      expect(laterCheckout.handoffs[0]?.status).toBe("completed");
      await saveTransactionalCp2Snapshot(client, later.snapshot(), laterBaseline);
      const remaining = async (sql: string, value: string) =>
        Number(
          (await client.query<{ n: string }>(`select count(*) as n from ${sql}`, [value])).rows[0]!
            .n
        );
      expect(await remaining("invoices where id = $1::uuid", oldInvoiceId)).toBe(0);
      expect(await remaining("invoice_items where invoice_id = $1::uuid", oldInvoiceId)).toBe(0);
      expect(await remaining("cp2_invoices where entity_id = $1", oldInvoiceId)).toBe(0);
      expect(await remaining("buy_orders where business_id = $1", systemShop.businessId)).toBe(1);
      expect(
        await remaining("cp2_inventory_movements where record->>'productId' = $1", productId)
      ).toBe(1);
      expect(await remaining("cp2_offline_changes where record->>'entityId' = $1", productId)).toBe(
        1
      );

      // A storefront audit event is owned through its payload, not its public-storefront actor.
      // The scoped Edge reload must see it so retention can delete it and the visitor's journal.
      const publicBaseline = later.snapshot();
      const visit = later.createPublicStorefrontSession({
        agentId: systemShop.grogoniId,
        visitorId: "retention-scope-visitor",
        now: dayLater
      });
      const publicOrder = later.createPublicOrder({
        agentId: systemShop.grogoniId,
        capabilityToken: visit.capabilityToken,
        customerName: "Retention Scope Visitor",
        phone: "+254700009114",
        note: null,
        items: [{ productId, quantity: 1 }],
        now: dayLater
      });
      await saveTransactionalCp2Snapshot(client, later.snapshot(), publicBaseline);
      const scoped = await loadTransactionalCp2Snapshot(client, scopeAgain);
      const publicEvent = scoped.auditEvents.find(
        (event) =>
          event.type === "storefront.order_requested" && event.aggregateId === publicOrder.id
      );
      expect(publicEvent).toBeDefined();
      expect(scoped.offlineChanges?.some((change) => change.entityId === publicOrder.id)).toBe(
        true
      );
      const cleanup = createCp2Store();
      cleanup.hydrateSnapshot(prepareEdgeHydration(scoped));
      const cleanupBaseline = cleanup.snapshot();
      cleanup.provisionSystemShop(new Date(dayLater.getTime() + 26 * 60 * 60 * 1000));
      await saveTransactionalCp2Snapshot(client, cleanup.snapshot(), cleanupBaseline);
      expect(await remaining("cp2_audit_events where entity_id = $1", publicEvent!.id)).toBe(0);
      expect(
        await remaining("cp2_offline_changes where record->>'entityId' = $1", publicOrder.id)
      ).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  }, 120_000);
});
