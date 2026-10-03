/**
 * Corridor fulfillment Phase 1c against real PostgreSQL: intake, pools and readiness, A21
 * allocation, manifests, the A12 lifecycle, security, the A17 concurrency races, and the Phase 1
 * end-to-end Definition of Done. Skipped unless CP2_POSTGRES_TEST_DATABASE_URL is set.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Pool as PgPool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store, type Cp2Store } from "../services/api/src/cp2/store";
import { createChannelGatewayFromEnvironment } from "../services/api/src/messaging/channel-gateway";
import {
  createPostgresFulfillmentService,
  fulfillmentDepsFromStore,
  type FulfillmentService
} from "../services/api/src/cp2/domains/fulfillment/service";
import {
  addMember,
  confirmInvoice,
  connectMcp,
  createCustomer,
  createOwner,
  createProduct,
  ok,
  request,
  signUp,
  uniquePhone,
  withMigrationsReversed,
  type TestApp,
  type TestOwner
} from "./fixtures/fulfillment-test-helpers";

const { Pool } = createRequire(resolve(process.cwd(), "services/api/package.json"))("pg") as {
  Pool: new (options: { connectionString: string }) => PgPool;
};

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const KG = 1000;
// Corridor X: a straight north-south road (~11.1 km) along longitude 36.8.
const corridorX = {
  type: "LineString",
  coordinates: [
    [36.8, -1.3],
    [36.8, -1.2]
  ]
};
/** A shop ~110 m off Corridor X at `fraction` of the way along it. */
const alongX = (fraction: number) => ({ latitude: -1.3 + 0.1 * fraction, longitude: 36.801 });

interface PoolView {
  corridorId: string;
  eligibleOrderCount: number;
  eligibleTotalWeightGrams: string;
  allocatableWeightGrams: string;
  targetLoadGrams: string | null;
  readiness: string | null;
  needsResolution: boolean;
  unresolvedWeightCount: number;
  staleResolutionCount: number;
  percentFilled: number | null;
  timeUntilCutoffSeconds: number | null;
  oldestWaitingOrderAgeSeconds: number | null;
}

interface ManifestView {
  id: string;
  status: string;
  totalWeightGrams: string;
  vehicleCapacityGrams: string;
  corridorGeometryVersion: number;
  policyVersion: number;
  stops: Array<{
    id: string;
    invoiceId: string;
    sequence: number;
    distanceAlongMeters: number;
    latitude: number;
    longitude: number;
    orderWeightGrams: string;
    allocationActive: boolean;
    deliveryStatus: string;
  }>;
}

interface CreateManifestResult {
  manifest: ManifestView;
  allocatedInvoiceIds: string[];
  skippedInvoiceIds: string[];
  requiresPlanningInvoiceIds: string[];
}

describePostgres("corridor fulfillment Phase 1c on PostgreSQL", () => {
  let pool: PgPool;
  let store: Cp2Store;
  let service: FulfillmentService;
  let app: TestApp;
  let pendingIntakes: Array<Promise<unknown>>;
  let telegramDeliveries: string[];

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl ?? "" });
  });

  beforeEach(() => {
    telegramDeliveries = [];
    store = createCp2Store({
      channelGateway: createChannelGatewayFromEnvironment(
        {
          TELEGRAM_BOT_TOKEN: "test-token",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
          TELEGRAM_BOT_USERNAME: "grogoni_test_bot"
        },
        async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { text: string };
          telegramDeliveries.push(body.text);
          return new Response(JSON.stringify({ ok: true, result: { message_id: randomUUID() } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      )
    });
    service = createPostgresFulfillmentService({
      pool,
      deps: fulfillmentDepsFromStore(store),
      deliverOutboxEvent: (event) => store.deliverFulfillmentNotification(event)
    });
    pendingIntakes = [];
    store.setFulfillmentIntakeListener((input) => {
      const intake = service.intakeOrder(input);
      pendingIntakes.push(intake);
      return intake;
    });
    store.setMembershipChangedListener((input) => {
      const release = service.releaseDriverAssignments(input);
      pendingIntakes.push(release);
      return release;
    });
    app = buildApi({ cp2: { store, fulfillmentService: service } });
  });

  afterEach(async () => {
    await Promise.allSettled(pendingIntakes);
    await app.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  const url = (owner: TestOwner, path: string) =>
    `/businesses/${owner.businessId}/fulfillment/${path}`;

  /** Waits for the fire-and-forget intake the store hook started (microtask). */
  async function settleIntakes() {
    await new Promise((done) => setImmediate(done));
    await Promise.allSettled(pendingIntakes);
  }

  async function setupBusiness(
    options: { targetKg?: number; minimumKg?: number | null; name?: string } = {}
  ) {
    const owner = await createOwner(app, options.name ?? "Corridor Wholesale");
    await ok(app, "PATCH", url(owner, "settings"), owner.cookie, { timezone: "Africa/Nairobi" });
    await ok(app, "POST", url(owner, "policies"), owner.cookie, {
      name: "Default",
      targetLoadGrams: String((options.targetKg ?? 6000) * KG),
      minimumDispatchLoadGrams:
        options.minimumKg === undefined || options.minimumKg === null
          ? null
          : String(options.minimumKg * KG),
      maxDiversionMeters: 2000,
      cutoffLocalTime: "18:00",
      maxWaitHours: 72,
      fulfillmentLeadDays: 1,
      underThresholdFallback: [],
      overflowStrategy: "NEXT_MANIFEST",
      makeBusinessDefault: true
    });
    const corridor = await ok<{ id: string }>(app, "POST", url(owner, "corridors"), owner.cookie, {
      name: "Corridor X",
      originLabel: "Depot",
      destinationLabel: "Market",
      routeGeometry: corridorX
    });
    const vehicle = await ok<{ id: string }>(app, "POST", url(owner, "vehicles"), owner.cookie, {
      name: "7-tonne truck",
      capacityGrams: String(7000 * KG)
    });
    return { owner, corridorId: corridor.id, vehicleId: vehicle.id };
  }

  /** A confirmed delivery order of exactly `grams` for a new shop at `location`. */
  async function deliveryOrder(
    owner: TestOwner,
    grams: number | null,
    location: { latitude: number; longitude: number } | null,
    options: { fulfillmentMethod?: "delivery" | "pickup" | null; customerId?: string } = {}
  ) {
    const customerId =
      options.customerId ??
      (await createCustomer(app, owner, `Shop ${randomUUID().slice(0, 6)}`)).id;
    if (location !== null && options.customerId === undefined) {
      await ok(app, "PUT", url(owner, `shops/${customerId}/location`), owner.cookie, location);
    }
    const product = await createProduct(app, owner, {
      name: `Load ${randomUUID().slice(0, 6)}`,
      ...(grams === null ? {} : { unitWeightGrams: String(grams) })
    });
    const method = options.fulfillmentMethod === undefined ? "delivery" : options.fulfillmentMethod;
    const { invoice } = await confirmInvoice(app, owner, {
      customerId,
      source: "FIELD_SALES",
      items: [{ productId: product.id, quantity: 1 }],
      ...(method === null ? {} : { fulfillmentMethod: method })
    });
    await settleIntakes();
    return { invoiceId: invoice.id, customerId };
  }

  const pools = async (owner: TestOwner) =>
    ok<{ pools: PoolView[]; unassigned: Record<string, number> }>(
      app,
      "GET",
      url(owner, "pools"),
      owner.cookie
    );
  const poolFor = async (owner: TestOwner, corridorId: string) =>
    (await pools(owner)).pools.find((entry) => entry.corridorId === corridorId) as PoolView;
  const orderStatus = async (owner: TestOwner, invoiceId: string) =>
    ok<{
      intakeStatus: string;
      state: string | null;
      corridor: { current: { corridorId: string } | null; stale: boolean } | null;
    }>(app, "GET", url(owner, `orders/${invoiceId}`), owner.cookie);
  const createManifest = (
    owner: TestOwner,
    body: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) =>
    request<CreateManifestResult & { code?: string; details?: Record<string, unknown> }>(
      app,
      "POST",
      url(owner, "manifests"),
      owner.cookie,
      body,
      headers
    );

  describe("intake on confirmation", () => {
    it("takes in delivery orders, resolves their corridor, and never blocks confirmation", async () => {
      const { owner, corridorId } = await setupBusiness();
      const delivered = await deliveryOrder(owner, 900 * KG, alongX(0.5));
      expect(await orderStatus(owner, delivered.invoiceId)).toMatchObject({
        intakeStatus: "TAKEN_IN",
        state: "POOLED",
        corridor: { current: { corridorId }, stale: false }
      });
      const logistics = await ok<Array<{ invoiceId: string; method: string; status: string }>>(
        app,
        "GET",
        `/businesses/${owner.businessId}/logistics`,
        owner.cookie
      );
      expect(logistics.find((entry) => entry.invoiceId === delivered.invoiceId)).toMatchObject({
        method: "delivery",
        status: "pending"
      });

      // Pickup and no-intent orders never enter fulfillment.
      const pickup = await deliveryOrder(owner, 900 * KG, alongX(0.5), {
        fulfillmentMethod: "pickup"
      });
      expect((await orderStatus(owner, pickup.invoiceId)).intakeStatus).toBe("NOT_FOR_DELIVERY");
      const noIntent = await deliveryOrder(owner, 900 * KG, alongX(0.5), {
        fulfillmentMethod: null
      });
      expect((await orderStatus(owner, noIntent.invoiceId)).intakeStatus).toBe("NOT_FOR_DELIVERY");
      // A delivery record added later makes it deliverable.
      await ok(app, "POST", `/businesses/${owner.businessId}/logistics`, owner.cookie, {
        invoiceId: noIntent.invoiceId,
        method: "delivery"
      });
      await settleIntakes();
      expect((await orderStatus(owner, noIntent.invoiceId)).intakeStatus).toBe("TAKEN_IN");

      // No location: taken in, visible as unassigned, not dropped.
      const lost = await deliveryOrder(owner, 900 * KG, null);
      expect((await orderStatus(owner, lost.invoiceId)).corridor?.current ?? null).toBeNull();
      expect((await pools(owner)).unassigned).toMatchObject({ unresolvedLocationCount: 1 });
    });

    it("reconciles orders whose intake never ran and flags orphans without deleting them", async () => {
      const { owner } = await setupBusiness();
      store.setFulfillmentIntakeListener(null);
      const missed = await deliveryOrder(owner, 500 * KG, alongX(0.3));
      expect((await orderStatus(owner, missed.invoiceId)).intakeStatus).toBe("PENDING_INTAKE");
      expect((await pools(owner)).unassigned.pendingIntakeCount).toBe(1);
      const first = await service.reconcileIntake();
      expect(first.takenIn).toBeGreaterThanOrEqual(1);
      expect((await orderStatus(owner, missed.invoiceId)).intakeStatus).toBe("TAKEN_IN");

      // Lose the invoice from the store (e.g. an unpersisted confirmation lost in a crash).
      const snapshot = store.snapshot();
      store.hydrateSnapshot({
        ...snapshot,
        invoices: snapshot.invoices.filter((invoice) => invoice.id !== missed.invoiceId)
      });
      const second = await service.reconcileIntake();
      expect(second.orphaned).toBeGreaterThanOrEqual(1);
      const row = await pool.query("select state from fulfillment_orders where invoice_id = $1", [
        missed.invoiceId
      ]);
      expect(row.rows).toEqual([{ state: "ORPHANED" }]);
      expect((await pools(owner)).unassigned.orphanedCount).toBe(1);
    });
  });

  describe("pooling and readiness (A13, A16)", () => {
    it("counts eligible, unpaid and pay-on-delivery orders; excludes unknown weight and cancellations", async () => {
      const { owner, corridorId } = await setupBusiness();
      const unpaid = await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      const partPaid = await deliveryOrder(owner, 2000 * KG, alongX(0.4));
      await ok(app, "POST", `/businesses/${owner.businessId}/payments`, owner.cookie, {
        invoiceId: partPaid.invoiceId,
        amount: 10,
        method: "cash"
      });
      await deliveryOrder(owner, null, alongX(0.6));
      const cancelled = await deliveryOrder(owner, 3000 * KG, alongX(0.8));
      await ok(app, "POST", url(owner, `orders/${cancelled.invoiceId}/cancel`), owner.cookie, {
        reason: "Shop closed"
      });
      const view = await poolFor(owner, corridorId);
      // Payment state is not an input: unpaid and part-paid both count.
      expect(view).toMatchObject({
        eligibleOrderCount: 2,
        eligibleTotalWeightGrams: String(3000 * KG),
        unresolvedWeightCount: 1,
        needsResolution: true,
        readiness: "ACCUMULATING",
        percentFilled: 50
      });
      expect(unpaid.invoiceId).toBeTruthy();
      expect(view.timeUntilCutoffSeconds).toBeGreaterThan(0);
      expect(view.oldestWaitingOrderAgeSeconds).toBeGreaterThanOrEqual(0);
    });

    it("keeps a stale order in the total, flags it, excludes it from readiness and blocks allocation", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness({ targetKg: 1000 });
      const order = await deliveryOrder(owner, 1000 * KG, alongX(0.5));
      expect((await poolFor(owner, corridorId)).readiness).toBe("DISPATCH_READY");
      await ok(app, "PUT", url(owner, `corridors/${corridorId}/geometry`), owner.cookie, {
        routeGeometry: {
          type: "LineString",
          coordinates: [...corridorX.coordinates, [36.8, -1.19]]
        }
      });
      expect(await poolFor(owner, corridorId)).toMatchObject({
        eligibleTotalWeightGrams: String(1000 * KG),
        allocatableWeightGrams: "0",
        staleResolutionCount: 1,
        needsResolution: true,
        readiness: "ACCUMULATING"
      });
      const auto = await createManifest(owner, { corridorId, vehicleId });
      expect(auto.status).toBe(409);
      const explicit = await createManifest(owner, {
        corridorId,
        vehicleId,
        orderIds: [order.invoiceId]
      });
      expect(explicit.status).toBe(422);
      expect(explicit.body.details?.rejections).toEqual([
        { orderId: order.invoiceId, reason: "STALE_RESOLUTION" }
      ]);
      await ok(
        app,
        "POST",
        url(owner, `orders/${order.invoiceId}/corridor/resolve`),
        owner.cookie,
        {}
      );
      expect((await createManifest(owner, { corridorId, vehicleId })).status).toBe(200);
    });

    it("moves pools when an order is manually reassigned", async () => {
      const { owner, corridorId } = await setupBusiness();
      const other = await ok<{ id: string }>(app, "POST", url(owner, "corridors"), owner.cookie, {
        name: "Corridor Y",
        originLabel: "Depot",
        destinationLabel: "Y",
        routeGeometry: corridorX,
        priority: 500
      });
      const order = await deliveryOrder(owner, 800 * KG, alongX(0.5));
      expect((await poolFor(owner, corridorId)).eligibleOrderCount).toBe(1);
      await ok(app, "POST", url(owner, `orders/${order.invoiceId}/corridor/assign`), owner.cookie, {
        corridorId: other.id
      });
      expect((await poolFor(owner, corridorId)).eligibleOrderCount).toBe(0);
      expect((await poolFor(owner, other.id)).eligibleTotalWeightGrams).toBe(String(800 * KG));
    });

    it("computes readiness at the exact gram boundaries", async () => {
      const nullMinimum = await setupBusiness({ targetKg: 6000 });
      await deliveryOrder(nullMinimum.owner, 6000 * KG - 1, alongX(0.3));
      expect((await poolFor(nullMinimum.owner, nullMinimum.corridorId)).readiness).toBe(
        "ACCUMULATING"
      );
      await deliveryOrder(nullMinimum.owner, 1, alongX(0.4));
      expect((await poolFor(nullMinimum.owner, nullMinimum.corridorId)).readiness).toBe(
        "DISPATCH_READY"
      );

      const withMinimum = await setupBusiness({ targetKg: 6000, minimumKg: 4000 });
      await deliveryOrder(withMinimum.owner, 4000 * KG - 1, alongX(0.3));
      expect((await poolFor(withMinimum.owner, withMinimum.corridorId)).readiness).toBe(
        "ACCUMULATING"
      );
      await deliveryOrder(withMinimum.owner, 1, alongX(0.4));
      expect((await poolFor(withMinimum.owner, withMinimum.corridorId)).readiness).toBe(
        "DISPATCHABLE"
      );
    });
  });

  describe("A21 allocation", () => {
    it("5,900 kg + 900 kg into 7,000 kg: both allocated, exact BIGINT total, stops in road order", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const far = await deliveryOrder(owner, 5900 * KG, alongX(0.9));
      const near = await deliveryOrder(owner, 900 * KG, alongX(0.1));
      const result = await createManifest(owner, { corridorId, vehicleId });
      expect(result.status).toBe(200);
      expect(result.body.manifest).toMatchObject({
        status: "OPEN",
        totalWeightGrams: String(6800 * KG),
        vehicleCapacityGrams: String(7000 * KG)
      });
      expect(result.body.manifest.stops.map((stop) => [stop.sequence, stop.invoiceId])).toEqual([
        [1, near.invoiceId],
        [2, far.invoiceId]
      ]);
      expect(typeof result.body.manifest.stops[0]?.orderWeightGrams).toBe("string");
    });

    it("6,500 kg + 900 kg into 7,000 kg: the second stays pooled with its original age", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const big = await deliveryOrder(owner, 6500 * KG, alongX(0.5));
      const extra = await deliveryOrder(owner, 900 * KG, alongX(0.6));
      const result = await createManifest(owner, { corridorId, vehicleId });
      expect(result.body.allocatedInvoiceIds).toEqual([big.invoiceId]);
      expect(result.body.skippedInvoiceIds).toEqual([extra.invoiceId]);
      expect((await orderStatus(owner, extra.invoiceId)).state).toBe("POOLED");
    });

    it("skips an older order that does not fit and allocates a newer one that does", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const base = await deliveryOrder(owner, 6300 * KG, alongX(0.2));
      const older = await deliveryOrder(owner, 900 * KG, alongX(0.3));
      const newer = await deliveryOrder(owner, 400 * KG, alongX(0.4));
      const result = await createManifest(owner, { corridorId, vehicleId });
      expect(result.body.allocatedInvoiceIds.sort()).toEqual(
        [base.invoiceId, newer.invoiceId].sort()
      );
      expect(result.body.skippedInvoiceIds).toEqual([older.invoiceId]);
    });

    it("flags an order heavier than the vehicle as REQUIRES_PLANNING", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const huge = await deliveryOrder(owner, 7500 * KG, alongX(0.5));
      expect((await poolFor(owner, corridorId)).eligibleOrderCount).toBe(1);
      const alone = await createManifest(owner, { corridorId, vehicleId });
      expect(alone.status).toBe(409);
      const small = await deliveryOrder(owner, 100 * KG, alongX(0.6));
      const result = await createManifest(owner, { corridorId, vehicleId });
      expect(result.body.allocatedInvoiceIds).toEqual([small.invoiceId]);
      expect(result.body.requiresPlanningInvoiceIds).toEqual([huge.invoiceId]);
    });

    it("rejects an explicit selection that exceeds capacity, all or nothing", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const a = await deliveryOrder(owner, 4000 * KG, alongX(0.2));
      const b = await deliveryOrder(owner, 4000 * KG, alongX(0.4));
      const result = await createManifest(owner, {
        corridorId,
        vehicleId,
        orderIds: [a.invoiceId, b.invoiceId]
      });
      expect(result.status).toBe(422);
      expect(result.body.code).toBe("invalid_selection");
      const manifests = await ok<unknown[]>(app, "GET", url(owner, "manifests"), owner.cookie);
      expect(manifests).toEqual([]);
      expect((await orderStatus(owner, a.invoiceId)).state).toBe("POOLED");
    });

    it("rejects an explicit selection with an allocated, foreign or unknown order", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const other = await setupBusiness({ name: "Another wholesaler" });
      const first = await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      const fresh = await deliveryOrder(owner, 1000 * KG, alongX(0.3));
      const foreign = await deliveryOrder(other.owner, 1000 * KG, alongX(0.3));
      await createManifest(owner, { corridorId, vehicleId, orderIds: [first.invoiceId] });
      const result = await createManifest(owner, {
        corridorId,
        vehicleId,
        orderIds: [fresh.invoiceId, first.invoiceId, foreign.invoiceId]
      });
      expect(result.status).toBe(422);
      expect(result.body.details?.rejections).toEqual([
        { orderId: first.invoiceId, reason: "ALREADY_ALLOCATED" },
        { orderId: foreign.invoiceId, reason: "NOT_FOUND" }
      ]);
      expect((await orderStatus(owner, fresh.invoiceId)).state).toBe("POOLED");
    });
  });

  describe("manifests and the A12 lifecycle", () => {
    it("snapshots location, geometry and policy versions; later edits do not change the manifest", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const order = await deliveryOrder(owner, 1000 * KG, alongX(0.5));
      const created = await createManifest(owner, { corridorId, vehicleId });
      const before = created.body.manifest;
      expect(before).toMatchObject({ corridorGeometryVersion: 1, policyVersion: 1 });
      await ok(
        app,
        "PUT",
        url(owner, `shops/${order.customerId}/location`),
        owner.cookie,
        alongX(0.7)
      );
      await ok(app, "PUT", url(owner, `corridors/${corridorId}/geometry`), owner.cookie, {
        routeGeometry: {
          type: "LineString",
          coordinates: [...corridorX.coordinates, [36.8, -1.19]]
        }
      });
      const after = await ok<ManifestView>(
        app,
        "GET",
        url(owner, `manifests/${before.id}`),
        owner.cookie
      );
      expect(after.corridorGeometryVersion).toBe(1);
      expect(after.stops[0]).toMatchObject({
        latitude: before.stops[0]?.latitude,
        longitude: before.stops[0]?.longitude,
        distanceAlongMeters: before.stops[0]?.distanceAlongMeters
      });
      // An allocated order cannot be re-resolved; it must leave the manifest first.
      const reresolve = await request<{ code: string }>(
        app,
        "POST",
        url(owner, `orders/${order.invoiceId}/corridor/resolve`),
        owner.cookie,
        {}
      );
      expect(reresolve.status).toBe(409);
      expect(reresolve.body.code).toBe("order_allocated");
    });

    it("handles cancellation and removal while OPEN, blocks cancellation once CLOSED, and records deliveries", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const a = await deliveryOrder(owner, 1000 * KG, alongX(0.1));
      const b = await deliveryOrder(owner, 2000 * KG, alongX(0.2));
      const c = await deliveryOrder(owner, 3000 * KG, alongX(0.3));
      const d = await deliveryOrder(owner, 500 * KG, alongX(0.4));
      const created = (await createManifest(owner, { corridorId, vehicleId })).body.manifest;
      expect(created.totalWeightGrams).toBe(String(6500 * KG));

      // OPEN: cancellation deactivates the stop and recomputes the total.
      await ok(app, "POST", url(owner, `orders/${a.invoiceId}/cancel`), owner.cookie, {
        reason: "Changed mind"
      });
      const afterCancel = await ok<ManifestView>(
        app,
        "GET",
        url(owner, `manifests/${created.id}`),
        owner.cookie
      );
      expect(afterCancel.totalWeightGrams).toBe(String(5500 * KG));
      expect((await orderStatus(owner, a.invoiceId)).state).toBe("CANCELLED");
      // OPEN: removal returns the order to the pool.
      await ok(
        app,
        "POST",
        url(owner, `manifests/${created.id}/orders/${d.invoiceId}/remove`),
        owner.cookie,
        {}
      );
      expect((await orderStatus(owner, d.invoiceId)).state).toBe("POOLED");

      const closed = await ok<ManifestView>(
        app,
        "POST",
        url(owner, `manifests/${created.id}/close`),
        owner.cookie,
        {}
      );
      expect(closed.status).toBe("CLOSED");
      const blocked = await request<{ code: string }>(
        app,
        "POST",
        url(owner, `orders/${b.invoiceId}/cancel`),
        owner.cookie,
        {}
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe("order_dispatched");

      const stopFor = (invoiceId: string) =>
        closed.stops.find(
          (stop) => stop.invoiceId === invoiceId && stop.allocationActive
        ) as ManifestView["stops"][number];
      const skipNoReason = await request(
        app,
        "POST",
        url(owner, `manifests/${created.id}/stops/${stopFor(c.invoiceId).id}/delivery`),
        owner.cookie,
        { outcome: "SKIPPED" }
      );
      expect(skipNoReason.status).toBe(400);
      await ok(
        app,
        "POST",
        url(owner, `manifests/${created.id}/stops/${stopFor(c.invoiceId).id}/delivery`),
        owner.cookie,
        {
          outcome: "SKIPPED",
          note: "Shop locked"
        }
      );
      // Skipped goes back to the pool with its original confirmation age.
      expect((await orderStatus(owner, c.invoiceId)).state).toBe("POOLED");
      await ok(
        app,
        "POST",
        url(owner, `manifests/${created.id}/stops/${stopFor(b.invoiceId).id}/delivery`),
        owner.cookie,
        { outcome: "ARRIVED" }
      );
      const done = await ok<ManifestView>(
        app,
        "POST",
        url(owner, `manifests/${created.id}/stops/${stopFor(b.invoiceId).id}/delivery`),
        owner.cookie,
        { outcome: "DELIVERED" }
      );
      expect(done.status).toBe("COMPLETED");
      expect((await orderStatus(owner, b.invoiceId)).state).toBe("DELIVERED");
      const again = await request(
        app,
        "POST",
        url(owner, `manifests/${created.id}/stops/${stopFor(b.invoiceId).id}/delivery`),
        owner.cookie,
        { outcome: "FAILED", note: "x" }
      );
      expect(again.status).toBe(409);

      const logistics = await ok<Array<{ invoiceId: string; status: string }>>(
        app,
        "GET",
        `/businesses/${owner.businessId}/logistics`,
        owner.cookie
      );
      const statusOf = (invoiceId: string) =>
        logistics.find((entry) => entry.invoiceId === invoiceId)?.status;
      expect([
        statusOf(a.invoiceId),
        statusOf(b.invoiceId),
        statusOf(c.invoiceId),
        statusOf(d.invoiceId)
      ]).toEqual(["cancelled", "completed", "ready", "ready"]);
    });
  });

  describe("security (A8, A3.11)", () => {
    it("denies cross-tenant access and enforces dispatch and delivery permissions", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const other = await createOwner(app, "Intruder");
      const order = await deliveryOrder(owner, 1000 * KG, alongX(0.5));
      expect((await request(app, "GET", url(owner, "pools"), other.cookie)).status).toBe(403);
      expect(
        (
          await request(app, "POST", url(owner, "manifests"), other.cookie, {
            corridorId,
            vehicleId
          })
        ).status
      ).toBe(403);
      expect(
        (
          await request(
            app,
            "POST",
            `/businesses/${other.businessId}/fulfillment/manifests`,
            other.cookie,
            { corridorId, vehicleId }
          )
        ).status
      ).toBe(404);

      const salesperson = await signUp(app);
      addMember(store, owner.businessId, salesperson.userId, "sales_agent");
      expect((await request(app, "GET", url(owner, "pools"), salesperson.cookie)).status).toBe(200);
      expect(
        (await request(app, "GET", url(owner, `pools/${corridorId}`), salesperson.cookie)).status
      ).toBe(403);
      expect(
        (
          await request(app, "POST", url(owner, "manifests"), salesperson.cookie, {
            corridorId,
            vehicleId
          })
        ).status
      ).toBe(403);

      const created = (await createManifest(owner, { corridorId, vehicleId })).body.manifest;
      await ok(app, "POST", url(owner, `manifests/${created.id}/close`), owner.cookie, {});
      const driver = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      expect(
        (
          await request(app, "POST", url(owner, "manifests"), driver.cookie, {
            corridorId,
            vehicleId
          })
        ).status
      ).toBe(403);
      const deliveryUrl = url(
        owner,
        `manifests/${created.id}/stops/${created.stops[0]?.id}/delivery`
      );
      // A driver records deliveries only on a trip assigned to them (§16): before assignment the
      // manifest is indistinguishable from a missing one...
      expect(
        (await request(app, "POST", deliveryUrl, driver.cookie, { outcome: "DELIVERED" })).status
      ).toBe(404);
      // ...and once the dispatcher assigns it, the same driver records the delivery.
      await ok(app, "POST", url(owner, `manifests/${created.id}/driver`), owner.cookie, {
        driverUserId: driver.userId
      });
      expect(
        (await request(app, "POST", deliveryUrl, driver.cookie, { outcome: "DELIVERED" })).status
      ).toBe(200);
      expect((await orderStatus(owner, order.invoiceId)).state).toBe("DELIVERED");
    });
  });

  describe("A17 concurrency on real PostgreSQL", () => {
    it("serializes concurrent automatic creation: no order in two manifests, none lost, none over capacity", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const orders = [];
      for (let index = 0; index < 12; index += 1) {
        orders.push(await deliveryOrder(owner, 1500 * KG, alongX(0.05 + index * 0.07)));
      }
      const results = await Promise.all(
        Array.from({ length: 4 }, () => createManifest(owner, { corridorId, vehicleId }))
      );
      // 4 x 1,500 kg fit a 7,000 kg truck: three manifests take all 12 orders, and the fourth
      // request sees the post-lock state (nothing left) instead of a stale snapshot.
      const created = results.filter((result) => result.status === 200);
      expect(created).toHaveLength(3);
      expect(results.filter((result) => result.status === 409)).toHaveLength(1);
      const allocated = created.flatMap((result) => result.body.allocatedInvoiceIds);
      expect(new Set(allocated).size).toBe(allocated.length);
      expect(allocated).toHaveLength(12);
      for (const result of created) {
        expect(BigInt(result.body.manifest.totalWeightGrams)).toBeLessThanOrEqual(7000n * 1000n);
      }
      const states = await pool.query<{ invoice_id: string; state: string; active: number }>(
        `select o.invoice_id, o.state,
                (select count(*) from fulfillment_manifest_stops s where s.fulfillment_order_id = o.id and s.allocation_active)::int as active
         from fulfillment_orders o where o.business_id = $1`,
        [owner.businessId]
      );
      expect(states.rows).toHaveLength(12);
      for (const row of states.rows) {
        expect(row.state === "ALLOCATED" ? row.active : 1 - row.active).toBe(1);
      }
      expect(states.rows.filter((row) => row.state === "ALLOCATED")).toHaveLength(allocated.length);
    });

    it("lets exactly one of two overlapping explicit selections win", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const shared = await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      const onlyA = await deliveryOrder(owner, 1000 * KG, alongX(0.3));
      const onlyB = await deliveryOrder(owner, 1000 * KG, alongX(0.4));
      const [first, second] = await Promise.all([
        createManifest(owner, {
          corridorId,
          vehicleId,
          orderIds: [shared.invoiceId, onlyA.invoiceId]
        }),
        createManifest(owner, {
          corridorId,
          vehicleId,
          orderIds: [shared.invoiceId, onlyB.invoiceId]
        })
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 422]);
      const loser = first.status === 422 ? first : second;
      expect(loser.body.details?.rejections).toEqual([
        { orderId: shared.invoiceId, reason: "ALREADY_ALLOCATED" }
      ]);
      // No partial explicit allocation survives for the loser.
      const loserOnly = loser === first ? onlyA : onlyB;
      expect((await orderStatus(owner, loserOnly.invoiceId)).state).toBe("POOLED");
    });

    it("never allocates an order in its cancelled or reassigned state (membership race)", async () => {
      for (let round = 0; round < 3; round += 1) {
        const { owner, corridorId, vehicleId } = await setupBusiness({ name: `Race ${round}` });
        const cancelled = await deliveryOrder(owner, 1000 * KG, alongX(0.2));
        const reassigned = await deliveryOrder(owner, 1000 * KG, alongX(0.3));
        const other = await ok<{ id: string }>(app, "POST", url(owner, "corridors"), owner.cookie, {
          name: "Parallel",
          originLabel: "Depot",
          destinationLabel: "P",
          routeGeometry: corridorX,
          priority: 900
        });
        await Promise.all([
          createManifest(owner, { corridorId, vehicleId }),
          request(
            app,
            "POST",
            url(owner, `orders/${cancelled.invoiceId}/cancel`),
            owner.cookie,
            {}
          ),
          request(
            app,
            "POST",
            url(owner, `orders/${reassigned.invoiceId}/corridor/assign`),
            owner.cookie,
            { corridorId: other.id }
          )
        ]);
        const rows = await pool.query<{
          invoice_id: string;
          state: string;
          active_manifest_corridor: string | null;
          resolved_corridor: string | null;
        }>(
          `select o.invoice_id, o.state,
                  (select m.corridor_id from fulfillment_manifest_stops s join fulfillment_manifests m on m.id = s.manifest_id
                   where s.fulfillment_order_id = o.id and s.allocation_active) as active_manifest_corridor,
                  (select r.corridor_id from fulfillment_corridor_resolutions r
                   where r.fulfillment_order_id = o.id and r.superseded_at is null) as resolved_corridor
           from fulfillment_orders o where o.business_id = $1`,
          [owner.businessId]
        );
        for (const row of rows.rows) {
          // A cancelled order never holds an active allocation.
          if (row.state === "CANCELLED") expect(row.active_manifest_corridor).toBeNull();
          // An allocated order's manifest is on the corridor it is resolved to.
          if (row.active_manifest_corridor !== null) {
            expect(row.state).toBe("ALLOCATED");
            expect(row.resolved_corridor).toBe(row.active_manifest_corridor);
          }
        }
      }
    });

    it("turns concurrent identical requests into one manifest and rejects a different body", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      await deliveryOrder(owner, 1000 * KG, alongX(0.3));
      const headers = { "idempotency-key": "manifest-race" };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => createManifest(owner, { corridorId, vehicleId }, headers))
      );
      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);
      expect(new Set(results.map((result) => result.body.manifest.id)).size).toBe(1);
      const count = await pool.query("select 1 from fulfillment_manifests where business_id = $1", [
        owner.businessId
      ]);
      expect(count.rows).toHaveLength(1);
      const conflict = await createManifest(
        owner,
        { corridorId, vehicleId, orderIds: [randomUUID()] },
        headers
      );
      expect(conflict.status).toBe(409);
    });

    it("enforces one active allocation and capacity in the database itself", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      const created = (await createManifest(owner, { corridorId, vehicleId })).body.manifest;
      const stop = await pool.query(
        "select * from fulfillment_manifest_stops where manifest_id = $1",
        [created.id]
      );
      const row = stop.rows[0];
      await expect(
        pool.query(
          `insert into fulfillment_manifest_stops
             (id, business_id, manifest_id, fulfillment_order_id, invoice_id, customer_id, corridor_resolution_id,
              shop_location_id, sequence, distance_along_meters, diversion_meters, latitude, longitude,
              order_weight_grams, allocation_active, delivery_status, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 99, 0, 0, 0, 0, 1, true, 'PENDING', now(), now())`,
          [
            randomUUID(),
            row.business_id,
            row.manifest_id,
            row.fulfillment_order_id,
            row.invoice_id,
            row.customer_id,
            row.corridor_resolution_id,
            row.shop_location_id
          ]
        )
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          "update fulfillment_manifests set total_weight_grams = vehicle_capacity_grams + 1 where id = $1",
          [created.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  describe("Phase 1 end-to-end Definition of Done", () => {
    it("runs the 14-step field-sales-to-delivery scenario", async () => {
      // Target 6,000 kg with no minimum; a 7,000 kg truck.
      const { owner, corridorId, vehicleId } = await setupBusiness({ targetKg: 6000 });
      const salesperson = await signUp(app);
      addMember(store, owner.businessId, salesperson.userId, "sales_agent");
      const asSales: TestOwner = {
        businessId: owner.businessId,
        userId: salesperson.userId,
        cookie: salesperson.cookie
      };

      // 1-2. Salesperson registers Shop A and captures its GPS.
      const shopA = await ok<{ id: string }>(
        app,
        "POST",
        `/businesses/${owner.businessId}/customers`,
        asSales.cookie,
        { name: "Shop A" }
      );
      await ok(app, "PUT", url(owner, `shops/${shopA.id}/location`), asSales.cookie, alongX(0.5));
      // 3. Shop A resolves to Corridor X.
      const match = await ok<{ status: string; selected: { corridorId: string } }>(
        app,
        "GET",
        url(owner, `shops/${shopA.id}/corridor-match`),
        asSales.cookie
      );
      expect(match).toMatchObject({ status: "RESOLVED", selected: { corridorId } });
      // 4. Salesperson creates a 900 kg order (owner confirms: sales agents cannot confirm).
      const product = await createProduct(app, owner, {
        name: "Maize sack 90kg",
        unitWeightGrams: String(90 * KG)
      });
      const draft = await ok<{ id: string }>(
        app,
        "POST",
        `/businesses/${owner.businessId}/invoices`,
        asSales.cookie,
        {
          customerId: shopA.id,
          source: "FIELD_SALES",
          taxRate: 0,
          items: [{ productId: product.id, quantity: 10, unitPrice: 3000 }]
        }
      );
      await ok(
        app,
        "POST",
        `/businesses/${owner.businessId}/invoices/${draft.id}/confirm`,
        owner.cookie,
        { fulfillmentMethod: "delivery" }
      );
      await settleIntakes();
      const orderA = await orderStatus(owner, draft.id);
      expect(orderA).toMatchObject({
        intakeStatus: "TAKEN_IN",
        state: "POOLED",
        corridor: { current: { corridorId } }
      });
      const provenance = await pool.query(
        "select resolution_method from fulfillment_corridor_resolutions r join fulfillment_orders o on o.id = r.fulfillment_order_id where o.invoice_id = $1",
        [draft.id]
      );
      expect(provenance.rows).toEqual([{ resolution_method: "AUTO" }]);

      // 5-6. More orders join Corridor X up to target - 1 g: ACCUMULATING.
      const b = await deliveryOrder(owner, 3000 * KG, alongX(0.2));
      const c = await deliveryOrder(owner, 2100 * KG - 1, alongX(0.8));
      expect(await poolFor(owner, corridorId)).toMatchObject({
        eligibleTotalWeightGrams: String(6000 * KG - 1),
        readiness: "ACCUMULATING"
      });
      // 7-8. A pay-on-delivery order (no payment recorded) takes it to target: DISPATCH_READY.
      const pod = await deliveryOrder(owner, 1, alongX(0.9));
      expect(await poolFor(owner, corridorId)).toMatchObject({
        eligibleTotalWeightGrams: String(6000 * KG),
        readiness: "DISPATCH_READY"
      });
      // 9. Geometry edit: one unallocated order becomes stale and is blocked until re-resolved.
      await ok(app, "PUT", url(owner, `corridors/${corridorId}/geometry`), owner.cookie, {
        routeGeometry: {
          type: "LineString",
          coordinates: [...corridorX.coordinates, [36.8, -1.19]]
        }
      });
      const staleView = await poolFor(owner, corridorId);
      expect(staleView.staleResolutionCount).toBe(4);
      expect(staleView.eligibleTotalWeightGrams).toBe(String(6000 * KG));
      const blocked = await createManifest(owner, {
        corridorId,
        vehicleId,
        orderIds: [b.invoiceId]
      });
      expect(blocked.status).toBe(422);
      for (const invoiceId of [draft.id, b.invoiceId, c.invoiceId, pod.invoiceId]) {
        await ok(app, "POST", url(owner, `orders/${invoiceId}/corridor/resolve`), owner.cookie, {});
      }
      // An extra order that will not fit, to prove capacity (step 11).
      const overflow = await deliveryOrder(owner, 1500 * KG, alongX(0.95));

      // 10-11. Dispatcher (manager) creates a manifest with the 7,000 kg truck.
      const dispatcher = await signUp(app);
      addMember(store, owner.businessId, dispatcher.userId, "manager");
      const created = await request<CreateManifestResult>(
        app,
        "POST",
        url(owner, "manifests"),
        dispatcher.cookie,
        { corridorId, vehicleId }
      );
      expect(created.status).toBe(200);
      expect(BigInt(created.body.manifest.totalWeightGrams)).toBeLessThanOrEqual(7000n * 1000n);
      expect(created.body.manifest.totalWeightGrams).toBe(String(6000 * KG));
      expect(created.body.skippedInvoiceIds).toEqual([overflow.invoiceId]);
      expect((await orderStatus(owner, overflow.invoiceId)).state).toBe("POOLED");
      // 12. Stops ordered by distance along Corridor X.
      expect(created.body.manifest.stops.map((stop) => stop.invoiceId)).toEqual([
        b.invoiceId,
        draft.id,
        c.invoiceId,
        pod.invoiceId
      ]);

      // 13. Manifest closes; deliveries are recorded.
      const closed = await ok<ManifestView>(
        app,
        "POST",
        url(owner, `manifests/${created.body.manifest.id}/close`),
        dispatcher.cookie,
        {}
      );
      for (const stop of closed.stops) {
        await ok(
          app,
          "POST",
          url(owner, `manifests/${closed.id}/stops/${stop.id}/delivery`),
          dispatcher.cookie,
          { outcome: "DELIVERED" }
        );
      }
      // 14. Canonical orders show the correct fulfillment state.
      const logistics = await ok<Array<{ invoiceId: string; status: string }>>(
        app,
        "GET",
        `/businesses/${owner.businessId}/logistics`,
        owner.cookie
      );
      for (const invoiceId of [draft.id, b.invoiceId, c.invoiceId, pod.invoiceId]) {
        expect((await orderStatus(owner, invoiceId)).state).toBe("DELIVERED");
        expect(logistics.find((entry) => entry.invoiceId === invoiceId)?.status).toBe("completed");
      }
      const finalManifest = await ok<ManifestView>(
        app,
        "GET",
        url(owner, `manifests/${closed.id}`),
        owner.cookie
      );
      expect(finalManifest.status).toBe("COMPLETED");

      // Proofs: no order disappears, none duplicates, none crosses tenants, no weight is lost.
      const all = await pool.query<{
        invoice_id: string;
        state: string;
        business_id: string;
        total_weight_grams: string;
      }>(
        "select invoice_id, state, business_id, total_weight_grams from fulfillment_orders where business_id = $1",
        [owner.businessId]
      );
      expect(all.rows).toHaveLength(5);
      expect(new Set(all.rows.map((row) => row.invoice_id)).size).toBe(5);
      const delivered = all.rows.filter((row) => row.state === "DELIVERED");
      expect(delivered.reduce((sum, row) => sum + BigInt(row.total_weight_grams), 0n)).toBe(
        6000n * 1000n
      );
      expect(all.rows.filter((row) => row.state === "POOLED").map((row) => row.invoice_id)).toEqual(
        [overflow.invoiceId]
      );
    }, 60_000);
  });

  describe("migrations 093/094", () => {
    it("reverse and re-apply cleanly", async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await withMigrationsReversed(client, "093", async () => {
          const gone = await client.query(
            "select to_regclass('fulfillment_manifests') as manifests"
          );
          expect(gone.rows[0]).toEqual({ manifests: null });
          const columns = await client.query(
            "select column_name from information_schema.columns where table_name = 'invoices' and column_name = 'source'"
          );
          expect(columns.rows).toEqual([]);
        });
        const back = await client.query(
          "select to_regclass('fulfillment_manifest_stops') is not null as present"
        );
        expect(back.rows[0]).toEqual({ present: true });
      } finally {
        await client.query("rollback");
        client.release();
      }
    });
  });

  describe("Phase 2 dispatch automation", () => {
    it("persists one daily approval evaluation and gives open approval readiness precedence", async () => {
      const { owner, corridorId } = await setupBusiness({ targetKg: 6000, minimumKg: 3000 });
      await ok(app, "POST", url(owner, "policies"), owner.cookie, {
        name: "Approval fallback",
        targetLoadGrams: String(6000 * KG),
        minimumDispatchLoadGrams: String(3000 * KG),
        maxDiversionMeters: 2000,
        cutoffLocalTime: "18:00",
        maxWaitHours: 72,
        fulfillmentLeadDays: 1,
        underThresholdFallback: ["REQUIRE_DISPATCH_APPROVAL"],
        overflowStrategy: "NEXT_MANIFEST",
        makeBusinessDefault: true
      });
      const order = await deliveryOrder(owner, 4000 * KG, alongX(0.5));
      await pool.query(
        "update fulfillment_orders set confirmed_at = now() - interval '73 hours' where business_id = $1 and invoice_id = $2",
        [owner.businessId, order.invoiceId]
      );

      const first = await ok<{ outcome: string; readiness: string }>(
        app,
        "POST",
        url(owner, `corridors/${corridorId}/evaluate-dispatch`),
        owner.cookie,
        {}
      );
      const second = await ok<{ outcome: string }>(
        app,
        "POST",
        url(owner, `corridors/${corridorId}/evaluate-dispatch`),
        owner.cookie,
        {}
      );
      expect(first).toMatchObject({
        outcome: "APPROVAL_REQUIRED",
        readiness: "DISPATCHABLE"
      });
      expect(second).toEqual(expect.objectContaining(first));
      expect((await poolFor(owner, corridorId)).readiness).toBe("APPROVAL_REQUIRED");

      const approvals = await ok<Array<{ id: string; status: string }>>(
        app,
        "GET",
        url(owner, "dispatch-approvals?status=OPEN"),
        owner.cookie
      );
      expect(approvals).toHaveLength(1);
      const decided = await ok<{ status: string; reason: string }>(
        app,
        "POST",
        url(owner, `dispatch-approvals/${approvals[0]?.id}/decision`),
        owner.cookie,
        { decision: "APPROVE", reason: "Essential route is due." }
      );
      expect(decided).toMatchObject({ status: "APPROVED", reason: "Essential route is due." });
      expect((await poolFor(owner, corridorId)).readiness).toBe("DISPATCHABLE");

      const persisted = await pool.query<{ evaluations: number; events: number }>(
        `select
           (select count(*)::int from fulfillment_dispatch_evaluations where business_id = $1) as evaluations,
           (select count(*)::int from fulfillment_outbox_events where business_id = $1 and event_type = 'dispatch.approval_required') as events`,
        [owner.businessId]
      );
      expect(persisted.rows[0]).toEqual({ evaluations: 1, events: 1 });
    });

    it("prevents same-day vehicle double booking and records departure with outbox events", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      const plannedDepartureAt = "2026-09-25T05:00:00.000Z";
      const first = await createManifest(owner, {
        corridorId,
        vehicleId,
        plannedDepartureAt
      });
      expect(first.status).toBe(200);
      await deliveryOrder(owner, 1000 * KG, alongX(0.8));
      const collision = await createManifest(owner, {
        corridorId,
        vehicleId,
        plannedDepartureAt
      });
      expect(collision.status).toBe(409);
      expect(collision.body.code).toBe("vehicle_unavailable");

      const manifestId = first.body.manifest.id;
      await ok(app, "POST", url(owner, `manifests/${manifestId}/close`), owner.cookie, {});
      const departed = await ok<ManifestView & { departedAt: string }>(
        app,
        "POST",
        url(owner, `manifests/${manifestId}/depart`),
        owner.cookie,
        {}
      );
      expect(departed.status).toBe("DEPARTED");
      expect(departed.departedAt).toBeTruthy();
      const invalid = await request<{ code: string }>(
        app,
        "POST",
        url(owner, `manifests/${manifestId}/depart`),
        owner.cookie,
        {}
      );
      expect(invalid).toMatchObject({
        status: 409,
        body: { code: "manifest_transition_invalid" }
      });

      const database = await pool.query<{ reservations: number; events: string[] }>(
        `select
           (select count(*)::int from fulfillment_vehicle_reservations where business_id = $1 and active) as reservations,
           (select array_agg(event_type order by event_type) from fulfillment_outbox_events where business_id = $1) as events`,
        [owner.businessId]
      );
      expect(database.rows[0]?.reservations).toBe(1);
      expect(database.rows[0]?.events).toEqual([
        "manifest.closed",
        "manifest.created",
        "manifest.departed"
      ]);
    });

    it("enforces vehicle/day exclusivity in the database", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const firstOrder = await deliveryOrder(owner, 1000 * KG, alongX(0.2));
      const first = await createManifest(owner, {
        corridorId,
        vehicleId,
        orderIds: [firstOrder.invoiceId]
      });
      const secondOrder = await deliveryOrder(owner, 1000 * KG, alongX(0.8));
      const second = await createManifest(owner, {
        corridorId,
        vehicleId,
        orderIds: [secondOrder.invoiceId]
      });
      const now = new Date();
      await pool.query(
        "insert into fulfillment_vehicle_reservations (id, business_id, vehicle_id, manifest_id, service_date, active, created_at, updated_at) values ($1, $2, $3, $4, '2026-09-26', true, $5, $5)",
        [randomUUID(), owner.businessId, vehicleId, first.body.manifest.id, now]
      );
      await expect(
        pool.query(
          "insert into fulfillment_vehicle_reservations (id, business_id, vehicle_id, manifest_id, service_date, active, created_at, updated_at) values ($1, $2, $3, $4, '2026-09-26', true, $5, $5)",
          [randomUUID(), owner.businessId, vehicleId, second.body.manifest.id, now]
        )
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("cancels a planned manifest, releases its orders and makes the vehicle available", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const order = await deliveryOrder(owner, 1000 * KG, alongX(0.4));
      const plannedDepartureAt = "2026-09-27T05:00:00.000Z";
      const created = await createManifest(owner, { corridorId, vehicleId, plannedDepartureAt });
      const cancelled = await ok<ManifestView>(
        app,
        "POST",
        url(owner, `manifests/${created.body.manifest.id}/cancel`),
        owner.cookie,
        { reason: "Vehicle maintenance" }
      );
      expect(cancelled.status).toBe("CANCELLED");
      expect((await orderStatus(owner, order.invoiceId)).state).toBe("POOLED");
      const reservation = await pool.query<{ active: boolean; release_reason: string }>(
        "select active, release_reason from fulfillment_vehicle_reservations where manifest_id = $1",
        [created.body.manifest.id]
      );
      expect(reservation.rows[0]).toEqual({ active: false, release_reason: "Vehicle maintenance" });

      const replacement = await createManifest(owner, {
        corridorId,
        vehicleId,
        plannedDepartureAt
      });
      expect(replacement.status).toBe(200);
    });

    it("runs cutoff evaluation idempotently and delivers the transactional outbox", async () => {
      const { owner, corridorId } = await setupBusiness({ targetKg: 1000 });
      await deliveryOrder(owner, 1000 * KG, alongX(0.5));
      const now = new Date("2026-09-28T20:00:00.000Z");
      const first = await service.evaluateDueDispatches({ now });
      const second = await service.evaluateDueDispatches({ now });
      expect(first.evaluated).toBeGreaterThanOrEqual(1);
      expect(second.evaluated).toBeGreaterThanOrEqual(1);
      const evaluations = await pool.query<{ count: number }>(
        "select count(*)::int as count from fulfillment_dispatch_evaluations where business_id = $1 and corridor_id = $2",
        [owner.businessId, corridorId]
      );
      expect(evaluations.rows[0]?.count).toBe(1);

      const delivered = await service.deliverPendingOutboxEvents({ now, batchSize: 200 });
      expect(delivered.delivered).toBeGreaterThan(0);
      const pending = await pool.query<{ count: number }>(
        "select count(*)::int as count from fulfillment_outbox_events where business_id = $1 and delivered_at is null",
        [owner.businessId]
      );
      expect(pending.rows[0]?.count).toBe(0);
    });
  });

  describe("Phase 3 Telegram order channel", () => {
    it("puts Telegram and field-sales orders in the same pool and manifest", async () => {
      await pool.query(
        "update fulfillment_outbox_events set delivered_at = now() where delivered_at is null"
      );
      const { owner, corridorId, vehicleId } = await setupBusiness({ targetKg: 2000 });
      const customer = await createCustomer(app, owner, "Telegram Shop");
      await ok(app, "PUT", url(owner, `shops/${customer.id}/location`), owner.cookie, alongX(0.3));
      const product = await createProduct(app, owner, {
        name: "Telegram maize flour",
        unitWeightGrams: String(1000 * KG)
      });
      const grant = await ok<{ token: string }>(
        app,
        "POST",
        `/businesses/${owner.businessId}/customers/${customer.id}/channel-link-grants`,
        owner.cookie,
        { provider: "telegram", automaticRepliesEnabled: false }
      );
      const telegram = async (updateId: number, messageId: number, text: string) =>
        app.inject({
          method: "POST",
          url: "/v1/webhooks/channels/telegram",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "test-webhook-secret"
          },
          payload: JSON.stringify({
            update_id: updateId,
            message: {
              message_id: messageId,
              from: { id: 3301, first_name: "Telegram Buyer" },
              chat: { id: 2201 },
              text
            }
          })
        });
      expect((await telegram(1, 1, `/start ${grant.token}`)).statusCode).toBe(200);
      const ordered = await telegram(2, 2, "1 Telegram maize flour");
      expect(ordered.statusCode, ordered.body).toBe(200);
      const telegramInvoiceId = ordered.json<{
        orderIntentOutcome: { status: string; invoiceId: string };
      }>().orderIntentOutcome.invoiceId;
      await settleIntakes();

      const field = await deliveryOrder(owner, 1000 * KG, alongX(0.7));
      const sharedPool = await poolFor(owner, corridorId);
      expect(sharedPool).toMatchObject({
        eligibleOrderCount: 2,
        eligibleTotalWeightGrams: String(2000 * KG),
        readiness: "DISPATCH_READY"
      });
      const telegramInvoice = store
        .snapshot()
        .invoices.find((invoice) => invoice.id === telegramInvoiceId);
      expect(telegramInvoice).toMatchObject({
        status: "confirmed",
        source: "TELEGRAM",
        sourceMessageChannel: "telegram"
      });

      const manifest = await createManifest(owner, { corridorId, vehicleId });
      expect(manifest.status).toBe(200);
      expect(manifest.body.allocatedInvoiceIds).toEqual(
        expect.arrayContaining([telegramInvoiceId, field.invoiceId])
      );
      expect(manifest.body.manifest.stops).toHaveLength(2);
      await service.deliverPendingOutboxEvents({ batchSize: 200 });
      expect(telegramDeliveries).toContain("Your delivery has been scheduled.");

      const closed = await ok<ManifestView>(
        app,
        "POST",
        url(owner, `manifests/${manifest.body.manifest.id}/close`),
        owner.cookie,
        {}
      );
      const telegramStop = closed.stops.find((stop) => stop.invoiceId === telegramInvoiceId);
      expect(telegramStop).toBeDefined();
      await ok(
        app,
        "POST",
        url(owner, `manifests/${closed.id}/stops/${telegramStop?.id}/delivery`),
        owner.cookie,
        { outcome: "DELIVERED" }
      );
      await service.deliverPendingOutboxEvents({ batchSize: 200 });
      expect(telegramDeliveries).toContain("Your order has been delivered.");
      expect(product.id).toBeTruthy();
    });
  });

  describe("driver assignment", () => {
    it("assigns a trip to one driver, who alone sees and works it", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const driver = await signUp(app);
      const otherDriver = await signUp(app);
      const cashier = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      addMember(store, owner.businessId, otherDriver.userId, "driver");
      addMember(store, owner.businessId, cashier.userId, "cashier");
      const stranger = await signUp(app);
      const first = await deliveryOrder(owner, 900 * KG, alongX(0.3));
      await deliveryOrder(owner, 900 * KG, alongX(0.6));
      const created = await createManifest(owner, { corridorId, vehicleId });
      expect(created.body.manifest).toMatchObject({ driverUserId: null, driverName: null });
      const manifestId = created.body.manifest.id;
      const assignUrl = url(owner, `manifests/${manifestId}/driver`);

      // Only a member whose role can record deliveries may be assigned.
      const drivers = await ok<Array<{ userId: string; role: string }>>(
        app,
        "GET",
        url(owner, "drivers"),
        owner.cookie
      );
      expect(drivers.map((entry) => entry.userId)).toEqual(
        expect.arrayContaining([driver.userId, otherDriver.userId, owner.userId])
      );
      expect(drivers.map((entry) => entry.userId)).not.toContain(cashier.userId);
      for (const ineligible of [cashier.userId, stranger.userId]) {
        expect(
          await request(app, "POST", assignUrl, owner.cookie, { driverUserId: ineligible })
        ).toMatchObject({ status: 409, body: { code: "driver_not_eligible" } });
      }
      // Drivers cannot assign trips, even to themselves.
      expect(
        (await request(app, "POST", assignUrl, driver.cookie, { driverUserId: driver.userId }))
          .status
      ).toBe(403);

      const assigned = await ok<ManifestView & { driverUserId: string; driverName: string }>(
        app,
        "POST",
        assignUrl,
        owner.cookie,
        { driverUserId: driver.userId },
        { "idempotency-key": "assign-1" }
      );
      expect(assigned).toMatchObject({ driverUserId: driver.userId });
      const replay = await ok<{ driverUserId: string }>(
        app,
        "POST",
        assignUrl,
        owner.cookie,
        { driverUserId: driver.userId },
        { "idempotency-key": "assign-1" }
      );
      expect(replay.driverUserId).toBe(driver.userId);
      const events = await pool.query<{ count: number }>(
        "select count(*)::int as count from fulfillment_outbox_events where business_id = $1 and event_type = 'manifest.driver_assigned'",
        [owner.businessId]
      );
      expect(events.rows[0]?.count).toBe(1);

      // The driver sees their trip; the other driver sees nothing, and neither lists all manifests.
      const mine = await ok<ManifestView[]>(app, "GET", url(owner, "my-manifests"), driver.cookie);
      expect(mine.map((entry) => entry.id)).toEqual([manifestId]);
      expect(
        await ok<unknown[]>(app, "GET", url(owner, "my-manifests"), otherDriver.cookie)
      ).toEqual([]);
      expect((await request(app, "GET", url(owner, "manifests"), driver.cookie)).status).toBe(403);

      await ok(app, "POST", url(owner, `manifests/${manifestId}/close`), owner.cookie, {});
      const stop = mine[0]?.stops.find((entry) => entry.invoiceId === first.invoiceId);
      // Someone else's trip is indistinguishable from a missing one.
      for (const path of [`manifests/${manifestId}/depart`]) {
        expect(await request(app, "POST", url(owner, path), otherDriver.cookie, {})).toMatchObject({
          status: 404
        });
      }
      expect(
        await request(
          app,
          "POST",
          url(owner, `manifests/${manifestId}/stops/${stop?.id}/delivery`),
          otherDriver.cookie,
          { outcome: "DELIVERED" }
        )
      ).toMatchObject({ status: 404 });
      // The assigned driver starts the route and records the delivery.
      await ok(app, "POST", url(owner, `manifests/${manifestId}/depart`), driver.cookie, {});
      await ok(
        app,
        "POST",
        url(owner, `manifests/${manifestId}/stops/${stop?.id}/delivery`),
        driver.cookie,
        { outcome: "DELIVERED" }
      );
      expect((await orderStatus(owner, first.invoiceId)).state).toBe("DELIVERED");

      // Unassigned: the driver loses the trip at once.
      await ok(app, "POST", assignUrl, owner.cookie, { driverUserId: null });
      expect(await ok<unknown[]>(app, "GET", url(owner, "my-manifests"), driver.cookie)).toEqual(
        []
      );
      const secondStop = mine[0]?.stops.find((entry) => entry.invoiceId !== first.invoiceId);
      expect(
        await request(
          app,
          "POST",
          url(owner, `manifests/${manifestId}/stops/${secondStop?.id}/delivery`),
          driver.cookie,
          { outcome: "DELIVERED" }
        )
      ).toMatchObject({ status: 404 });
      // The owner (a dispatcher) can still work an unassigned trip.
      await ok(
        app,
        "POST",
        url(owner, `manifests/${manifestId}/stops/${secondStop?.id}/delivery`),
        owner.cookie,
        { outcome: "DELIVERED" }
      );
      // A completed trip cannot be reassigned.
      expect(
        await request(app, "POST", assignUrl, owner.cookie, { driverUserId: driver.userId })
      ).toMatchObject({ status: 409, body: { code: "manifest_transition_invalid" } });
    }, 60_000);

    it("releases a removed driver's open trips, and does not give them back on re-invite", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const driver = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      await deliveryOrder(owner, 900 * KG, alongX(0.5));
      const created = await createManifest(owner, { corridorId, vehicleId });
      const manifestId = created.body.manifest.id;
      await ok(app, "POST", url(owner, `manifests/${manifestId}/driver`), owner.cookie, {
        driverUserId: driver.userId
      });
      const overview = await ok<{ members: Array<{ userId: string; membershipId: string }> }>(
        app,
        "GET",
        `/businesses/${owner.businessId}/staff`,
        owner.cookie
      );
      const membership = overview.members.find((member) => member.userId === driver.userId);
      await ok(
        app,
        "DELETE",
        `/businesses/${owner.businessId}/staff/members/${membership?.membershipId}`,
        owner.cookie
      );
      await settleIntakes();
      // Access ends at once, and the trip goes back to the dispatcher unassigned.
      expect((await request(app, "GET", url(owner, "my-manifests"), driver.cookie)).status).toBe(
        403
      );
      const view = await ok<{ driverUserId: string | null; driverName: string | null }>(
        app,
        "GET",
        url(owner, `manifests/${manifestId}`),
        owner.cookie
      );
      expect(view).toMatchObject({ driverUserId: null, driverName: null });
      const released = await pool.query<{ count: number }>(
        `select count(*)::int as count from fulfillment_outbox_events
         where business_id = $1 and event_type = 'manifest.driver_assigned'
           and payload->>'reason' = 'driver_left'`,
        [owner.businessId]
      );
      expect(released.rows[0]?.count).toBe(1);
      // Brought back later, they start with no trips.
      addMember(store, owner.businessId, driver.userId, "driver");
      expect(await ok<unknown[]>(app, "GET", url(owner, "my-manifests"), driver.cookie)).toEqual(
        []
      );
    }, 60_000);

    it("releases trips on a demotion out of delivering, and keeps them when the role still delivers", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const driver = await signUp(app);
      const manager = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      addMember(store, owner.businessId, manager.userId, "manager");
      await deliveryOrder(owner, 900 * KG, alongX(0.3));
      const first = await createManifest(owner, { corridorId, vehicleId });
      await deliveryOrder(owner, 900 * KG, alongX(0.6));
      const second = await createManifest(owner, { corridorId, vehicleId });
      await ok(
        app,
        "POST",
        url(owner, `manifests/${first.body.manifest.id}/driver`),
        owner.cookie,
        {
          driverUserId: driver.userId
        }
      );
      await ok(
        app,
        "POST",
        url(owner, `manifests/${second.body.manifest.id}/driver`),
        owner.cookie,
        {
          driverUserId: manager.userId
        }
      );
      const staff = await ok<{ members: Array<{ userId: string; membershipId: string }> }>(
        app,
        "GET",
        `/businesses/${owner.businessId}/staff`,
        owner.cookie
      );
      const membershipOf = (userId: string) =>
        staff.members.find((member) => member.userId === userId)?.membershipId;
      // Driver demoted to cashier (cannot record deliveries): their trip is released.
      await ok(
        app,
        "PATCH",
        `/businesses/${owner.businessId}/staff/members/${membershipOf(driver.userId)}`,
        owner.cookie,
        { role: "cashier" }
      );
      // Manager moved to driver (still records deliveries): their trip stays.
      await ok(
        app,
        "PATCH",
        `/businesses/${owner.businessId}/staff/members/${membershipOf(manager.userId)}`,
        owner.cookie,
        { role: "driver" }
      );
      await settleIntakes();
      const driverOf = async (manifestId: string) =>
        (
          await ok<{ driverUserId: string | null }>(
            app,
            "GET",
            url(owner, `manifests/${manifestId}`),
            owner.cookie
          )
        ).driverUserId;
      expect(await driverOf(first.body.manifest.id)).toBeNull();
      expect(await driverOf(second.body.manifest.id)).toBe(manager.userId);
    }, 60_000);

    it("never leaves a trip assigned to someone removed while the assignment was in flight", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const driver = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      await deliveryOrder(owner, 900 * KG, alongX(0.5));
      const created = await createManifest(owner, { corridorId, vehicleId });
      const manifestId = created.body.manifest.id;
      const staff = await ok<{ members: Array<{ userId: string; membershipId: string }> }>(
        app,
        "GET",
        `/businesses/${owner.businessId}/staff`,
        owner.cookie
      );
      const membershipId = staff.members.find(
        (member) => member.userId === driver.userId
      )?.membershipId;
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("select id from fulfillment_manifests where id = $1 for update", [
          manifestId
        ]);
        // The assignment waits on the manifest lock; meanwhile the person is removed.
        const assign = request(
          app,
          "POST",
          url(owner, `manifests/${manifestId}/driver`),
          owner.cookie,
          {
            driverUserId: driver.userId
          }
        );
        await new Promise((done) => setTimeout(done, 200));
        const removed = await request(
          app,
          "DELETE",
          `/businesses/${owner.businessId}/staff/members/${membershipId}`,
          owner.cookie
        );
        expect(removed.status).toBe(200);
        await new Promise((done) => setTimeout(done, 200));
        await blocker.query("commit");
        const assigned = await assign;
        await settleIntakes();
        // Whichever order the lock gives them, the trip does not end up with the removed person.
        expect([200, 409]).toContain(assigned.status);
        const view = await ok<{ driverUserId: string | null }>(
          app,
          "GET",
          url(owner, `manifests/${manifestId}`),
          owner.cookie
        );
        expect(view.driverUserId).toBeNull();
      } finally {
        blocker.release();
      }
    }, 60_000);

    it("releases an assignment that was still uncommitted when the driver was removed", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const driver = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      await deliveryOrder(owner, 900 * KG, alongX(0.5));
      const created = await createManifest(owner, { corridorId, vehicleId });
      const manifestId = created.body.manifest.id;
      const staff = await ok<{ members: Array<{ userId: string; membershipId: string }> }>(
        app,
        "GET",
        `/businesses/${owner.businessId}/staff`,
        owner.cookie
      );
      const membershipId = staff.members.find(
        (member) => member.userId === driver.userId
      )?.membershipId;
      // An assignment that already passed its eligibility check and holds the manifest lock,
      // not yet committed (what assignManifestDriver looks like mid-transaction).
      const inFlight = await pool.connect();
      try {
        await inFlight.query("begin");
        await inFlight.query("select id from fulfillment_manifests where id = $1 for update", [
          manifestId
        ]);
        await inFlight.query("update fulfillment_manifests set driver_user_id = $2 where id = $1", [
          manifestId,
          driver.userId
        ]);
        // The person is removed now; the release must wait for the assignment and then undo it.
        await ok(
          app,
          "DELETE",
          `/businesses/${owner.businessId}/staff/members/${membershipId}`,
          owner.cookie
        );
        await new Promise((done) => setTimeout(done, 200));
        await inFlight.query("commit");
      } finally {
        inFlight.release();
      }
      await settleIntakes();
      const view = await ok<{ driverUserId: string | null }>(
        app,
        "GET",
        url(owner, `manifests/${manifestId}`),
        owner.cookie
      );
      expect(view.driverUserId).toBeNull();
    }, 60_000);

    it("clears a returning driver's stale trips on accepting, but keeps trips given after joining", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const phone = uniquePhone();
      const firstInvite = await ok<{ id: string }>(
        app,
        "POST",
        `/businesses/${owner.businessId}/staff/invitations`,
        owner.cookie,
        { phone: `+${phone}`, role: "driver", name: "Returning" }
      );
      const driver = await signUp(app, phone);
      await ok(app, "POST", `/v1/staff-invitations/${firstInvite.id}/accept`, driver.cookie);
      await deliveryOrder(owner, 900 * KG, alongX(0.3));
      const stale = await createManifest(owner, { corridorId, vehicleId });
      await ok(
        app,
        "POST",
        url(owner, `manifests/${stale.body.manifest.id}/driver`),
        owner.cookie,
        {
          driverUserId: driver.userId
        }
      );
      // Their removal's release does not run (say the process restarted): the stale trip remains.
      store.setMembershipChangedListener(null);
      const staff = await ok<{ members: Array<{ userId: string; membershipId: string }> }>(
        app,
        "GET",
        `/businesses/${owner.businessId}/staff`,
        owner.cookie
      );
      const membershipId = staff.members.find(
        (member) => member.userId === driver.userId
      )?.membershipId;
      await ok(
        app,
        "DELETE",
        `/businesses/${owner.businessId}/staff/members/${membershipId}`,
        owner.cookie
      );
      store.setMembershipChangedListener((input) => {
        const release = service.releaseDriverAssignments(input);
        pendingIntakes.push(release);
        return release;
      });
      // Invited again and accepting: the stale trip is released, not handed back.
      const secondInvite = await ok<{ id: string }>(
        app,
        "POST",
        `/businesses/${owner.businessId}/staff/invitations`,
        owner.cookie,
        { phone: `+${phone}`, role: "driver", name: "Returning" }
      );
      await ok(app, "POST", `/v1/staff-invitations/${secondInvite.id}/accept`, driver.cookie);
      await settleIntakes();
      expect(await ok<unknown[]>(app, "GET", url(owner, "my-manifests"), driver.cookie)).toEqual(
        []
      );
      const reasons = await pool.query<{ reason: string }>(
        `select payload->>'reason' as reason from fulfillment_outbox_events
         where business_id = $1 and event_type = 'manifest.driver_assigned' and payload->>'reason' is not null`,
        [owner.businessId]
      );
      expect(reasons.rows.map((row) => row.reason)).toEqual(["stale_on_rejoin"]);
      // A trip assigned after joining is theirs, and a later join-release would not touch it.
      await deliveryOrder(owner, 900 * KG, alongX(0.6));
      const fresh = await createManifest(owner, { corridorId, vehicleId });
      await ok(
        app,
        "POST",
        url(owner, `manifests/${fresh.body.manifest.id}/driver`),
        owner.cookie,
        {
          driverUserId: driver.userId
        }
      );
      expect(
        await service.releaseDriverAssignments({
          businessId: owner.businessId,
          userId: driver.userId,
          joined: true,
          at: new Date(Date.now() - 60_000).toISOString()
        })
      ).toBe(0);
      expect(
        (
          await ok<Array<{ id: string }>>(app, "GET", url(owner, "my-manifests"), driver.cookie)
        ).map((entry) => entry.id)
      ).toEqual([fresh.body.manifest.id]);
      // A role that never delivered has nothing to release: skipped without touching trips.
      expect(
        await service.releaseDriverAssignments({
          businessId: owner.businessId,
          userId: driver.userId,
          previousRole: "cashier",
          joined: false
        })
      ).toBe(0);
    }, 60_000);

    it("serializes a reassignment racing the assigned driver's delivery", async () => {
      const { owner, corridorId, vehicleId } = await setupBusiness();
      const driver = await signUp(app);
      const other = await signUp(app);
      addMember(store, owner.businessId, driver.userId, "driver");
      addMember(store, owner.businessId, other.userId, "driver");
      // Two stops, so delivering one does not complete (and freeze) the manifest.
      await deliveryOrder(owner, 900 * KG, alongX(0.3));
      await deliveryOrder(owner, 900 * KG, alongX(0.6));
      const created = await createManifest(owner, { corridorId, vehicleId });
      const manifestId = created.body.manifest.id;
      await ok(app, "POST", url(owner, `manifests/${manifestId}/driver`), owner.cookie, {
        driverUserId: driver.userId
      });
      await ok(app, "POST", url(owner, `manifests/${manifestId}/close`), owner.cookie, {});
      const stopId = created.body.manifest.stops[0]?.id;
      // Hold the manifest row so both requests queue on the same lock, then release it.
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("select id from fulfillment_manifests where id = $1 for update", [
          manifestId
        ]);
        const reassign = request(
          app,
          "POST",
          url(owner, `manifests/${manifestId}/driver`),
          owner.cookie,
          {
            driverUserId: other.userId
          }
        );
        const deliver = request(
          app,
          "POST",
          url(owner, `manifests/${manifestId}/stops/${stopId}/delivery`),
          driver.cookie,
          { outcome: "DELIVERED" }
        );
        await new Promise((done) => setTimeout(done, 300));
        await blocker.query("commit");
        const [reassigned, delivered] = await Promise.all([reassign, deliver]);
        expect(reassigned.status).toBe(200);
        // Either the delivery ran first (while still assigned) or it sees the new assignment and
        // is refused; never a server error and never recorded by a driver no longer assigned.
        expect([200, 404]).toContain(delivered.status);
        const stop = await pool.query<{ delivery_status: string }>(
          "select delivery_status from fulfillment_manifest_stops where id = $1",
          [stopId]
        );
        expect(stop.rows[0]?.delivery_status).toBe(
          delivered.status === 200 ? "DELIVERED" : "PENDING"
        );
      } finally {
        blocker.release();
      }
    }, 60_000);
  });

  describe("MCP fulfillment tools", () => {
    it("lets an owner set up and run a corridor entirely through MCP", async () => {
      const owner = await createOwner(app, "MCP Wholesale");
      const mcp = await connectMcp(app, owner.cookie, owner.businessId);

      // Setup: nothing is pre-configured; the owner supplies their own business settings.
      expect(await mcp.ok("fulfillment.get_settings", {})).toMatchObject({ timezone: null });
      await mcp.ok("fulfillment.update_settings", {
        timezone: "Africa/Nairobi",
        expectedTimezone: null
      });
      expect(await mcp.ok("fulfillment.get_settings", {})).toMatchObject({
        businessId: owner.businessId,
        timezone: "Africa/Nairobi"
      });
      await mcp.ok("fulfillment.create_policy", {
        name: "Default",
        targetLoadGrams: String(6000 * KG),
        minimumDispatchLoadGrams: null,
        maxDiversionMeters: 2000,
        cutoffLocalTime: "18:00",
        maxWaitHours: 72,
        fulfillmentLeadDays: 1,
        underThresholdFallback: [],
        overflowStrategy: "NEXT_MANIFEST",
        makeBusinessDefault: true,
        idempotencyKey: "policy-1"
      });
      expect(await mcp.ok("fulfillment.get_default_policy", {})).toMatchObject({
        policy: { targetLoadGrams: "6000000", cutoffLocalTime: "18:00", isBusinessDefault: true }
      });
      const vehicleArgs = {
        name: "7-tonne truck",
        capacityGrams: String(7000 * KG),
        idempotencyKey: "vehicle-1"
      };
      const vehicle = await mcp.ok<{ id: string }>("fulfillment.create_vehicle", vehicleArgs);
      // A23 through MCP: a retried call with the same key returns the same vehicle, no duplicate.
      expect((await mcp.ok<{ id: string }>("fulfillment.create_vehicle", vehicleArgs)).id).toBe(
        vehicle.id
      );
      expect(
        await mcp.call("fulfillment.create_vehicle", { ...vehicleArgs, name: "Other" })
      ).toMatchObject({
        isError: true
      });
      expect(await mcp.ok<unknown[]>("fulfillment.list_vehicles", {})).toHaveLength(1);
      const corridor = await mcp.ok<{ id: string; geometryVersion: number }>(
        "fulfillment.create_corridor",
        {
          name: "Corridor X",
          originLabel: "Depot",
          destinationLabel: "Market",
          routeGeometry: corridorX,
          idempotencyKey: "corridor-1"
        }
      );

      // Orders arrive through the normal sales flow and pool on the corridor.
      const first = await deliveryOrder(owner, 900 * KG, alongX(0.8));
      const second = await deliveryOrder(owner, 900 * KG, alongX(0.2));
      const load = await mcp.ok<PoolView>("fulfillment.get_corridor_load", {
        corridorId: corridor.id
      });
      expect(load).toMatchObject({
        eligibleTotalWeightGrams: "1800000",
        readiness: "ACCUMULATING"
      });
      const shopMatch = await mcp.ok<{ status: string }>("fulfillment.match_shop_corridor", {
        customerId: first.customerId
      });
      expect(shopMatch.status).toBe("RESOLVED");

      // Dispatch through MCP; a retry with the same key replays the same manifest.
      const manifestArgs = {
        corridorId: corridor.id,
        vehicleId: vehicle.id,
        idempotencyKey: "manifest-1"
      };
      const created = await mcp.ok<CreateManifestResult>(
        "fulfillment.create_manifest",
        manifestArgs
      );
      const replayed = await mcp.ok<CreateManifestResult>(
        "fulfillment.create_manifest",
        manifestArgs
      );
      expect(replayed.manifest.id).toBe(created.manifest.id);
      expect(created.allocatedInvoiceIds.sort()).toEqual(
        [first.invoiceId, second.invoiceId].sort()
      );
      expect(created.manifest.totalWeightGrams).toBe("1800000");
      // Stops are sequenced by distance along the corridor: the 0.2 shop comes first.
      expect(created.manifest.stops.map((stop) => stop.invoiceId)).toEqual([
        second.invoiceId,
        first.invoiceId
      ]);
      const manifests = await mcp.ok<ManifestView[]>("fulfillment.list_manifests", {});
      expect(manifests.map((manifest) => manifest.id)).toEqual([created.manifest.id]);

      const closed = await mcp.ok<ManifestView>("fulfillment.close_manifest", {
        manifestId: created.manifest.id,
        idempotencyKey: "close-1"
      });
      // A replayed state transition is refused, never applied twice.
      expect(
        await mcp.call("fulfillment.close_manifest", {
          manifestId: created.manifest.id,
          idempotencyKey: "close-1"
        })
      ).toMatchObject({ isError: true, structuredContent: { code: "manifest_not_open" } });
      await mcp.ok("fulfillment.depart_manifest", {
        manifestId: closed.id,
        idempotencyKey: "depart-1"
      });
      // A repeated stop outcome is refused, and the error carries the stop's recorded status so an
      // agent can tell that its own first call landed.
      const firstStop = closed.stops[0] as ManifestView["stops"][number];
      await mcp.ok("fulfillment.record_delivery", {
        manifestId: closed.id,
        stopId: firstStop.id,
        outcome: "ARRIVED"
      });
      expect(
        await mcp.call("fulfillment.record_delivery", {
          manifestId: closed.id,
          stopId: firstStop.id,
          outcome: "ARRIVED"
        })
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "stop_already_recorded", details: { deliveryStatus: "ARRIVED" } }
      });
      for (const stop of closed.stops) {
        await mcp.ok("fulfillment.record_delivery", {
          manifestId: closed.id,
          stopId: stop.id,
          outcome: "DELIVERED",
          idempotencyKey: `deliver-${stop.id}`
        });
      }
      for (const order of [first, second]) {
        expect(
          await mcp.ok<{ state: string }>("fulfillment.get_order", { invoiceId: order.invoiceId })
        ).toMatchObject({ state: "DELIVERED" });
      }
      expect(
        await mcp.ok<ManifestView>("fulfillment.get_manifest", { manifestId: closed.id })
      ).toMatchObject({ status: "COMPLETED" });
    }, 60_000);

    it("replays keyed updates instead of re-applying them over a later change", async () => {
      const { owner, vehicleId } = await setupBusiness();
      const mcp = await connectMcp(app, owner.cookie, owner.businessId);
      const retire = { vehicleId, active: false, idempotencyKey: "retire-truck" };
      expect(await mcp.ok<{ active: boolean }>("fulfillment.update_vehicle", retire)).toMatchObject(
        {
          active: false
        }
      );
      // Meanwhile the owner reactivates the truck in the app (no key)...
      await ok(app, "PATCH", url(owner, `vehicles/${vehicleId}`), owner.cookie, { active: true });
      // ...and the agent's retry of its lost call replays the first result, it does not retire
      // the truck again.
      expect(await mcp.ok<{ active: boolean }>("fulfillment.update_vehicle", retire)).toMatchObject(
        {
          active: false
        }
      );
      const [truck] = await ok<Array<{ id: string; active: boolean }>>(
        app,
        "GET",
        url(owner, "vehicles?include=inactive"),
        owner.cookie
      );
      expect(truck).toMatchObject({ id: vehicleId, active: true });
      // The same key for a different change is refused, never silently applied.
      expect(
        await mcp.call("fulfillment.update_vehicle", { ...retire, name: "Renamed" })
      ).toMatchObject({ isError: true, structuredContent: { code: "idempotency_key_reused" } });

      // Same for the default policy pointer.
      const policies = await ok<Array<{ policyId: string }>>(
        app,
        "GET",
        url(owner, "policies"),
        owner.cookie
      );
      const original = (policies[0] as { policyId: string }).policyId;
      const second = await mcp.ok<{ policyId: string }>("fulfillment.create_policy", {
        name: "Busy season",
        targetLoadGrams: "5000000",
        maxDiversionMeters: 1500,
        cutoffLocalTime: "17:00",
        maxWaitHours: 48,
        fulfillmentLeadDays: 1,
        idempotencyKey: "policy-busy"
      });
      const pointAtSecond = { policyId: second.policyId, idempotencyKey: "default-busy" };
      await mcp.ok("fulfillment.set_default_policy", pointAtSecond);
      await ok(app, "PUT", url(owner, "default-policy"), owner.cookie, { policyId: original });
      await mcp.ok("fulfillment.set_default_policy", pointAtSecond);
      expect(
        await ok<{ defaultPolicyId: string }>(
          app,
          "GET",
          url(owner, "default-policy"),
          owner.cookie
        )
      ).toMatchObject({ defaultPolicyId: original });
    }, 60_000);

    it("refuses a revision based on an outdated version, over HTTP and MCP", async () => {
      const { owner } = await setupBusiness();
      const mcp = await connectMcp(app, owner.cookie, owner.businessId);
      const current = await ok<{ policy: { policyId: string; version: number } }>(
        app,
        "GET",
        url(owner, "default-policy"),
        owner.cookie
      );
      const { policyId, version } = current.policy;
      const rules = {
        name: "Default",
        targetLoadGrams: "9000000",
        maxDiversionMeters: 2000,
        cutoffLocalTime: "18:00",
        maxWaitHours: 72,
        fulfillmentLeadDays: 1
      };
      // An agent revises first, based on the current version...
      const agentRevision = await mcp.ok<{ version: number }>("fulfillment.revise_policy", {
        policyId,
        ...rules,
        expectedVersion: version,
        idempotencyKey: "agent-revision"
      });
      expect(agentRevision.version).toBe(version + 1);
      // ...so the owner's save, based on the same old version, is refused instead of undoing it.
      const stale = await request<{ code: string; details: Record<string, number> }>(
        app,
        "POST",
        url(owner, `policies/${policyId}/revisions`),
        owner.cookie,
        { ...rules, targetLoadGrams: "6000000", expectedVersion: version }
      );
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        code: "dispatch_policy_version_conflict",
        details: { expectedVersion: version, currentVersion: version + 1 }
      });
      expect(
        await mcp.call("fulfillment.revise_policy", {
          policyId,
          ...rules,
          expectedVersion: version,
          idempotencyKey: "second-agent-revision"
        })
      ).toMatchObject({
        isError: true,
        structuredContent: { code: "dispatch_policy_version_conflict" }
      });
      // The agent's lost-response retry still replays (idempotency is checked first).
      expect(
        (
          await mcp.ok<{ version: number }>("fulfillment.revise_policy", {
            policyId,
            ...rules,
            expectedVersion: version,
            idempotencyKey: "agent-revision"
          })
        ).version
      ).toBe(version + 1);
      expect(
        await ok<{ policy: { targetLoadGrams: string; version: number } }>(
          app,
          "GET",
          url(owner, "default-policy"),
          owner.cookie
        )
      ).toMatchObject({ policy: { targetLoadGrams: "9000000", version: version + 1 } });
    }, 60_000);

    it("refuses creating or revising the default on the basis of a default that changed", async () => {
      const owner = await createOwner(app, "Default Race Wholesale");
      const mcp = await connectMcp(app, owner.cookie, owner.businessId);
      const rules = {
        targetLoadGrams: "6000000",
        maxDiversionMeters: 2000,
        cutoffLocalTime: "18:00",
        maxWaitHours: 72,
        fulfillmentLeadDays: 1
      };
      // The owner opens an empty setup (no default). Meanwhile an agent creates the default.
      const agentPolicy = await mcp.ok<{ policyId: string }>("fulfillment.create_policy", {
        name: "Agent rules",
        ...rules,
        makeBusinessDefault: true,
        expectedDefaultPolicyId: null,
        idempotencyKey: "agent-create"
      });
      // The owner's "first" create, based on no default, is refused instead of replacing it.
      const ownerCreate = await request<{ code: string; details: Record<string, unknown> }>(
        app,
        "POST",
        url(owner, "policies"),
        owner.cookie,
        { name: "Owner rules", ...rules, makeBusinessDefault: true, expectedDefaultPolicyId: null }
      );
      expect(ownerCreate.status).toBe(409);
      expect(ownerCreate.body).toMatchObject({
        code: "default_policy_changed",
        details: { expectedDefaultPolicyId: null, defaultPolicyId: agentPolicy.policyId }
      });
      // The agent's lost-response retry still replays.
      expect(
        (
          await mcp.ok<{ policyId: string }>("fulfillment.create_policy", {
            name: "Agent rules",
            ...rules,
            makeBusinessDefault: true,
            expectedDefaultPolicyId: null,
            idempotencyKey: "agent-create"
          })
        ).policyId
      ).toBe(agentPolicy.policyId);

      // Now the agent switches the default to a second policy B...
      const second = await mcp.ok<{ policyId: string }>("fulfillment.create_policy", {
        name: "Busy season",
        ...rules,
        targetLoadGrams: "5000000",
        makeBusinessDefault: true,
        expectedDefaultPolicyId: agentPolicy.policyId,
        idempotencyKey: "agent-create-b"
      });
      // ...so revising A "as the default" is refused, though A's own version did not move.
      const staleRevision = await request<{ code: string }>(
        app,
        "POST",
        url(owner, `policies/${agentPolicy.policyId}/revisions`),
        owner.cookie,
        {
          name: "Owner edit",
          ...rules,
          expectedVersion: 1,
          expectedDefaultPolicyId: agentPolicy.policyId
        }
      );
      expect(staleRevision.status).toBe(409);
      expect(staleRevision.body.code).toBe("default_policy_changed");
      const effective = await ok<{
        defaultPolicyId: string;
        policy: { targetLoadGrams: string; version: number };
      }>(app, "GET", url(owner, "default-policy"), owner.cookie);
      expect(effective).toMatchObject({
        defaultPolicyId: second.policyId,
        policy: { targetLoadGrams: "5000000", version: 1 }
      });
      // Without the optional preconditions, the operations behave exactly as before.
      expect(
        await ok<{ version: number }>(
          app,
          "POST",
          url(owner, `policies/${agentPolicy.policyId}/revisions`),
          owner.cookie,
          { name: "Owner edit", ...rules }
        )
      ).toMatchObject({ version: 2 });
    }, 60_000);

    it("lets exactly one of several concurrent writers replace the same expected default", async () => {
      const owner = await createOwner(app, "Default Contention Wholesale");
      const rules = {
        targetLoadGrams: "6000000",
        maxDiversionMeters: 2000,
        cutoffLocalTime: "18:00",
        maxWaitHours: 72,
        fulfillmentLeadDays: 1
      };
      const original = await ok<{ policyId: string }>(
        app,
        "POST",
        url(owner, "policies"),
        owner.cookie,
        { name: "Original", ...rules, makeBusinessDefault: true, expectedDefaultPolicyId: null }
      );
      // Force the dangerous interleaving: another connection holds the pointer row while the
      // writers start, so every writer has begun before any of them can move the default. The
      // precondition read must queue on the row lock; a plain read would let all of them see the
      // original default and all of them "win".
      const blocker = await pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query(
          "select default_policy_id from fulfillment_business_settings where business_id = $1 for update",
          [owner.businessId]
        );
        const writes = Array.from({ length: 4 }, (_, index) =>
          request<{ code?: string }>(app, "POST", url(owner, "policies"), owner.cookie, {
            name: `Writer ${index}`,
            ...rules,
            makeBusinessDefault: true,
            expectedDefaultPolicyId: original.policyId
          })
        );
        await new Promise((done) => setTimeout(done, 400));
        await blocker.query("commit");
        const results = await Promise.all(writes);
        expect(results.filter((result) => result.status === 200)).toHaveLength(1);
        for (const result of results.filter((entry) => entry.status !== 200)) {
          expect(result).toMatchObject({ status: 409, body: { code: "default_policy_changed" } });
        }
      } finally {
        blocker.release();
      }
      const policies = await pool.query<{ count: number }>(
        "select count(*)::int as count from fulfillment_dispatch_policies where business_id = $1",
        [owner.businessId]
      );
      expect(policies.rows[0]?.count).toBe(2);
    }, 60_000);

    it("tells each caller what it may manage and redacts precise locations by role", async () => {
      const { owner } = await setupBusiness();
      const shop = await createCustomer(app, owner, "Mama Njeri Shop");
      await ok(app, "PUT", url(owner, `shops/${shop.id}/location`), owner.cookie, alongX(0.5));

      const ownerRead = await connectMcp(app, owner.cookie, owner.businessId, ["mcp:read"]);
      // The owner may manage, but not through a read-only token.
      expect(await ownerRead.ok("fulfillment.get_settings", {})).toMatchObject({
        viewerCanManage: false
      });
      const ownerAct = await connectMcp(app, owner.cookie, owner.businessId);
      expect(await ownerAct.ok("fulfillment.get_settings", {})).toMatchObject({
        viewerCanManage: true
      });
      // A read-only token cannot mutate, whatever the account's role.
      expect(
        await ownerRead.call("fulfillment.create_vehicle", {
          name: "Van",
          capacityGrams: "1000000",
          idempotencyKey: "k"
        })
      ).toMatchObject({ isError: true, structuredContent: { code: "mcp_scope_forbidden" } });
      expect(
        await ownerRead.ok<{ coordinatesRedacted: boolean }>("fulfillment.get_shop_location", {
          customerId: shop.id
        })
      ).toMatchObject({ coordinatesRedacted: false });

      const salesperson = await signUp(app);
      addMember(store, owner.businessId, salesperson.userId, "sales_agent");
      const sales = await connectMcp(app, salesperson.cookie, owner.businessId);
      expect(await sales.ok("fulfillment.get_settings", {})).toMatchObject({
        viewerCanManage: false
      });
      expect(
        await sales.ok("fulfillment.get_shop_location", { customerId: shop.id })
      ).toMatchObject({
        coordinatesRedacted: true,
        current: { latitude: null, longitude: null }
      });
      expect(
        await sales.call("fulfillment.list_shop_location_history", { customerId: shop.id })
      ).toMatchObject({ isError: true, structuredContent: { code: "permission_denied" } });
    }, 60_000);

    it("applies business roles and tenant isolation to MCP callers", async () => {
      const { owner, corridorId } = await setupBusiness();
      const salesperson = await signUp(app);
      addMember(store, owner.businessId, salesperson.userId, "sales_agent");
      const sales = await connectMcp(app, salesperson.cookie, owner.businessId);
      // A salesperson's token has mcp:act, but the role still cannot manage vehicles or policy.
      for (const [name, args] of [
        [
          "fulfillment.create_vehicle",
          { name: "Van", capacityGrams: "1000000", idempotencyKey: randomUUID() }
        ],
        ["fulfillment.update_settings", { timezone: "Africa/Kampala" }],
        [
          "fulfillment.cancel_manifest",
          { manifestId: randomUUID(), reason: "no", idempotencyKey: randomUUID() }
        ]
      ] as const) {
        expect(await sales.call(name, args), name).toMatchObject({
          isError: true,
          structuredContent: { code: "permission_denied" }
        });
      }

      // Another business's owner sees none of this business's corridors, even by id.
      const stranger = await createOwner(app, "Stranger Wholesale");
      const strangerMcp = await connectMcp(app, stranger.cookie, stranger.businessId);
      expect(await strangerMcp.ok<unknown[]>("fulfillment.list_corridors", {})).toEqual([]);
      const probe = await strangerMcp.call("fulfillment.get_corridor", { corridorId });
      expect(probe.isError).toBe(true);
      expect(
        await strangerMcp.call("fulfillment.list_pools", { shopId: owner.businessId })
      ).toMatchObject({ isError: true, structuredContent: { code: "mcp_shop_forbidden" } });
    }, 60_000);
  });
});
