import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { deleteLiveFixtureAccounts } from "../scripts/live-fixture-cleanup.mjs";
import type { UnifiedCheckoutSummary } from "../packages/shared-types/src";
import { seedCatalogue } from "../services/api/src/cp2/domains/catalogue-sharing/seed-catalogue";
import {
  systemShop,
  systemShopProductId
} from "../services/api/src/cp2/domains/system-shop/catalogue";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";
import { createPublicRoutes } from "../supabase/functions/api/public-routes";
import type { Transaction } from "../supabase/functions/api/session-routes";

// No model runs here; provisioning and order completion are deterministic.
vi.mock("../services/api/src/edge-store-dependencies", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeStoreDependencies: () => ({})
}));

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

/**
 * The production path end to end on a real database: two Edge isolates provision Jane's Shop at
 * the same time through the dedicated transaction, the Deno `/public/storefronts` SQL route lists
 * it pinned first, and a buyer's checkout through the Edge dispatcher completes and restocks.
 * Commits for real (the Edge runtime opens its own transactions), so it cleans up after itself.
 */
describe.skipIf(!databaseUrl)("Jane's Shop through the Edge runtime on PostgreSQL", () => {
  it("provisions once under concurrency, lists pinned, and completes a checkout", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
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
    const buyerAccountIds: string[] = [];
    const cleanup = () =>
      transaction(async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))"
        );
        // Relational sales rows the shared fixture cleanup does not cover, children first.
        for (const sql of [
          "delete from payments where business_id = $1",
          "delete from invoice_items where invoice_id in (select id from invoices where business_id = $1)",
          "delete from invoices where business_id = $1",
          "delete from invoice_number_counters where business_id = $1",
          "delete from inventory_movements where business_id = $1"
        ])
          await client.query(sql, [systemShop.businessId]);
        await deleteLiveFixtureAccounts(client, {
          accountIds: [systemShop.accountId, ...buyerAccountIds],
          businessIds: [systemShop.businessId]
        });
      });
    try {
      await cleanup();
      const count = async (sql: string) =>
        Number(
          (
            await pool.query<{ n: string }>(`select count(*) as n from ${sql}`, [
              systemShop.businessId
            ])
          ).rows[0]!.n
        );

      // Two isolates, each with its own domain runtime, racing the first provisioning.
      const [isolateA, isolateB] = await Promise.all([
        createEdgeDomainRoutes({ transaction, approvalTransaction: transaction }),
        createEdgeDomainRoutes({ transaction, approvalTransaction: transaction })
      ]);
      const reports = await Promise.all([isolateA.ensureSystemShop(), isolateB.ensureSystemShop()]);
      const statuses = reports.map((report) => report?.status ?? null).sort();
      expect(statuses.filter((status) => status === "provisioned")).toHaveLength(1);
      expect(statuses.every((s) => s === "provisioned" || s === "unchanged" || s === null)).toBe(
        true
      );
      expect(await count("businesses where id = $1")).toBe(1);
      expect(await count("cp2_products where business_id = $1")).toBe(
        seedCatalogue.products.length
      );
      expect(await count("products where business_id = $1")).toBe(seedCatalogue.products.length);
      expect(await count("business_memberships where business_id = $1")).toBe(1);

      // Memoized per isolate, and a fresh isolate only runs the cheap existence query.
      expect(await isolateA.ensureSystemShop()).toBe(reports[0]);
      const isolateC = await createEdgeDomainRoutes({
        transaction,
        approvalTransaction: transaction
      });
      expect(await isolateC.ensureSystemShop()).toBeNull();
      expect(await count("cp2_agent_profiles where entity_id = $1")).toBe(1);

      // A missing piece (here the agent profile) makes the next isolate repair it.
      await pool.query("delete from cp2_agent_profiles where entity_id = $1", [
        systemShop.businessId
      ]);
      const repairing = await createEdgeDomainRoutes({
        transaction,
        approvalTransaction: transaction
      });
      expect((await repairing.ensureSystemShop())?.status).toBe("updated");
      expect(await count("cp2_agent_profiles where entity_id = $1")).toBe(1);
      expect(await count("cp2_products where business_id = $1")).toBe(
        seedCatalogue.products.length
      );

      // The production list route (raw SQL in the Deno function), with a tiny limit.
      const publicRoutes = createPublicRoutes(transaction as unknown as Transaction, {
        ensureSystemShop: () => isolateC.ensureSystemShop()
      });
      const listed = await (await publicRoutes(
        new Request("https://grogoni.com/public/storefronts?limit=1"),
        "/public/storefronts"
      ))!.json();
      expect(listed.storefronts).toHaveLength(1);
      expect(listed.storefronts[0]).toMatchObject({
        businessName: "Jane's Shop",
        commerceAddress: "janes-shop@grogoni.com",
        pinned: true,
        operatedBy: "marketplace_agent"
      });
      expect(listed.storefronts[0].products).toHaveLength(seedCatalogue.products.length);

      // Buyer search through the Edge dispatcher finds Jane from her plan (her rows unloaded).
      const searchResponse = await isolateA.routes(
        new Request("https://grogoni.com/buy/search?query=nuvita"),
        "/buy/search"
      );
      const feed = (await searchResponse!.json()) as { results: Array<{ sourceLabel: string }> };
      expect(feed.results.some((result) => result.sourceLabel === "Jane's Shop")).toBe(true);

      // A buyer checks out through the Edge dispatcher; the shop completes it in that request.
      const store = createCp2Store();
      const baseline = store.snapshot();
      const buyer = store.continueWithChannelPin({
        channel: "email",
        destination: `jane-edge-buyer-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      buyerAccountIds.push(buyer.account.id);
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const productId = systemShopProductId("nuvita-wafers");
      const body = JSON.stringify({
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
      const response = await isolateA.routes(
        new Request("https://grogoni.com/buy/checkout", {
          method: "POST",
          headers: {
            cookie: `grogoni_session=${buyer.session.id}`,
            "content-type": "application/json",
            origin: "https://grogoni.com"
          },
          body
        }),
        "/buy/checkout"
      );
      expect(response?.status, await response?.clone().text()).toBe(200);
      const checkout = (await response!.json()) as UnifiedCheckoutSummary;
      expect(checkout.handoffs).toEqual([
        expect.objectContaining({ sourceLabel: "Jane's Shop", status: "completed" })
      ]);
      const stock = await pool.query<{ quantity: string }>(
        "select quantity from products where id = $1",
        [productId]
      );
      expect(Number(stock.rows[0]!.quantity)).toBe(100);
      const movements = await pool.query<{ type: string; actor: string }>(
        `select record->>'type' as type, record->>'actorId' as actor from cp2_inventory_movements
         where record->>'productId' = $1 order by record->>'createdAt', record->>'type' desc`,
        [productId]
      );
      expect(movements.rows).toEqual([
        { type: "sale", actor: systemShop.userId },
        { type: "manual_adjustment", actor: systemShop.userId }
      ]);
    } finally {
      await cleanup().catch(() => undefined);
      await pool.end();
    }
  }, 180_000);
});
