/**
 * Corridor fulfillment Phase 1a against real PostgreSQL (A18). Skipped unless
 * CP2_POSTGRES_TEST_DATABASE_URL points at a database migrated with `pnpm db:migrate`.
 * Every test uses fresh businesses, and the migration test runs inside a transaction it rolls
 * back, so the shared database is left exactly as it was found.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Pool as PgPool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import { createCp2Store, type Cp2Store } from "../services/api/src/cp2/store";
import {
  createPostgresFulfillmentService,
  fulfillmentDepsFromStore,
  type FulfillmentService
} from "../services/api/src/cp2/domains/fulfillment/service";
import {
  addMember,
  confirmInvoice,
  createCustomer,
  createOwner,
  createProduct,
  ok,
  request,
  signUp,
  withMigrationsReversed,
  type TestApp
} from "./fixtures/fulfillment-test-helpers";

// `pg` is a dependency of services/api, not the workspace root (same as the other PG tests).
const { Pool } = createRequire(resolve(process.cwd(), "services/api/package.json"))("pg") as {
  Pool: new (options: { connectionString: string }) => PgPool;
};
type Pool = PgPool;

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const policyBody = {
  name: "Thika Road",
  targetLoadGrams: "6000000",
  minimumDispatchLoadGrams: null,
  maxDiversionMeters: 2000,
  cutoffLocalTime: "18:00",
  maxWaitHours: 72,
  fulfillmentLeadDays: 1,
  underThresholdFallback: ["TRY_SMALLER_VEHICLE", "REQUIRE_DISPATCH_APPROVAL"],
  overflowStrategy: "NEXT_MANIFEST"
};

describePostgres("corridor fulfillment Phase 1a on PostgreSQL", () => {
  let pool: Pool;
  let store: Cp2Store;
  let service: FulfillmentService;
  let app: TestApp;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl ?? "" });
  });

  // A fresh store and app per test: auth signup is rate-limited per app instance, and each test
  // should see only the businesses it created.
  beforeEach(() => {
    store = createCp2Store();
    service = createPostgresFulfillmentService({
      pool,
      deps: fulfillmentDepsFromStore(store)
    });
    app = buildApi({ cp2: { store, fulfillmentService: service } });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  const url = (businessId: string, path: string) => `/businesses/${businessId}/fulfillment/${path}`;

  describe("vehicles (A7)", () => {
    it("creates, lists, updates and deactivates business-scoped vehicles with BIGINT capacity", async () => {
      const owner = await createOwner(app);
      const truck = await ok<{ id: string; capacityGrams: string; active: boolean }>(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        { name: "Isuzu FRR", registration: "KDA 123A", capacityGrams: "7000000" }
      );
      expect(truck).toMatchObject({ capacityGrams: "7000000", active: true });

      const beyondSafeInteger = "9007199254740993000";
      const updated = await ok<{ capacityGrams: string; active: boolean }>(
        app,
        "PATCH",
        url(owner.businessId, `vehicles/${truck.id}`),
        owner.cookie,
        { capacityGrams: beyondSafeInteger, active: false }
      );
      expect(updated).toMatchObject({ capacityGrams: beyondSafeInteger, active: false });
      expect(await ok(app, "GET", url(owner.businessId, "vehicles"), owner.cookie)).toEqual([]);
      const all = await ok<Array<{ id: string }>>(
        app,
        "GET",
        url(owner.businessId, "vehicles?include=inactive"),
        owner.cookie
      );
      expect(all.map((vehicle) => vehicle.id)).toEqual([truck.id]);

      for (const capacityGrams of ["0", "-1", 7000000, "7e6"]) {
        const response = await request(
          app,
          "POST",
          url(owner.businessId, "vehicles"),
          owner.cookie,
          {
            name: "Bad truck",
            capacityGrams
          }
        );
        expect(response.status).toBe(400);
      }
      const duplicate = await request<{ code: string }>(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        { name: "Second truck", registration: "kda 123a", capacityGrams: "5000000" }
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe("vehicle_registration_taken");
    });

    it("isolates vehicles per business and enforces fulfillment:manage", async () => {
      const owner = await createOwner(app, "Wholesaler A");
      const other = await createOwner(app, "Wholesaler B");
      const truck = await ok<{ id: string }>(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        {
          name: "Canter",
          capacityGrams: "3000000"
        }
      );
      expect(
        (await request(app, "GET", url(owner.businessId, "vehicles"), other.cookie)).status
      ).toBe(403);
      // Addressing another tenant's vehicle through one's own business is indistinguishable from
      // a vehicle that does not exist.
      const foreign = await request(
        app,
        "PATCH",
        url(other.businessId, `vehicles/${truck.id}`),
        other.cookie,
        { active: false }
      );
      expect(foreign.status).toBe(404);

      const dispatcher = await signUp(app);
      addMember(store, owner.businessId, dispatcher.userId, "manager");
      expect(
        (await request(app, "GET", url(owner.businessId, "vehicles"), dispatcher.cookie)).status
      ).toBe(200);
      const denied = await request(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        dispatcher.cookie,
        {
          name: "Unauthorized truck",
          capacityGrams: "1000"
        }
      );
      expect(denied.status).toBe(403);
    });
  });

  describe("dispatch policies (A9/A10)", () => {
    it("versions policies immutably and resolves the business default", async () => {
      const owner = await createOwner(app);
      expect(await ok(app, "GET", url(owner.businessId, "default-policy"), owner.cookie)).toEqual({
        businessId: owner.businessId,
        defaultPolicyId: null,
        policy: null
      });
      const v1 = await ok<{
        id: string;
        policyId: string;
        version: number;
        isBusinessDefault: boolean;
      }>(app, "POST", url(owner.businessId, "policies"), owner.cookie, {
        ...policyBody,
        makeBusinessDefault: true
      });
      expect(v1).toMatchObject({ version: 1, isBusinessDefault: true, targetLoadGrams: "6000000" });

      const v2 = await ok<{ id: string; version: number; minimumDispatchLoadGrams: string | null }>(
        app,
        "POST",
        url(owner.businessId, `policies/${v1.policyId}/revisions`),
        owner.cookie,
        { ...policyBody, minimumDispatchLoadGrams: "4000000" }
      );
      expect(v2).toMatchObject({ version: 2, minimumDispatchLoadGrams: "4000000" });

      const effective = await ok<{ policy: { id: string; version: number } }>(
        app,
        "GET",
        url(owner.businessId, "default-policy"),
        owner.cookie
      );
      expect(effective.policy).toMatchObject({ id: v2.id, version: 2 });

      const history = await ok<
        Array<{
          id: string;
          version: number;
          active: boolean;
          targetLoadGrams: string;
          minimumDispatchLoadGrams: string | null;
        }>
      >(app, "GET", url(owner.businessId, "policies?include=history"), owner.cookie);
      // Version 1 is still readable exactly as it was created.
      expect(history.map((row) => [row.version, row.active, row.minimumDispatchLoadGrams])).toEqual(
        [
          [2, true, "4000000"],
          [1, false, null]
        ]
      );
    });

    it("rejects minimum above target at the API and the database", async () => {
      const owner = await createOwner(app);
      const rejected = await request(app, "POST", url(owner.businessId, "policies"), owner.cookie, {
        ...policyBody,
        minimumDispatchLoadGrams: "6000001"
      });
      expect(rejected.status).toBe(400);
      await expect(
        pool.query(
          `
            insert into fulfillment_dispatch_policies
              (id, policy_id, business_id, version, name, target_load_grams, minimum_dispatch_load_grams,
               max_diversion_meters, cutoff_local_time, max_wait_hours, fulfillment_lead_days,
               overflow_strategy, active, created_by, created_at)
            values ($1, $2, $3, 1, 'x', 100, 101, 1, '18:00', 1, 0, 'NEXT_MANIFEST', true, 'test', now())
          `,
          [randomUUID(), randomUUID(), owner.businessId]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("serializes concurrent revisions so exactly one active version survives", async () => {
      const owner = await createOwner(app);
      const v1 = await ok<{ policyId: string }>(
        app,
        "POST",
        url(owner.businessId, "policies"),
        owner.cookie,
        policyBody
      );
      const results = await Promise.all(
        [1, 2, 3].map((index) =>
          request<{ version?: number }>(
            app,
            "POST",
            url(owner.businessId, `policies/${v1.policyId}/revisions`),
            owner.cookie,
            { ...policyBody, maxDiversionMeters: 1000 + index }
          )
        )
      );
      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(results.map((result) => result.body.version).sort()).toEqual([2, 3, 4]);
      const active = await pool.query(
        "select version from fulfillment_dispatch_policies where policy_id = $1 and active",
        [v1.policyId]
      );
      expect(active.rows).toEqual([{ version: 4 }]);
    });
  });

  describe("idempotency (A23)", () => {
    it("replays the stored response for the same key and payload with one mutation", async () => {
      const owner = await createOwner(app);
      const headers = { "idempotency-key": "create-truck-1" };
      const body = { name: "Isuzu NQR", capacityGrams: "5000000" };
      const first = await ok<{ id: string }>(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        body,
        headers
      );
      const second = await ok<{ id: string }>(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        body,
        headers
      );
      expect(second).toEqual(first);
      const rows = await pool.query("select id from fulfillment_vehicles where business_id = $1", [
        owner.businessId
      ]);
      expect(rows.rows).toHaveLength(1);

      const conflict = await request<{ code: string }>(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        { ...body, capacityGrams: "5000001" },
        headers
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe("idempotency_key_reused");
    });

    it("does not collide across businesses using the same key", async () => {
      const a = await createOwner(app);
      const b = await createOwner(app);
      const headers = { "idempotency-key": "shared-key" };
      const body = { name: "Truck", capacityGrams: "1000000" };
      const fromA = await ok<{ id: string; businessId: string }>(
        app,
        "POST",
        url(a.businessId, "vehicles"),
        a.cookie,
        body,
        headers
      );
      const fromB = await ok<{ id: string; businessId: string }>(
        app,
        "POST",
        url(b.businessId, "vehicles"),
        b.cookie,
        body,
        headers
      );
      expect(fromA.id).not.toBe(fromB.id);
      expect([fromA.businessId, fromB.businessId]).toEqual([a.businessId, b.businessId]);
    });

    it("resolves concurrent identical requests to exactly one logical mutation", async () => {
      const owner = await createOwner(app);
      const headers = { "idempotency-key": "race-key" };
      const body = { name: "Race truck", capacityGrams: "2000000" };
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          request<{ id: string }>(
            app,
            "POST",
            url(owner.businessId, "vehicles"),
            owner.cookie,
            body,
            headers
          )
        )
      );
      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
      const rows = await pool.query("select id from fulfillment_vehicles where business_id = $1", [
        owner.businessId
      ]);
      expect(rows.rows).toHaveLength(1);
    });

    it("rejects concurrent same-key requests with different bodies without a second mutation", async () => {
      const owner = await createOwner(app);
      const headers = { "idempotency-key": "race-conflict" };
      const results = await Promise.all(
        ["1000000", "2000000"].map((capacityGrams) =>
          request(
            app,
            "POST",
            url(owner.businessId, "vehicles"),
            owner.cookie,
            { name: "Truck", capacityGrams },
            headers
          )
        )
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const rows = await pool.query("select id from fulfillment_vehicles where business_id = $1", [
        owner.businessId
      ]);
      expect(rows.rows).toHaveLength(1);
    });

    it("purges records only after the configured retention, never under 24 hours", async () => {
      const owner = await createOwner(app);
      await ok(
        app,
        "POST",
        url(owner.businessId, "vehicles"),
        owner.cookie,
        { name: "T", capacityGrams: "1" },
        {
          "idempotency-key": "retention-key"
        }
      );
      const count = async () =>
        (
          await pool.query("select 1 from fulfillment_idempotency_records where business_id = $1", [
            owner.businessId
          ])
        ).rows.length;
      await service.purgeExpiredIdempotencyRecords({ now: new Date(Date.now() + 23 * 3_600_000) });
      expect(await count()).toBe(1);
      await expect(service.purgeExpiredIdempotencyRecords({ retentionHours: 1 })).rejects.toThrow(
        /24 hours/u
      );
      await service.purgeExpiredIdempotencyRecords({ now: new Date(Date.now() + 25 * 3_600_000) });
      expect(await count()).toBe(0);
    });
  });

  describe("shop locations (A6)", () => {
    it("captures, updates with history, and redacts precise coordinates by permission", async () => {
      const owner = await createOwner(app);
      const shop = await createCustomer(app, owner);
      const locationUrl = url(owner.businessId, `shops/${shop.id}/location`);
      expect(await ok(app, "GET", locationUrl, owner.cookie)).toMatchObject({
        locationStatus: "UNRESOLVED",
        current: null
      });

      const salesperson = await signUp(app);
      addMember(store, owner.businessId, salesperson.userId, "sales_agent");
      const captured = await ok<{
        locationStatus: string;
        coordinatesRedacted: boolean;
        current: Record<string, unknown>;
      }>(app, "PUT", locationUrl, salesperson.cookie, {
        latitude: -1.0332116,
        longitude: 37.0692931,
        accuracyMeters: 12.4
      });
      // A salesperson may capture but not read back precise coordinates.
      expect(captured).toMatchObject({
        locationStatus: "RESOLVED",
        coordinatesRedacted: true,
        current: { latitude: null, longitude: null, capturedBy: salesperson.userId }
      });
      const precise = await ok<{
        current: { latitude: number; longitude: number; accuracyMeters: number };
      }>(app, "GET", locationUrl, owner.cookie);
      expect(precise.current).toMatchObject({
        latitude: -1.033212,
        longitude: 37.069293,
        accuracyMeters: 12
      });

      await ok(app, "PUT", locationUrl, owner.cookie, { latitude: -1.04, longitude: 37.08 });
      const history = await ok<Array<{ latitude: number; supersededAt: string | null }>>(
        app,
        "GET",
        `${locationUrl}/history`,
        owner.cookie
      );
      expect(history.map((entry) => [entry.latitude, entry.supersededAt === null])).toEqual([
        [-1.04, true],
        [-1.033212, false]
      ]);
      expect((await request(app, "GET", `${locationUrl}/history`, salesperson.cookie)).status).toBe(
        403
      );
    });

    it("rejects invalid coordinates, foreign shops and unauthorized roles", async () => {
      const owner = await createOwner(app);
      const other = await createOwner(app);
      const shop = await createCustomer(app, owner);
      const locationUrl = url(owner.businessId, `shops/${shop.id}/location`);
      for (const coordinates of [
        { latitude: 91, longitude: 0 },
        { latitude: 0, longitude: -181 },
        { latitude: "north", longitude: 0 }
      ]) {
        expect((await request(app, "PUT", locationUrl, owner.cookie, coordinates)).status).toBe(
          400
        );
      }
      expect((await request(app, "GET", locationUrl, other.cookie)).status).toBe(403);
      expect(
        (
          await request(
            app,
            "GET",
            url(other.businessId, `shops/${shop.id}/location`),
            other.cookie
          )
        ).status
      ).toBe(404);
      const cashier = await signUp(app);
      addMember(store, owner.businessId, cashier.userId, "cashier");
      expect(
        (await request(app, "PUT", locationUrl, cashier.cookie, { latitude: 1, longitude: 1 }))
          .status
      ).toBe(403);
    });

    it("keeps exactly one current location under concurrent captures", async () => {
      const owner = await createOwner(app);
      const shop = await createCustomer(app, owner);
      const locationUrl = url(owner.businessId, `shops/${shop.id}/location`);
      const results = await Promise.all(
        [1, 2, 3, 4].map((index) =>
          request(app, "PUT", locationUrl, owner.cookie, { latitude: index / 10, longitude: 36.8 })
        )
      );
      expect(results.every((result) => result.status === 200)).toBe(true);
      const rows = await pool.query(
        "select superseded_at from fulfillment_shop_locations where business_id = $1 and customer_id = $2",
        [owner.businessId, shop.id]
      );
      expect(rows.rows).toHaveLength(4);
      expect(rows.rows.filter((row) => row.superseded_at === null)).toHaveLength(1);
    });

    it("timestamps a capture after waiting for the shop-location lock", async () => {
      const owner = await createOwner(app);
      const shop = await createCustomer(app, owner);
      const lockClient = await pool.connect();
      let pendingCapture: ReturnType<typeof request>;
      let seededAt: Date;
      try {
        await lockClient.query("begin");
        await lockClient.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `grogoni.fulfillment.shop_location:${owner.businessId}:${shop.id}`
        ]);

        pendingCapture = request(
          app,
          "PUT",
          url(owner.businessId, `shops/${shop.id}/location`),
          owner.cookie,
          { latitude: -1.286389, longitude: 36.817223 }
        );
        let captureIsWaiting = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await pool.query(
            `
              select 1 from pg_stat_activity
              where wait_event = 'advisory'
                and query like 'select pg_advisory_xact_lock%'
              limit 1
            `
          );
          if (waiting.rowCount !== null && waiting.rowCount > 0) {
            captureIsWaiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(captureIsWaiting).toBe(true);
        seededAt = new Date();
        await pool.query(
          `
            insert into fulfillment_shop_locations
              (id, business_id, customer_id, latitude, longitude, captured_at, captured_by, created_at)
            values ($1, $2, $3, 0, 0, $4, 'test', $4)
          `,
          [randomUUID(), owner.businessId, shop.id, seededAt]
        );
        await lockClient.query("commit");
      } finally {
        await lockClient.query("rollback").catch(() => undefined);
        lockClient.release();
      }

      const result = await pendingCapture;
      expect(result.status, result.body).toBe(200);
      const rows = await pool.query<{ captured_at: Date; superseded_at: Date | null }>(
        `
          select captured_at, superseded_at from fulfillment_shop_locations
          where business_id = $1 and customer_id = $2
          order by captured_at
        `,
        [owner.businessId, shop.id]
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.superseded_at?.getTime()).toBeGreaterThanOrEqual(seededAt.getTime());
      expect(rows.rows.filter((row) => row.superseded_at === null)).toHaveLength(1);
    });

    it("enforces one current location in the database itself", async () => {
      const businessId = randomUUID();
      const customerId = randomUUID();
      const insert = () =>
        pool.query(
          `
            insert into fulfillment_shop_locations
              (id, business_id, customer_id, latitude, longitude, captured_at, captured_by, created_at)
            values ($1, $2, $3, 0, 0, now(), 'test', now())
          `,
          [randomUUID(), businessId, customerId]
        );
      await insert();
      await expect(insert()).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          `insert into fulfillment_vehicles (id, business_id, name, capacity_grams, created_by, created_at, updated_at)
           values ($1, $2, 'x', 0, 'test', now(), now())`,
          [randomUUID(), businessId]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("persistence through the Cp2Store snapshot (089)", () => {
    it("persists product weight, fieldValues, line snapshots and timezone across a restart", async () => {
      const connectionString = databaseUrl ?? "";
      const first = await createPostgresCp2Store({ databaseUrl: connectionString });
      const firstApp = buildApi({
        cp2: { store: first },
        mutationPersistenceFlush: () => first.flush()
      });
      const owner = await createOwner(firstApp);
      const sack = await createProduct(firstApp, owner, {
        name: "Maize sack",
        unitWeightGrams: "90000",
        fieldValues: { grade: "A" }
      });
      const loose = await createProduct(firstApp, owner, { name: "Loose onions" });
      const { invoice } = await confirmInvoice(firstApp, owner, {
        items: [
          { productId: sack.id, quantity: 3 },
          { productId: loose.id, quantity: 1 }
        ]
      });
      await ok(
        firstApp,
        "PATCH",
        `/businesses/${owner.businessId}/fulfillment/settings`,
        owner.cookie,
        {
          timezone: "Africa/Nairobi"
        }
      );
      await first.flush();
      await firstApp.close();

      const restored = await createPostgresCp2Store({ databaseUrl: connectionString });
      const restoredApp = buildApi({ cp2: { store: restored } });
      const products = await ok<
        Array<{ id: string; unitWeightGrams: string | null; fieldValues?: Record<string, string> }>
      >(restoredApp, "GET", `/businesses/${owner.businessId}/products`, owner.cookie);
      const restoredSack = products.find((product) => product.id === sack.id);
      expect(restoredSack?.unitWeightGrams).toBe("90000");
      expect(restoredSack?.fieldValues).toEqual({ grade: "A" });
      expect(products.find((product) => product.id === loose.id)?.unitWeightGrams).toBeNull();
      expect(
        await ok(
          restoredApp,
          "GET",
          `/businesses/${owner.businessId}/invoices/${invoice.id}/fulfillment-weight`,
          owner.cookie
        )
      ).toEqual({
        status: "UNRESOLVED",
        unresolvedLineIds: [invoice.items[1]?.id],
        unresolvedLines: [{ lineId: invoice.items[1]?.id, reason: "MISSING_UNIT_WEIGHT" }]
      });
      const line = await pool.query(
        "select unit_weight_grams_snapshot, total_weight_grams, weight_status from invoice_items where id = $1",
        [invoice.items[0]?.id]
      );
      expect(line.rows[0]).toEqual({
        unit_weight_grams_snapshot: "90000",
        total_weight_grams: "270000",
        weight_status: "RESOLVED"
      });
      expect(
        await ok(
          restoredApp,
          "GET",
          `/businesses/${owner.businessId}/fulfillment/settings`,
          owner.cookie
        )
      ).toEqual({
        businessId: owner.businessId,
        timezone: "Africa/Nairobi",
        viewerCanManage: true
      });
      await restoredApp.close();
    }, 30_000);
  });

  describe("business purge (D10)", () => {
    it("deletes a purged business's fulfillment rows with it and leaves other tenants alone", async () => {
      const connectionString = databaseUrl ?? "";
      const pgStore = await createPostgresCp2Store({ databaseUrl: connectionString });
      const pgService = createPostgresFulfillmentService({
        pool,
        deps: fulfillmentDepsFromStore(pgStore)
      });
      const pgApp = buildApi({
        cp2: { store: pgStore, fulfillmentService: pgService },
        mutationPersistenceFlush: () => pgStore.flush()
      });
      const purged = await createOwner(pgApp, "Closing wholesaler");
      const kept = await createOwner(pgApp, "Continuing wholesaler");
      for (const owner of [purged, kept]) {
        await ok(
          pgApp,
          "POST",
          url(owner.businessId, "vehicles"),
          owner.cookie,
          {
            name: "Truck",
            capacityGrams: "7000000"
          },
          { "idempotency-key": "purge-test" }
        );
        await ok(pgApp, "POST", url(owner.businessId, "policies"), owner.cookie, {
          ...policyBody,
          makeBusinessDefault: true
        });
      }
      await pgStore.flush();
      // Phase 1b rows for the purged business (inserted directly: the store holds no shop or
      // invoice for it, so purging only the business keeps the snapshot consistent).
      const corridorId = randomUUID();
      const orderId = randomUUID();
      const locationId = randomUUID();
      const resolutionId = randomUUID();
      const line = JSON.stringify({
        type: "LineString",
        coordinates: [
          [36.8, -1.3],
          [36.8, -1.2]
        ]
      });
      await pool.query(
        `insert into fulfillment_corridors (id, business_id, name, origin_label, destination_label,
           route_geometry, distance_meters, created_by, created_at, updated_at)
         values ($1, $2, 'C', 'A', 'B', $3::jsonb, 11119.5, 'test', now(), now())`,
        [corridorId, purged.businessId, line]
      );
      await pool.query(
        `insert into fulfillment_corridor_geometry_versions
           (business_id, corridor_id, version, route_geometry, distance_meters, created_by, created_at)
         values ($1, $2, 1, $3::jsonb, 11119.5, 'test', now())`,
        [purged.businessId, corridorId, line]
      );
      await pool.query(
        `insert into fulfillment_shop_locations
           (id, business_id, customer_id, latitude, longitude, captured_at, captured_by, created_at)
         values ($1, $2, $3, -1.25, 36.8, now(), 'test', now())`,
        [locationId, purged.businessId, randomUUID()]
      );
      await pool.query(
        `insert into fulfillment_orders (id, business_id, invoice_id, confirmed_at, created_at)
         values ($1, $2, $3, now(), now())`,
        [orderId, purged.businessId, randomUUID()]
      );
      await pool.query(
        `insert into fulfillment_corridor_resolutions
           (id, business_id, fulfillment_order_id, corridor_id, corridor_geometry_version,
            shop_location_id, diversion_meters, distance_along_meters, segment_index,
            max_diversion_meters, resolution_method, resolved_by, resolved_at)
         values ($1, $2, $3, $4, 1, $5, 0, 5559.7, 0, 2000, 'AUTO', 'test', now())`,
        [resolutionId, purged.businessId, orderId, corridorId, locationId]
      );
      // Phase 1c: a manifest with one stop, so purge must delete stops before orders.
      const manifestId = randomUUID();
      const references = await pool.query<{
        vehicle_id: string;
        policy_row: string;
        policy_id: string;
      }>(
        `select v.id as vehicle_id, p.id as policy_row, p.policy_id
         from fulfillment_vehicles v, fulfillment_dispatch_policies p
         where v.business_id = $1 and p.business_id = $1`,
        [purged.businessId]
      );
      const reference = references.rows[0]!;
      await pool.query(
        `insert into fulfillment_manifests
           (id, business_id, corridor_id, corridor_geometry_version, policy_version_id, policy_id,
            policy_version, vehicle_id, vehicle_capacity_grams, status, total_weight_grams,
            created_by, created_at, updated_at)
         values ($1, $2, $3, 1, $4, $5, 1, $6, 7000000, 'OPEN', 1000, 'test', now(), now())`,
        [
          manifestId,
          purged.businessId,
          corridorId,
          reference.policy_row,
          reference.policy_id,
          reference.vehicle_id
        ]
      );
      await pool.query(
        `insert into fulfillment_manifest_stops
           (id, business_id, manifest_id, fulfillment_order_id, invoice_id, corridor_resolution_id,
            shop_location_id, sequence, distance_along_meters, diversion_meters, latitude, longitude,
            order_weight_grams, allocation_active, delivery_status, created_at, updated_at)
         select $1, $2, $3, o.id, o.invoice_id, $4, $5, 1, 5559.7, 0, -1.25, 36.8, 1000, true,
                'PENDING', now(), now()
         from fulfillment_orders o where o.id = $6`,
        [randomUUID(), purged.businessId, manifestId, resolutionId, locationId, orderId]
      );

      const snapshot = pgStore.snapshot();
      pgStore.hydrateSnapshot({
        ...snapshot,
        businesses: snapshot.businesses.filter((business) => business.id !== purged.businessId),
        memberships: snapshot.memberships.filter(
          (membership) => membership.businessId !== purged.businessId
        )
      });
      // Any store mutation (even a rejected one) queues a snapshot save; that save purges.
      expect(() =>
        pgStore.updateBusinessTimezone({
          sessionId: null,
          businessId: kept.businessId,
          timezone: "UTC"
        })
      ).toThrow();
      await pgStore.flush();

      const remaining = async (businessId: string) =>
        (
          await pool.query(
            `select
               (select count(*) from fulfillment_vehicles where business_id = $1)::int as vehicles,
               (select count(*) from fulfillment_dispatch_policies where business_id = $1)::int as policies,
               (select count(*) from fulfillment_business_settings where business_id = $1)::int as settings,
               (select count(*) from fulfillment_idempotency_records where business_id = $1)::int as keys,
               (select count(*) from fulfillment_corridors where business_id = $1)::int as corridors,
               (select count(*) from fulfillment_orders where business_id = $1)::int as orders,
               (select count(*) from fulfillment_corridor_resolutions where business_id = $1)::int as resolutions,
               (select count(*) from fulfillment_manifests where business_id = $1)::int as manifests,
               (select count(*) from fulfillment_manifest_stops where business_id = $1)::int as stops`,
            [businessId]
          )
        ).rows[0];
      expect(await remaining(purged.businessId)).toEqual({
        vehicles: 0,
        policies: 0,
        settings: 0,
        keys: 0,
        corridors: 0,
        orders: 0,
        resolutions: 0,
        manifests: 0,
        stops: 0
      });
      expect(await remaining(kept.businessId)).toEqual({
        vehicles: 1,
        policies: 1,
        settings: 1,
        keys: 1,
        corridors: 0,
        orders: 0,
        resolutions: 0,
        manifests: 0,
        stops: 0
      });
      await pgApp.close();
    }, 30_000);
  });

  describe("migrations 089/090", () => {
    it("reverse and re-apply cleanly over historical data without inventing weight or location", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const businessId = randomUUID();
        const productId = randomUUID();
        const invoiceId = randomUUID();
        await client.query(
          "insert into businesses (id, name, language, created_at) values ($1, 'Historical', 'en', now())",
          [businessId]
        );
        await client.query(
          `insert into products (id, business_id, name, unit, quantity, created_at, updated_at)
           values ($1, $2, 'Old sack', 'sack', 5, now(), now())`,
          [productId, businessId]
        );
        await client.query(
          `insert into invoices (id, business_id, invoice_number, status, subtotal, tax_rate, tax_total, total, confirmed_at, created_at, updated_at)
           values ($1, $2, 'INV-OLD', 'confirmed', 100, 0, 0, 100, now(), now(), now())`,
          [invoiceId, businessId]
        );
        await client.query(
          `insert into invoice_items (id, invoice_id, product_id, product_name, quantity, unit_price, line_total)
           values ($1, $2, $3, 'Old sack', 2, 50, 100)`,
          [randomUUID(), invoiceId, productId]
        );

        // Unwind 089 and everything after it in reverse, like db:rollback, then re-apply.
        await withMigrationsReversed(client, "089", async () => {
          const afterDown = await client.query(
            `select column_name from information_schema.columns
             where table_schema = 'public' and table_name in ('products', 'invoice_items', 'businesses')
               and column_name in ('unit_weight_grams', 'total_weight_grams', 'timezone')`
          );
          expect(afterDown.rows).toEqual([]);
          const tables = await client.query("select to_regclass('fulfillment_vehicles') as name");
          expect(tables.rows[0]).toEqual({ name: null });
        });
        const historical = await client.query(
          `select p.unit_weight_grams, i.weight_status, i.total_weight_grams, b.timezone
           from products p
           join invoice_items i on i.product_id = p.id
           join businesses b on b.id = p.business_id
           where p.id = $1`,
          [productId]
        );
        expect(historical.rows).toEqual([
          { unit_weight_grams: null, weight_status: null, total_weight_grams: null, timezone: null }
        ]);
        const locations = await client.query(
          "select count(*)::int as count from fulfillment_shop_locations where business_id = $1",
          [businessId]
        );
        expect(locations.rows[0]).toEqual({ count: 0 });

        await client.query("savepoint zero_weight");
        await expect(
          client.query("update products set unit_weight_grams = 0 where id = $1", [productId])
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("rollback to savepoint zero_weight");
        await expect(
          client.query(
            "update invoice_items set weight_status = 'RESOLVED' where product_id = $1",
            [productId]
          )
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await client.query("rollback");
        client.release();
      }
    });
  });
});
