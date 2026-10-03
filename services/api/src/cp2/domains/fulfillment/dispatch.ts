/**
 * Phase 1c fulfillment operations: order intake, corridor pools, manifests, cancellation and
 * delivery recording (docs/architecture/corridor-fulfillment.md §6, §13).
 *
 * Global lock order (A17, §6.1), identical in every operation here:
 *   1. fulfillment_corridors rows (ascending id)
 *   2. fulfillment_vehicles (Phase 2; not locked yet)
 *   3. fulfillment_manifests row
 *   4. fulfillment_orders rows (ascending id, or A21 candidate order in createManifest)
 *   5. fulfillment_manifest_stops rows
 * Row locks use stable predicates (`id`, `invoice_id`); decisions are made on a fresh re-read
 * after the locks (READ COMMITTED re-evaluates only the locked row, see §11.4). The partial
 * unique index on active stops and the manifest capacity CHECK are the database backstops.
 *
 * Pools and readiness are computed from live rows on every read (A13); nothing is materialized.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  allocateAutomatically,
  canTransitionManifest,
  roleCan,
  computePoolReadiness,
  evaluateDispatchPolicy,
  localDate,
  nextCutoff,
  percentOfTarget,
  type BusinessPermission,
  type ExplicitSelectionRejection
} from "@grogoni/business-core";
import {
  formatGrams,
  parseGrams,
  type ActivePoolsSummary,
  type ConfirmedOrderReference,
  type CorridorPoolDetailSummary,
  type CorridorPoolOrderSummary,
  type CorridorPoolSummary,
  type CorridorResolutionStatusSummary,
  type CreateManifestResultSummary,
  type DispatchApprovalDecision,
  type DispatchApprovalSummary,
  type DispatchEvaluationSummary,
  type FulfillmentStatus,
  type ManifestStatus,
  type ManifestStopDeliveryStatus,
  type ManifestStopReleaseReason,
  type ManifestStopSummary,
  type ManifestSummary,
  type OrderFulfillmentStatusSummary,
  type ResolveOrderCorridorResultSummary,
  type AssignableDriverSummary,
  type BusinessRole
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { FulfillmentRecheckConflict } from "./transaction.js";
import { upsertFulfillmentOrder, type FulfillmentOrderRow } from "./order-rows.js";

export interface DispatchActor {
  sessionId: string | null;
  businessId: string;
  idempotencyKey?: string | null;
  now?: Date;
  [scheduledEvaluation]?: true;
}

export type DeliveryOutcome = Exclude<ManifestStopDeliveryStatus, "PENDING">;

export interface IntakeResultSummary {
  invoiceId: string;
  outcome: "TAKEN_IN" | "ALREADY_TAKEN_IN" | "NOT_FOR_DELIVERY";
  fulfillmentOrderId: string | null;
  corridor: ResolveOrderCorridorResultSummary | null;
}

export interface DispatchOperations {
  getActivePools(input: DispatchActor): Promise<ActivePoolsSummary>;
  getCorridorPool(
    input: DispatchActor & { corridorId: string }
  ): Promise<CorridorPoolDetailSummary>;
  getOrderFulfillment(
    input: DispatchActor & { invoiceId: string }
  ): Promise<OrderFulfillmentStatusSummary>;
  intakeOrderForDispatcher(
    input: DispatchActor & { invoiceId: string }
  ): Promise<IntakeResultSummary>;
  createManifest(
    input: DispatchActor & {
      corridorId: string;
      vehicleId: string;
      orderIds?: string[];
      plannedDepartureAt?: string | null;
    }
  ): Promise<CreateManifestResultSummary>;
  listManifests(input: DispatchActor & { status?: ManifestStatus }): Promise<ManifestSummary[]>;
  getManifest(input: DispatchActor & { manifestId: string }): Promise<ManifestSummary>;
  removeOrderFromManifest(
    input: DispatchActor & { manifestId: string; invoiceId: string }
  ): Promise<ManifestSummary>;
  closeManifest(input: DispatchActor & { manifestId: string }): Promise<ManifestSummary>;
  departManifest(input: DispatchActor & { manifestId: string }): Promise<ManifestSummary>;
  /** Assign the trip to a member who can record deliveries, or unassign it (null). */
  assignManifestDriver(
    input: DispatchActor & { manifestId: string; driverUserId: string | null }
  ): Promise<ManifestSummary>;
  /** A driver's own open and in-progress trips (OPEN, CLOSED, DEPARTED), soonest first. */
  listMyManifests(input: DispatchActor): Promise<ManifestSummary[]>;
  /** Members a dispatcher may assign a manifest to. */
  listAssignableDrivers(input: DispatchActor): Promise<AssignableDriverSummary[]>;
  /**
   * System operation (no actor): after a member leaves the business or loses the delivery role,
   * unassign them from every trip that is not finished, so the dispatcher reassigns it and a
   * re-invited former driver does not get old trips back.
   */
  releaseDriverAssignments(input: {
    businessId: string;
    userId: string;
    /** Their role before the change; a role that never delivered has nothing to release. */
    previousRole?: BusinessRole | null;
    /**
     * Just joined: trips assigned to them before `at` (the join) are stale leftovers of an earlier
     * membership and are released; anything assigned since the join is kept.
     */
    joined?: boolean;
    /** When the membership change happened (ISO). */
    at?: string;
    now?: Date;
  }): Promise<number>;
  cancelManifest(
    input: DispatchActor & { manifestId: string; reason: string }
  ): Promise<ManifestSummary>;
  evaluateDispatch(
    input: DispatchActor & { corridorId: string }
  ): Promise<DispatchEvaluationSummary>;
  listDispatchApprovals(
    input: DispatchActor & { status?: "OPEN" | "APPROVED" | "DEFERRED" | "REJECTED" }
  ): Promise<DispatchApprovalSummary[]>;
  decideDispatchApproval(
    input: DispatchActor & {
      approvalId: string;
      decision: DispatchApprovalDecision;
      reason: string;
    }
  ): Promise<DispatchApprovalSummary>;
  recordDelivery(
    input: DispatchActor & {
      manifestId: string;
      stopId: string;
      outcome: DeliveryOutcome;
      note?: string | null;
    }
  ): Promise<ManifestSummary>;
  cancelOrderFulfillment(
    input: DispatchActor & { invoiceId: string; reason?: string | null }
  ): Promise<OrderFulfillmentStatusSummary>;
}

/** Trusted, never-routed operations (store intake hook and the reconciler). */
export interface DispatchInternalOperations {
  intakeOrder(input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now?: Date;
  }): Promise<IntakeResultSummary>;
  reconcileIntake(input?: { now?: Date; batchSize?: number }): Promise<{
    takenIn: number;
    orphaned: number;
    failed: number;
  }>;
  evaluateDueDispatches(input?: { now?: Date }): Promise<{
    evaluated: number;
    skipped: number;
    failed: number;
  }>;
}

const scheduledEvaluation = Symbol("scheduledEvaluation");

export interface DispatchOperationsContext {
  pool: Pool;
  authorize: (actor: DispatchActor, permission: BusinessPermission) => { userId: string };
  hasPermission: (actor: DispatchActor, permission: BusinessPermission) => boolean;
  requireConfirmedOrder: (businessId: string, invoiceId: string) => ConfirmedOrderReference;
  businessMembers: (
    businessId: string
  ) => Array<{ userId: string; displayName: string; role: BusinessRole }>;
  customerName: (businessId: string, customerId: string) => string | null;
  deliveryDetails: (
    businessId: string,
    invoiceId: string
  ) => {
    items: Array<{ productName: string; quantity: number }>;
    payOnDeliveryAmount: number | null;
  };
  businessTimezone: (businessId: string) => string | null;
  listIntakeCandidates: () => Array<{ businessId: string; invoiceId: string; actorId: string }>;
  existingInvoiceIds: (businessId: string, invoiceIds: readonly string[]) => Set<string>;
  applyLogisticsStatus: (input: {
    businessId: string;
    invoiceId: string;
    status: FulfillmentStatus;
    actorId: string;
  }) => void;
  getResolutionStatus: (
    actor: DispatchActor & { invoiceId: string }
  ) => Promise<CorridorResolutionStatusSummary>;
  resolveCorridorAsSystem: (input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now?: Date;
  }) => Promise<ResolveOrderCorridorResultSummary>;
  transaction: <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
  idempotent: <T>(
    client: PoolClient,
    actor: DispatchActor,
    operation: string,
    request: unknown,
    now: Date,
    mutate: () => Promise<T>
  ) => Promise<T>;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export function createDispatchOperations(
  context: DispatchOperationsContext
): DispatchOperations & DispatchInternalOperations {
  const { pool } = context;

  async function lockCorridor(client: PoolClient, businessId: string, corridorId: string) {
    if (!isUuid(corridorId))
      throw new Cp2Error(404, "corridor_not_found", "Corridor was not found.");
    const result = await client.query<CorridorLockRow>(
      "select id, name, active, geometry_version, policy_override_id from fulfillment_corridors where business_id = $1 and id = $2 for update",
      [businessId, corridorId]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Cp2Error(404, "corridor_not_found", "Corridor was not found.");
    return row;
  }

  async function lockCorridorsAscending(
    client: PoolClient,
    businessId: string,
    corridorIds: Array<string | null | undefined>
  ): Promise<void> {
    const ids = [
      ...new Set(corridorIds.filter((id): id is string => typeof id === "string"))
    ].sort();
    for (const id of ids) {
      await client.query(
        "select id from fulfillment_corridors where business_id = $1 and id = $2 for update",
        [businessId, id]
      );
    }
  }

  async function lockManifest(client: PoolClient, businessId: string, manifestId: string) {
    if (!isUuid(manifestId)) throw manifestNotFound();
    const result = await client.query<ManifestRow>(
      "select * from fulfillment_manifests where business_id = $1 and id = $2 for update",
      [businessId, manifestId]
    );
    const row = result.rows[0];
    if (row === undefined) throw manifestNotFound();
    return row;
  }

  async function lockOrderByInvoice(client: PoolClient, businessId: string, invoiceId: string) {
    const result = await client.query<FulfillmentOrderRow>(
      "select * from fulfillment_orders where business_id = $1 and invoice_id = $2 for update",
      [businessId, invoiceId]
    );
    return result.rows[0] ?? null;
  }

  /** Effective policy version: corridor override lineage ?? business default (A9). */
  async function effectivePolicy(
    client: PoolClient | Pool,
    businessId: string,
    policyOverrideId: string | null
  ): Promise<PolicyRow | null> {
    const result = await client.query<PolicyRow>(
      `
        select p.* from fulfillment_dispatch_policies p
        where p.business_id = $1 and p.active and p.policy_id = coalesce(
          $2::uuid,
          (select default_policy_id from fulfillment_business_settings where business_id = $1)
        )
      `,
      [businessId, policyOverrideId]
    );
    return result.rows[0] ?? null;
  }

  /** Live pool membership rows (pooled, taken-in orders) with staleness inputs. */
  async function pooledRows(
    client: PoolClient | Pool,
    businessId: string,
    filter: { corridorId?: string; fulfillmentOrderIds?: string[] } = {}
  ): Promise<PoolRow[]> {
    const result = await client.query<PoolRow>(
      `
        select o.id, o.invoice_id, o.customer_id, o.confirmed_at, o.weight_status,
               o.total_weight_grams, o.state,
               r.id as resolution_id, r.corridor_id, r.corridor_geometry_version,
               r.shop_location_id, r.distance_along_meters, r.diversion_meters,
               c.geometry_version as corridor_geometry_version_now,
               l.id as current_location_id, l.latitude, l.longitude
        from fulfillment_orders o
        left join fulfillment_corridor_resolutions r
          on r.business_id = o.business_id and r.fulfillment_order_id = o.id and r.superseded_at is null
        left join fulfillment_corridors c on c.business_id = o.business_id and c.id = r.corridor_id
        left join fulfillment_shop_locations l
          on l.business_id = o.business_id and l.customer_id = o.customer_id and l.superseded_at is null
        where o.business_id = $1
          and o.state = 'POOLED'
          and o.weight_status is not null
          and ($2::uuid is null or r.corridor_id = $2)
          and ($3::uuid[] is null or o.id = any($3::uuid[]))
        order by o.confirmed_at, o.id
      `,
      [businessId, filter.corridorId ?? null, filter.fulfillmentOrderIds ?? null]
    );
    return result.rows;
  }

  async function largestActiveVehicleCapacity(client: PoolClient | Pool, businessId: string) {
    const result = await client.query<{ capacity: string | null }>(
      "select max(capacity_grams)::text as capacity from fulfillment_vehicles where business_id = $1 and active",
      [businessId]
    );
    const capacity = result.rows[0]?.capacity ?? null;
    return capacity === null ? null : parseGrams(capacity, "capacityGrams");
  }

  function summarizePool(
    corridor: CorridorPoolCorridorRow,
    policy: PolicyRow | null,
    rows: PoolRow[],
    largestCapacity: bigint | null,
    timeZone: string | null,
    now: Date
  ): CorridorPoolSummary {
    let eligible = 0n;
    let allocatable = 0n;
    let eligibleCount = 0;
    let oldest: Date | null = null;
    let unresolvedWeightCount = 0;
    let unresolvedLocationCount = 0;
    let staleCount = 0;
    let requiresPlanningCount = 0;
    for (const row of rows) {
      const stale = staleReasons(row).length > 0;
      if (row.current_location_id === null) unresolvedLocationCount += 1;
      if (stale) staleCount += 1;
      if (row.weight_status !== "RESOLVED" || row.total_weight_grams === null) {
        unresolvedWeightCount += 1;
        continue;
      }
      const weight = parseGrams(row.total_weight_grams, "totalWeightGrams");
      eligible += weight;
      eligibleCount += 1;
      if (!stale) allocatable += weight;
      if (largestCapacity !== null && weight > largestCapacity) requiresPlanningCount += 1;
      if (oldest === null || row.confirmed_at < oldest) oldest = row.confirmed_at;
    }
    const target = policy === null ? null : parseGrams(policy.target_load_grams, "targetLoadGrams");
    const minimum =
      policy?.minimum_dispatch_load_grams == null
        ? null
        : parseGrams(policy.minimum_dispatch_load_grams, "minimumDispatchLoadGrams");
    const cutoff =
      policy === null || timeZone === null
        ? null
        : nextCutoff(now, timeZone, policy.cutoff_local_time);
    return {
      corridorId: corridor.id,
      corridorName: corridor.name,
      corridorActive: corridor.active,
      geometryVersion: corridor.geometry_version,
      policy:
        policy === null
          ? null
          : {
              policyId: policy.policy_id,
              version: policy.version,
              cutoffLocalTime: policy.cutoff_local_time,
              maxWaitHours: policy.max_wait_hours
            },
      eligibleOrderCount: eligibleCount,
      eligibleTotalWeightGrams: formatGrams(eligible),
      allocatableWeightGrams: formatGrams(allocatable),
      targetLoadGrams: target === null ? null : formatGrams(target),
      minimumDispatchLoadGrams: minimum === null ? null : formatGrams(minimum),
      percentFilled: target === null ? null : percentOfTarget(eligible, target),
      oldestWaitingOrderConfirmedAt: oldest === null ? null : (oldest as Date).toISOString(),
      oldestWaitingOrderAgeSeconds:
        oldest === null
          ? null
          : Math.max(0, Math.floor((now.getTime() - (oldest as Date).getTime()) / 1000)),
      nextCutoffAt: cutoff === null ? null : cutoff.at.toISOString(),
      timeUntilCutoffSeconds: cutoff === null ? null : Math.floor(cutoff.millisecondsUntil / 1000),
      readiness: target === null ? null : computePoolReadiness(allocatable, target, minimum),
      needsResolution: unresolvedWeightCount + unresolvedLocationCount + staleCount > 0,
      unresolvedWeightCount,
      unresolvedLocationCount,
      staleResolutionCount: staleCount,
      requiresPlanningCount
    };
  }

  async function manifestSummary(
    client: PoolClient | Pool,
    businessId: string,
    manifest: ManifestRow
  ): Promise<ManifestSummary> {
    const stops = await client.query<StopRow>(
      "select * from fulfillment_manifest_stops where business_id = $1 and manifest_id = $2 order by sequence",
      [businessId, manifest.id]
    );
    return {
      id: manifest.id,
      businessId: manifest.business_id,
      corridorId: manifest.corridor_id,
      corridorGeometryVersion: manifest.corridor_geometry_version,
      policyId: manifest.policy_id,
      policyVersion: manifest.policy_version,
      vehicleId: manifest.vehicle_id,
      vehicleCapacityGrams: manifest.vehicle_capacity_grams,
      status: manifest.status,
      totalWeightGrams: manifest.total_weight_grams,
      plannedDepartureAt: iso(manifest.planned_departure_at),
      closedAt: iso(manifest.closed_at),
      departedAt: iso(manifest.departed_at),
      completedAt: iso(manifest.completed_at),
      createdBy: manifest.created_by,
      createdAt: manifest.created_at.toISOString(),
      updatedAt: manifest.updated_at.toISOString(),
      driverUserId: manifest.driver_user_id,
      driverName:
        manifest.driver_user_id === null
          ? null
          : (context
              .businessMembers(businessId)
              .find((member) => member.userId === manifest.driver_user_id)?.displayName ?? null),
      stops: stops.rows.map((stop) =>
        stopSummary(stop, context.customerName, context.deliveryDetails)
      )
    };
  }

  async function appendOutbox(
    client: PoolClient,
    input: {
      businessId: string;
      eventType: string;
      eventKey: string;
      payload: Record<string, unknown>;
      now: Date;
    }
  ): Promise<void> {
    await client.query(
      `
        insert into fulfillment_outbox_events
          (id, business_id, event_type, event_key, payload, occurred_at)
        values ($1, $2, $3, $4, $5::jsonb, $6)
        on conflict (business_id, event_key) do nothing
      `,
      [
        randomUUID(),
        input.businessId,
        input.eventType,
        input.eventKey,
        JSON.stringify(input.payload),
        input.now
      ]
    );
  }

  async function reserveVehicle(
    client: PoolClient,
    input: {
      businessId: string;
      vehicleId: string;
      manifestId: string;
      serviceDate: string;
      now: Date;
    }
  ): Promise<void> {
    await client
      .query(
        `
          insert into fulfillment_vehicle_reservations
            (id, business_id, vehicle_id, manifest_id, service_date, active, created_at, updated_at)
          values ($1, $2, $3, $4, $5::date, true, $6, $6)
          on conflict (manifest_id) do nothing
        `,
        [
          randomUUID(),
          input.businessId,
          input.vehicleId,
          input.manifestId,
          input.serviceDate,
          input.now
        ]
      )
      .catch((error: unknown) => {
        if (isPgUniqueViolation(error)) {
          throw new Cp2Error(
            409,
            "vehicle_unavailable",
            "This vehicle is already reserved for that service day."
          );
        }
        throw error;
      });
  }

  /** Recomputes an OPEN manifest's loaded weight from its active stops (A12). */
  async function recomputeManifestTotal(client: PoolClient, manifestId: string, now: Date) {
    await client.query(
      `
        update fulfillment_manifests
        set total_weight_grams = coalesce((
              select sum(order_weight_grams) from fulfillment_manifest_stops
              where manifest_id = $1 and allocation_active
            ), 0),
            updated_at = $2
        where id = $1
      `,
      [manifestId, now]
    );
  }

  async function intakeOrder(input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now?: Date;
  }): Promise<IntakeResultSummary> {
    const now = input.now ?? new Date();
    const order = context.requireConfirmedOrder(input.businessId, input.invoiceId);
    if (!order.deliveryIntent) {
      return {
        invoiceId: input.invoiceId,
        outcome: "NOT_FOR_DELIVERY",
        fulfillmentOrderId: null,
        corridor: null
      };
    }
    const { row, created } = await context.transaction((client) =>
      upsertFulfillmentOrder(client, input.businessId, order, now)
    );
    if (created) {
      context.log("fulfillment.order_taken_in", {
        businessId: input.businessId,
        invoiceId: input.invoiceId,
        fulfillmentOrderId: row.id,
        weightStatus: row.weight_status,
        totalWeightGrams: row.total_weight_grams
      });
    }
    let corridor: ResolveOrderCorridorResultSummary | null = null;
    if (row.state === "POOLED") {
      const current = await pool.query(
        "select 1 from fulfillment_corridor_resolutions where business_id = $1 and fulfillment_order_id = $2 and superseded_at is null",
        [input.businessId, row.id]
      );
      if (current.rows.length === 0) {
        // Resolution failure never blocks the order: it stays visible as unassigned.
        corridor = await context.resolveCorridorAsSystem({
          businessId: input.businessId,
          invoiceId: input.invoiceId,
          actorId: input.actorId,
          now
        });
        if (corridor.outcome === "RESOLVED") {
          context.log("fulfillment.order_entered_pool", {
            businessId: input.businessId,
            invoiceId: input.invoiceId,
            corridorId: corridor.resolution.corridorId
          });
        }
      }
    }
    return {
      invoiceId: input.invoiceId,
      outcome: created ? "TAKEN_IN" : "ALREADY_TAKEN_IN",
      fulfillmentOrderId: row.id,
      corridor
    };
  }

  /** Moves a pooled order out of its pool (cancel/orphan) under the A17 lock order. */
  async function releasePooledOrder(
    client: PoolClient,
    businessId: string,
    invoiceId: string,
    mode: { state: "CANCELLED"; reason: string | null } | { state: "ORPHANED" },
    now: Date
  ): Promise<{ previousState: string; releasedManifestId: string | null }> {
    // 1. Unlocked pre-read of everything the lock set depends on.
    const pre = await client.query<{
      id: string;
      state: string;
      corridor_id: string | null;
      manifest_id: string | null;
    }>(
      `
        select o.id, o.state, r.corridor_id, s.manifest_id
        from fulfillment_orders o
        left join fulfillment_corridor_resolutions r
          on r.business_id = o.business_id and r.fulfillment_order_id = o.id and r.superseded_at is null
        left join fulfillment_manifest_stops s
          on s.business_id = o.business_id and s.fulfillment_order_id = o.id and s.allocation_active
        where o.business_id = $1 and o.invoice_id = $2
      `,
      [businessId, invoiceId]
    );
    const before = pre.rows[0];
    if (before === undefined) {
      throw new Cp2Error(
        404,
        "order_not_in_fulfillment",
        "This order is not in delivery planning."
      );
    }
    const manifestCorridor =
      before.manifest_id === null
        ? null
        : ((
            await client.query<{ corridor_id: string }>(
              "select corridor_id from fulfillment_manifests where id = $1",
              [before.manifest_id]
            )
          ).rows[0]?.corridor_id ?? null);
    // 2. Locks: corridors (ascending) -> manifest -> order.
    await lockCorridorsAscending(client, businessId, [before.corridor_id, manifestCorridor]);
    const manifest =
      before.manifest_id === null
        ? null
        : await lockManifest(client, businessId, before.manifest_id);
    const order = await lockOrderByInvoice(client, businessId, invoiceId);
    // 3. Recheck on fresh reads; anything moved -> bounded retry.
    const post = await client.query<{ corridor_id: string | null; manifest_id: string | null }>(
      `
        select r.corridor_id, s.manifest_id
        from fulfillment_orders o
        left join fulfillment_corridor_resolutions r
          on r.business_id = o.business_id and r.fulfillment_order_id = o.id and r.superseded_at is null
        left join fulfillment_manifest_stops s
          on s.business_id = o.business_id and s.fulfillment_order_id = o.id and s.allocation_active
        where o.business_id = $1 and o.invoice_id = $2
      `,
      [businessId, invoiceId]
    );
    const after = post.rows[0];
    if (
      order === null ||
      order.state !== before.state ||
      (after?.corridor_id ?? null) !== before.corridor_id ||
      (after?.manifest_id ?? null) !== before.manifest_id
    ) {
      throw new FulfillmentRecheckConflict();
    }
    // 4. A12 by state.
    if (order.state === "ALLOCATED") {
      if (mode.state === "ORPHANED") {
        return { previousState: order.state, releasedManifestId: null };
      }
      if (manifest === null || manifest.status !== "OPEN") {
        throw new Cp2Error(
          409,
          "order_dispatched",
          "This order is on a closed or departed manifest. Record the stop as skipped instead.",
          false,
          { manifestStatus: manifest?.status ?? null }
        );
      }
      await client.query(
        `
          update fulfillment_manifest_stops
          set allocation_active = false, released_at = $3, release_reason = 'ORDER_CANCELLED', updated_at = $3
          where business_id = $1 and fulfillment_order_id = $2 and allocation_active
        `,
        [businessId, order.id, now]
      );
      await recomputeManifestTotal(client, manifest.id, now);
    } else if (order.state !== "POOLED") {
      throw new Cp2Error(
        409,
        "order_not_pooled",
        "This order is no longer waiting for delivery.",
        false,
        {
          state: order.state
        }
      );
    }
    await client.query(
      `
        update fulfillment_orders
        set state = $3, cancelled_at = case when $3 = 'CANCELLED' then $4 else cancelled_at end,
            cancel_reason = case when $3 = 'CANCELLED' then $5 else cancel_reason end, updated_at = $4
        where business_id = $1 and id = $2
      `,
      [businessId, order.id, mode.state, now, mode.state === "CANCELLED" ? mode.reason : null]
    );
    return { previousState: order.state, releasedManifestId: manifest?.id ?? null };
  }

  const operations: DispatchOperations & DispatchInternalOperations = {
    intakeOrder,

    async reconcileIntake(options = {}) {
      const now = options.now ?? new Date();
      const batchSize = options.batchSize ?? 200;
      const candidates = context.listIntakeCandidates();
      const byBusiness = new Map<string, typeof candidates>();
      for (const candidate of candidates) {
        byBusiness.set(candidate.businessId, [
          ...(byBusiness.get(candidate.businessId) ?? []),
          candidate
        ]);
      }
      let takenIn = 0;
      let failed = 0;
      for (const [businessId, entries] of byBusiness) {
        const existing = await pool.query<{ invoice_id: string }>(
          "select invoice_id from fulfillment_orders where business_id = $1 and invoice_id = any($2::uuid[]) and weight_status is not null",
          [businessId, entries.map((entry) => entry.invoiceId).filter(isUuid)]
        );
        const known = new Set(existing.rows.map((row) => row.invoice_id));
        for (const entry of entries.filter((candidate) => !known.has(candidate.invoiceId))) {
          if (takenIn + failed >= batchSize) break;
          try {
            await intakeOrder({ ...entry, now });
            takenIn += 1;
          } catch (error) {
            failed += 1;
            context.log("fulfillment.intake_reconcile_failed", {
              businessId,
              invoiceId: entry.invoiceId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      // Orphans: a pooled order whose invoice no longer exists (e.g. an unpersisted confirmation
      // lost in a crash). Flagged, never deleted (§5.3).
      let orphaned = 0;
      const pooled = await pool.query<{ business_id: string; invoice_id: string }>(
        "select business_id, invoice_id from fulfillment_orders where state = 'POOLED'"
      );
      const pooledByBusiness = new Map<string, string[]>();
      for (const row of pooled.rows) {
        pooledByBusiness.set(row.business_id, [
          ...(pooledByBusiness.get(row.business_id) ?? []),
          row.invoice_id
        ]);
      }
      for (const [businessId, invoiceIds] of pooledByBusiness) {
        const present = context.existingInvoiceIds(businessId, invoiceIds);
        for (const invoiceId of invoiceIds.filter((id) => !present.has(id))) {
          try {
            await context.transaction((client) =>
              releasePooledOrder(client, businessId, invoiceId, { state: "ORPHANED" }, now)
            );
            orphaned += 1;
            context.log("fulfillment.order_orphaned", { businessId, invoiceId });
          } catch (error) {
            failed += 1;
            context.log("fulfillment.orphan_mark_failed", {
              businessId,
              invoiceId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
      return { takenIn, orphaned, failed };
    },

    async intakeOrderForDispatcher(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const order = context.requireConfirmedOrder(actor.businessId, actor.invoiceId);
      if (!order.deliveryIntent) {
        throw new Cp2Error(
          409,
          "order_not_for_delivery",
          "Record this order for delivery before adding it to delivery planning."
        );
      }
      return intakeOrder({
        businessId: actor.businessId,
        invoiceId: actor.invoiceId,
        actorId: userId,
        ...(actor.now === undefined ? {} : { now: actor.now })
      });
    },

    async getActivePools(actor) {
      context.authorize(actor, "fulfillment:read");
      const now = actor.now ?? new Date();
      const corridors = await pool.query<CorridorPoolCorridorRow>(
        "select id, name, active, geometry_version, policy_override_id from fulfillment_corridors where business_id = $1 order by priority, name, id",
        [actor.businessId]
      );
      const rows = await pooledRows(pool, actor.businessId);
      const largest = await largestActiveVehicleCapacity(pool, actor.businessId);
      const timeZone = context.businessTimezone(actor.businessId);
      const openApprovals = await pool.query<{ corridor_id: string }>(
        "select corridor_id from fulfillment_dispatch_approvals where business_id = $1 and status = 'OPEN'",
        [actor.businessId]
      );
      const approvalCorridors = new Set(openApprovals.rows.map((row) => row.corridor_id));
      const pools: CorridorPoolSummary[] = [];
      for (const corridor of corridors.rows) {
        const members = rows.filter((row) => row.corridor_id === corridor.id);
        if (!corridor.active && members.length === 0) continue;
        const policy = await effectivePolicy(pool, actor.businessId, corridor.policy_override_id);
        const summary = summarizePool(corridor, policy, members, largest, timeZone, now);
        pools.push(
          approvalCorridors.has(corridor.id)
            ? { ...summary, readiness: "APPROVAL_REQUIRED" }
            : summary
        );
      }
      const unassigned = rows.filter((row) => row.corridor_id === null);
      const candidates = context
        .listIntakeCandidates()
        .filter((candidate) => candidate.businessId === actor.businessId);
      const takenIn = await pool.query<{ invoice_id: string }>(
        "select invoice_id from fulfillment_orders where business_id = $1 and weight_status is not null",
        [actor.businessId]
      );
      const known = new Set(takenIn.rows.map((row) => row.invoice_id));
      const orphaned = await pool.query<{ count: number }>(
        "select count(*)::int as count from fulfillment_orders where business_id = $1 and state = 'ORPHANED'",
        [actor.businessId]
      );
      return {
        businessId: actor.businessId,
        timezone: timeZone,
        generatedAt: now.toISOString(),
        pools,
        unassigned: {
          orderCount: unassigned.length,
          unresolvedLocationCount: unassigned.filter((row) => row.current_location_id === null)
            .length,
          noCorridorCount: unassigned.filter((row) => row.current_location_id !== null).length,
          unresolvedWeightCount: unassigned.filter((row) => row.weight_status !== "RESOLVED")
            .length,
          pendingIntakeCount: candidates.filter((candidate) => !known.has(candidate.invoiceId))
            .length,
          orphanedCount: orphaned.rows[0]?.count ?? 0
        }
      };
    },

    async getCorridorPool(actor) {
      // Order-level detail is for dispatchers; salespeople see the aggregate pools (A8 "limited").
      context.authorize(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      if (!isUuid(actor.corridorId))
        throw new Cp2Error(404, "corridor_not_found", "Corridor was not found.");
      const corridor = (
        await pool.query<CorridorPoolCorridorRow>(
          "select id, name, active, geometry_version, policy_override_id from fulfillment_corridors where business_id = $1 and id = $2",
          [actor.businessId, actor.corridorId]
        )
      ).rows[0];
      if (corridor === undefined)
        throw new Cp2Error(404, "corridor_not_found", "Corridor was not found.");
      const rows = await pooledRows(pool, actor.businessId, { corridorId: corridor.id });
      const largest = await largestActiveVehicleCapacity(pool, actor.businessId);
      const policy = await effectivePolicy(pool, actor.businessId, corridor.policy_override_id);
      const summary = summarizePool(
        corridor,
        policy,
        rows,
        largest,
        context.businessTimezone(actor.businessId),
        now
      );
      const openApproval = await pool.query(
        "select 1 from fulfillment_dispatch_approvals where business_id = $1 and corridor_id = $2 and status = 'OPEN' limit 1",
        [actor.businessId, corridor.id]
      );
      const effectiveSummary: CorridorPoolSummary =
        openApproval.rows.length > 0 ? { ...summary, readiness: "APPROVAL_REQUIRED" } : summary;
      const orders: CorridorPoolOrderSummary[] = rows.map((row) => {
        const weight =
          row.weight_status === "RESOLVED" && row.total_weight_grams !== null
            ? parseGrams(row.total_weight_grams, "totalWeightGrams")
            : null;
        return {
          invoiceId: row.invoice_id,
          fulfillmentOrderId: row.id,
          customerId: row.customer_id,
          customerName:
            row.customer_id === null
              ? null
              : context.customerName(actor.businessId, row.customer_id),
          confirmedAt: row.confirmed_at.toISOString(),
          ageSeconds: Math.max(0, Math.floor((now.getTime() - row.confirmed_at.getTime()) / 1000)),
          weightStatus: row.weight_status === "RESOLVED" ? "RESOLVED" : "UNRESOLVED",
          totalWeightGrams: weight === null ? null : formatGrams(weight),
          stale: staleReasons(row).length > 0,
          staleReasons: staleReasons(row),
          distanceAlongMeters: Number(row.distance_along_meters ?? 0),
          diversionMeters: Number(row.diversion_meters ?? 0),
          requiresPlanning: weight !== null && largest !== null && weight > largest
        };
      });
      return { ...effectiveSummary, orders };
    },

    async getOrderFulfillment(actor) {
      context.authorize(actor, "fulfillment:read");
      const order = context.requireConfirmedOrder(actor.businessId, actor.invoiceId);
      const row = (
        await pool.query<FulfillmentOrderRow>(
          "select * from fulfillment_orders where business_id = $1 and invoice_id = $2",
          [actor.businessId, actor.invoiceId]
        )
      ).rows[0];
      const allocation = (
        await pool.query<{
          manifest_id: string;
          status: ManifestStatus;
          stop_id: string;
          sequence: number;
          delivery_status: ManifestStopDeliveryStatus;
        }>(
          `
            select s.manifest_id, m.status, s.id as stop_id, s.sequence, s.delivery_status
            from fulfillment_manifest_stops s
            join fulfillment_manifests m on m.business_id = s.business_id and m.id = s.manifest_id
            join fulfillment_orders o on o.business_id = s.business_id and o.id = s.fulfillment_order_id
            where s.business_id = $1 and o.invoice_id = $2 and s.allocation_active
          `,
          [actor.businessId, actor.invoiceId]
        )
      ).rows[0];
      const taken = row !== undefined && row.weight_status !== null;
      return {
        businessId: actor.businessId,
        invoiceId: actor.invoiceId,
        intakeStatus: !order.deliveryIntent
          ? "NOT_FOR_DELIVERY"
          : taken
            ? "TAKEN_IN"
            : "PENDING_INTAKE",
        state: row === undefined ? null : row.state,
        weight: order.weight,
        corridor: row === undefined ? null : await context.getResolutionStatus(actor),
        allocation:
          allocation === undefined
            ? null
            : {
                manifestId: allocation.manifest_id,
                manifestStatus: allocation.status,
                stopId: allocation.stop_id,
                sequence: allocation.sequence,
                deliveryStatus: allocation.delivery_status
              }
      };
    },

    async createManifest(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      const explicit = actor.orderIds;
      if (explicit !== undefined) {
        if (explicit.length === 0 || explicit.length > 500) {
          throw new Cp2Error(400, "invalid_selection", "Select between 1 and 500 orders.");
        }
      }
      const plannedDepartureAt =
        actor.plannedDepartureAt === undefined || actor.plannedDepartureAt === null
          ? null
          : new Date(actor.plannedDepartureAt);
      if (plannedDepartureAt !== null && Number.isNaN(plannedDepartureAt.getTime())) {
        throw new Cp2Error(
          400,
          "planned_departure_invalid",
          "Planned departure must be an ISO timestamp."
        );
      }
      const request = {
        corridorId: actor.corridorId,
        vehicleId: actor.vehicleId,
        orderIds: explicit === undefined ? null : [...explicit].sort(),
        plannedDepartureAt: plannedDepartureAt?.toISOString() ?? null
      };
      const result = await context.transaction(async (client) => {
        // (1) Stable serialization point for pool allocation: the corridor row (A17).
        const corridor = await lockCorridor(client, actor.businessId, actor.corridorId);
        return context.idempotent(
          client,
          actor,
          "fulfillment.createManifest",
          request,
          now,
          async () => {
            if (!corridor.active) {
              throw new Cp2Error(409, "corridor_inactive", "This corridor is not active.");
            }
            const policy = await effectivePolicy(
              client,
              actor.businessId,
              corridor.policy_override_id
            );
            if (policy === null) {
              throw new Cp2Error(
                422,
                "no_dispatch_policy",
                "This corridor has no dispatch policy."
              );
            }
            if (!isUuid(actor.vehicleId))
              throw new Cp2Error(404, "vehicle_not_found", "Vehicle was not found.");
            const vehicle = (
              await client.query<{ id: string; capacity_grams: string; active: boolean }>(
                "select id, capacity_grams, active from fulfillment_vehicles where business_id = $1 and id = $2 for update",
                [actor.businessId, actor.vehicleId]
              )
            ).rows[0];
            if (vehicle === undefined)
              throw new Cp2Error(404, "vehicle_not_found", "Vehicle was not found.");
            if (!vehicle.active)
              throw new Cp2Error(409, "vehicle_inactive", "This vehicle is not active.");
            const capacity = parseGrams(vehicle.capacity_grams, "capacityGrams");

            // (4) Lock the candidate order rows, then decide on a fresh re-read under the locks.
            let lockedIds: string[];
            if (explicit === undefined) {
              const locked = await client.query<{ id: string }>(
                `
                select o.id from fulfillment_orders o
                join fulfillment_corridor_resolutions r
                  on r.business_id = o.business_id and r.fulfillment_order_id = o.id and r.superseded_at is null
                where o.business_id = $1 and r.corridor_id = $2 and o.state = 'POOLED'
                  and o.weight_status = 'RESOLVED'
                order by o.confirmed_at, o.id
                for update of o
              `,
                [actor.businessId, corridor.id]
              );
              lockedIds = locked.rows.map((row) => row.id);
            } else {
              const locked = await client.query<{ id: string }>(
                `
                select id from fulfillment_orders
                where business_id = $1 and invoice_id = any($2::uuid[])
                order by id
                for update
              `,
                [actor.businessId, explicit.filter(isUuid)]
              );
              lockedIds = locked.rows.map((row) => row.id);
            }
            const fresh = await client.query<PoolRow>(
              `
              select o.id, o.invoice_id, o.customer_id, o.confirmed_at, o.weight_status,
                     o.total_weight_grams, o.state,
                     r.id as resolution_id, r.corridor_id, r.corridor_geometry_version,
                     r.shop_location_id, r.distance_along_meters, r.diversion_meters,
                     c.geometry_version as corridor_geometry_version_now,
                     l.id as current_location_id, l.latitude, l.longitude
              from fulfillment_orders o
              left join fulfillment_corridor_resolutions r
                on r.business_id = o.business_id and r.fulfillment_order_id = o.id and r.superseded_at is null
              left join fulfillment_corridors c on c.business_id = o.business_id and c.id = r.corridor_id
              left join fulfillment_shop_locations l
                on l.business_id = o.business_id and l.customer_id = o.customer_id and l.superseded_at is null
              where o.business_id = $1 and o.id = any($2::uuid[])
            `,
              [actor.businessId, lockedIds]
            );
            const eligible = (row: PoolRow): ExplicitSelectionRejection | null => {
              if (row.state === "ALLOCATED") return "ALREADY_ALLOCATED";
              if (row.state !== "POOLED") return "NOT_POOLED";
              if (row.weight_status !== "RESOLVED" || row.total_weight_grams === null)
                return "WEIGHT_UNRESOLVED";
              if (row.corridor_id !== corridor.id) return "WRONG_CORRIDOR";
              if (staleReasons(row).length > 0) return "STALE_RESOLUTION";
              return null;
            };
            const toCandidate = (row: PoolRow) => ({
              id: row.id,
              row,
              weightGrams: parseGrams(row.total_weight_grams as string, "totalWeightGrams"),
              confirmedAt: row.confirmed_at.toISOString()
            });

            let allocated: Array<ReturnType<typeof toCandidate>>;
            let skipped: Array<ReturnType<typeof toCandidate>> = [];
            let requiresPlanning: Array<ReturnType<typeof toCandidate>> = [];
            if (explicit === undefined) {
              const walk = allocateAutomatically(
                fresh.rows.filter((row) => eligible(row) === null).map(toCandidate),
                capacity
              );
              allocated = walk.allocated;
              skipped = walk.skipped;
              requiresPlanning = walk.requiresPlanning;
              if (allocated.length === 0) {
                throw new Cp2Error(
                  409,
                  "nothing_to_allocate",
                  "No pooled order fits this vehicle right now.",
                  false,
                  {
                    skippedCount: skipped.length,
                    requiresPlanningCount: requiresPlanning.length
                  }
                );
              }
              for (const entry of requiresPlanning) {
                context.log("fulfillment.order_requires_planning", {
                  businessId: actor.businessId,
                  invoiceId: entry.row.invoice_id,
                  vehicleId: vehicle.id
                });
              }
            } else {
              // A21 explicit selection is all-or-nothing.
              const byInvoice = new Map(fresh.rows.map((row) => [row.invoice_id, row]));
              const rejections: Array<{
                orderId: string;
                reason: ExplicitSelectionRejection | "CAPACITY_EXCEEDED";
              }> = [];
              const seen = new Set<string>();
              for (const orderId of explicit) {
                if (seen.has(orderId)) {
                  rejections.push({ orderId, reason: "DUPLICATE" });
                  continue;
                }
                seen.add(orderId);
                const row = byInvoice.get(orderId);
                const reason = row === undefined ? "NOT_FOUND" : eligible(row);
                if (reason !== null) rejections.push({ orderId, reason });
              }
              const selected = [...seen]
                .map((id) => byInvoice.get(id))
                .filter((row): row is PoolRow => row !== undefined);
              if (rejections.length === 0) {
                const total = selected.reduce(
                  (sum, row) =>
                    sum + parseGrams(row.total_weight_grams as string, "totalWeightGrams"),
                  0n
                );
                if (total > capacity) {
                  for (const row of selected)
                    rejections.push({ orderId: row.invoice_id, reason: "CAPACITY_EXCEEDED" });
                }
              }
              if (rejections.length > 0) {
                context.log("fulfillment.explicit_selection_rejected", {
                  businessId: actor.businessId,
                  corridorId: corridor.id,
                  rejectionCount: rejections.length
                });
                throw new Cp2Error(
                  422,
                  "invalid_selection",
                  "Some selected orders cannot be loaded on this manifest.",
                  false,
                  {
                    rejections
                  }
                );
              }
              allocated = selected.map(toCandidate);
            }

            const total = allocated.reduce((sum, entry) => sum + entry.weightGrams, 0n);
            const manifestId = randomUUID();
            await client.query(
              `
              insert into fulfillment_manifests
                (id, business_id, corridor_id, corridor_geometry_version, policy_version_id, policy_id,
                 policy_version, vehicle_id, vehicle_capacity_grams, status, total_weight_grams,
                 planned_departure_at, created_by, created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, 'OPEN', $10::bigint, $11, $12, $13, $13)
            `,
              [
                manifestId,
                actor.businessId,
                corridor.id,
                corridor.geometry_version,
                policy.id,
                policy.policy_id,
                policy.version,
                vehicle.id,
                formatGrams(capacity),
                formatGrams(total),
                plannedDepartureAt,
                userId,
                now
              ]
            );
            if (plannedDepartureAt !== null) {
              const timeZone = context.businessTimezone(actor.businessId);
              if (timeZone === null) {
                throw new Cp2Error(
                  422,
                  "business_timezone_required",
                  "Configure the business timezone before scheduling a vehicle."
                );
              }
              await reserveVehicle(client, {
                businessId: actor.businessId,
                vehicleId: vehicle.id,
                manifestId,
                serviceDate: formatLocalDate(plannedDepartureAt, timeZone),
                now
              });
            }
            // Stops in road order: snapshotted distance along the corridor, then order id.
            const ordered = [...allocated].sort(
              (left, right) =>
                Number(left.row.distance_along_meters) - Number(right.row.distance_along_meters) ||
                (left.row.invoice_id < right.row.invoice_id ? -1 : 1)
            );
            let sequence = 0;
            for (const entry of ordered) {
              sequence += 1;
              await client.query(
                `
                insert into fulfillment_manifest_stops
                  (id, business_id, manifest_id, fulfillment_order_id, invoice_id, customer_id,
                   corridor_resolution_id, shop_location_id, sequence, distance_along_meters,
                   diversion_meters, latitude, longitude, order_weight_grams, allocation_active,
                   delivery_status, created_at, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::bigint, true,
                        'PENDING', $15, $15)
              `,
                [
                  randomUUID(),
                  actor.businessId,
                  manifestId,
                  entry.row.id,
                  entry.row.invoice_id,
                  entry.row.customer_id,
                  entry.row.resolution_id,
                  entry.row.shop_location_id,
                  sequence,
                  entry.row.distance_along_meters,
                  entry.row.diversion_meters,
                  entry.row.latitude,
                  entry.row.longitude,
                  formatGrams(entry.weightGrams),
                  now
                ]
              );
            }
            await client.query(
              "update fulfillment_orders set state = 'ALLOCATED', updated_at = $3 where business_id = $1 and id = any($2::uuid[])",
              [actor.businessId, allocated.map((entry) => entry.id), now]
            );
            const manifest = (
              await client.query<ManifestRow>("select * from fulfillment_manifests where id = $1", [
                manifestId
              ])
            ).rows[0] as ManifestRow;
            const summary = await manifestSummary(client, actor.businessId, manifest);
            await appendOutbox(client, {
              businessId: actor.businessId,
              eventType: "manifest.created",
              eventKey: `manifest.created:${manifestId}`,
              payload: {
                manifestId,
                corridorId: corridor.id,
                vehicleId: vehicle.id,
                totalWeightGrams: summary.totalWeightGrams,
                invoiceIds: summary.stops.map((stop) => stop.invoiceId)
              },
              now
            });
            context.log("fulfillment.manifest_created", {
              businessId: actor.businessId,
              manifestId,
              corridorId: corridor.id,
              vehicleId: vehicle.id,
              stopCount: allocated.length,
              totalWeightGrams: summary.totalWeightGrams,
              selection: explicit === undefined ? "AUTOMATIC" : "EXPLICIT"
            });
            for (const entry of skipped) {
              context.log("fulfillment.order_skipped_for_capacity", {
                businessId: actor.businessId,
                manifestId,
                invoiceId: entry.row.invoice_id
              });
            }
            return {
              manifest: summary,
              allocatedInvoiceIds: allocated.map((entry) => entry.row.invoice_id),
              skippedInvoiceIds: skipped.map((entry) => entry.row.invoice_id),
              requiresPlanningInvoiceIds: requiresPlanning.map((entry) => entry.row.invoice_id)
            };
          }
        );
      });
      for (const invoiceId of result.allocatedInvoiceIds) {
        context.applyLogisticsStatus({
          businessId: actor.businessId,
          invoiceId,
          status: "ready",
          actorId: userId
        });
      }
      return result;
    },

    async listManifests(actor) {
      context.authorize(actor, "fulfillment:read");
      const result = await pool.query<ManifestRow>(
        `
          select * from fulfillment_manifests
          where business_id = $1 and ($2::text is null or status = $2)
          order by created_at desc, id
          limit 200
        `,
        [actor.businessId, actor.status ?? null]
      );
      return Promise.all(result.rows.map((row) => manifestSummary(pool, actor.businessId, row)));
    },

    async getManifest(actor) {
      context.authorize(actor, "fulfillment:read");
      if (!isUuid(actor.manifestId)) throw manifestNotFound();
      const row = (
        await pool.query<ManifestRow>(
          "select * from fulfillment_manifests where business_id = $1 and id = $2",
          [actor.businessId, actor.manifestId]
        )
      ).rows[0];
      if (row === undefined) throw manifestNotFound();
      return manifestSummary(pool, actor.businessId, row);
    },

    async removeOrderFromManifest(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      if (!isUuid(actor.manifestId)) throw manifestNotFound();
      const pre = (
        await pool.query<{ corridor_id: string }>(
          "select corridor_id from fulfillment_manifests where business_id = $1 and id = $2",
          [actor.businessId, actor.manifestId]
        )
      ).rows[0];
      if (pre === undefined) throw manifestNotFound();
      const summary = await context.transaction(async (client) => {
        await lockCorridorsAscending(client, actor.businessId, [pre.corridor_id]);
        const manifest = await lockManifest(client, actor.businessId, actor.manifestId);
        if (manifest.status !== "OPEN") {
          throw new Cp2Error(
            409,
            "manifest_not_open",
            "Orders can only be removed from an open manifest.",
            false,
            {
              status: manifest.status
            }
          );
        }
        const order = await lockOrderByInvoice(client, actor.businessId, actor.invoiceId);
        const stop =
          order === null
            ? undefined
            : (
                await client.query<StopRow>(
                  "select * from fulfillment_manifest_stops where manifest_id = $1 and fulfillment_order_id = $2 and allocation_active for update",
                  [manifest.id, order.id]
                )
              ).rows[0];
        if (order === null || stop === undefined) {
          throw new Cp2Error(404, "stop_not_found", "That order is not on this manifest.");
        }
        await client.query(
          `
            update fulfillment_manifest_stops
            set allocation_active = false, released_at = $2, release_reason = 'REMOVED_BY_DISPATCHER', updated_at = $2
            where id = $1
          `,
          [stop.id, now]
        );
        await client.query(
          "update fulfillment_orders set state = 'POOLED', updated_at = $2 where id = $1",
          [order.id, now]
        );
        await recomputeManifestTotal(client, manifest.id, now);
        const refreshed = await lockManifest(client, actor.businessId, manifest.id);
        context.log("fulfillment.order_removed_from_manifest", {
          businessId: actor.businessId,
          manifestId: manifest.id,
          invoiceId: actor.invoiceId,
          actorId: userId
        });
        return manifestSummary(client, actor.businessId, refreshed);
      });
      return summary;
    },

    async closeManifest(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      return context.transaction(async (client) => {
        const manifest = await lockManifest(client, actor.businessId, actor.manifestId);
        if (manifest.status !== "OPEN") {
          throw new Cp2Error(
            409,
            "manifest_not_open",
            "Only an open manifest can be closed.",
            false,
            {
              status: manifest.status
            }
          );
        }
        const active = await client.query(
          "select 1 from fulfillment_manifest_stops where manifest_id = $1 and allocation_active limit 1",
          [manifest.id]
        );
        if (active.rows.length === 0) {
          throw new Cp2Error(
            409,
            "manifest_empty",
            "A manifest needs at least one stop before it closes."
          );
        }
        await client.query(
          "update fulfillment_manifests set status = 'CLOSED', closed_at = $2, updated_at = $2 where id = $1",
          [manifest.id, now]
        );
        await appendOutbox(client, {
          businessId: actor.businessId,
          eventType: "manifest.closed",
          eventKey: `manifest.closed:${manifest.id}`,
          payload: { manifestId: manifest.id, totalWeightGrams: manifest.total_weight_grams },
          now
        });
        context.log("fulfillment.manifest_closed", {
          businessId: actor.businessId,
          manifestId: manifest.id,
          actorId: userId,
          totalWeightGrams: manifest.total_weight_grams
        });
        return manifestSummary(
          client,
          actor.businessId,
          await lockManifest(client, actor.businessId, manifest.id)
        );
      });
    },

    async departManifest(actor) {
      // Dispatchers depart any manifest; a driver only the trip assigned to them.
      const { userId } = context.authorize(actor, "delivery:record");
      const dispatcher = context.hasPermission(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      return context.transaction(async (client) => {
        const manifest = await lockManifest(client, actor.businessId, actor.manifestId);
        if (!dispatcher && manifest.driver_user_id !== userId) throw manifestNotFound();
        if (!canTransitionManifest(manifest.status, "DEPARTED")) {
          throw new Cp2Error(
            409,
            "manifest_transition_invalid",
            "Only a closed manifest can depart.",
            false,
            { status: manifest.status, requestedStatus: "DEPARTED" }
          );
        }
        await client.query(
          "select id from fulfillment_vehicles where business_id = $1 and id = $2 for update",
          [actor.businessId, manifest.vehicle_id]
        );
        const timeZone = context.businessTimezone(actor.businessId);
        if (timeZone === null) {
          throw new Cp2Error(
            422,
            "business_timezone_required",
            "Configure the business timezone before dispatching a vehicle."
          );
        }
        await reserveVehicle(client, {
          businessId: actor.businessId,
          vehicleId: manifest.vehicle_id,
          manifestId: manifest.id,
          serviceDate: formatLocalDate(manifest.planned_departure_at ?? now, timeZone),
          now
        });
        await client.query(
          "update fulfillment_manifests set status = 'DEPARTED', departed_at = $2, updated_at = $2 where id = $1",
          [manifest.id, now]
        );
        await appendOutbox(client, {
          businessId: actor.businessId,
          eventType: "manifest.departed",
          eventKey: `manifest.departed:${manifest.id}`,
          payload: { manifestId: manifest.id, vehicleId: manifest.vehicle_id },
          now
        });
        context.log("fulfillment.manifest_departed", {
          businessId: actor.businessId,
          manifestId: manifest.id,
          actorId: userId
        });
        return manifestSummary(
          client,
          actor.businessId,
          await lockManifest(client, actor.businessId, manifest.id)
        );
      });
    },

    async assignManifestDriver(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      const driverUserId = actor.driverUserId;
      return context.transaction((client) =>
        context.idempotent(
          client,
          actor,
          "fulfillment.assignManifestDriver",
          { manifestId: actor.manifestId, driverUserId },
          now,
          async () => {
            const manifest = await lockManifest(client, actor.businessId, actor.manifestId);
            // Checked inside the idempotency record (a keyed retry replays its first result even if
            // the driver has since left) and after the manifest lock, so it serializes with
            // releaseDriverAssignments, which locks the same rows.
            if (driverUserId !== null) {
              const member = context
                .businessMembers(actor.businessId)
                .find((entry) => entry.userId === driverUserId);
              if (member === undefined || !roleCan(member.role, "delivery:record")) {
                throw new Cp2Error(
                  409,
                  "driver_not_eligible",
                  "Choose someone in this business who can record deliveries.",
                  false,
                  { driverUserId }
                );
              }
            }
            if (manifest.status === "COMPLETED" || manifest.status === "CANCELLED") {
              throw new Cp2Error(
                409,
                "manifest_transition_invalid",
                `A ${manifest.status} manifest cannot be reassigned.`,
                false,
                { status: manifest.status }
              );
            }
            if (manifest.driver_user_id !== driverUserId) {
              await client.query(
                "update fulfillment_manifests set driver_user_id = $2, updated_at = $3 where id = $1",
                [manifest.id, driverUserId, now]
              );
              await appendOutbox(client, {
                businessId: actor.businessId,
                eventType: "manifest.driver_assigned",
                eventKey: `manifest.driver_assigned:${manifest.id}:${randomUUID()}`,
                payload: {
                  manifestId: manifest.id,
                  driverUserId,
                  previousDriverUserId: manifest.driver_user_id
                },
                now
              });
              context.log("fulfillment.manifest_driver_assigned", {
                businessId: actor.businessId,
                manifestId: manifest.id,
                driverUserId,
                actorId: userId
              });
            }
            return manifestSummary(
              client,
              actor.businessId,
              await lockManifest(client, actor.businessId, manifest.id)
            );
          }
        )
      );
    },

    async listMyManifests(actor) {
      const { userId } = context.authorize(actor, "delivery:record");
      const result = await pool.query<ManifestRow>(
        `
          select * from fulfillment_manifests
          where business_id = $1 and driver_user_id = $2 and status in ('OPEN', 'CLOSED', 'DEPARTED')
          order by planned_departure_at asc nulls last, created_at asc, id
          limit 50
        `,
        [actor.businessId, userId]
      );
      return Promise.all(result.rows.map((row) => manifestSummary(pool, actor.businessId, row)));
    },

    async listAssignableDrivers(actor) {
      context.authorize(actor, "fulfillment:dispatch");
      return context
        .businessMembers(actor.businessId)
        .filter((member) => roleCan(member.role, "delivery:record"))
        .map((member) => ({
          userId: member.userId,
          displayName: member.displayName,
          role: member.role
        }))
        .sort((left, right) => left.displayName.localeCompare(right.displayName));
    },

    async releaseDriverAssignments(input) {
      const now = input.now ?? new Date();
      if (input.joined !== true) {
        // A role that could never be assigned trips (a cashier removed, say) has nothing to
        // release: skip the locks entirely.
        if (
          input.previousRole !== undefined &&
          input.previousRole !== null &&
          !roleCan(input.previousRole, "delivery:record")
        ) {
          return 0;
        }
        const stillEligible = context
          .businessMembers(input.businessId)
          .some(
            (member) => member.userId === input.userId && roleCan(member.role, "delivery:record")
          );
        if (stillEligible) return 0;
      }
      return context.transaction(async (client) => {
        // Lock the business's unfinished manifests first: an assignment to this person that is in
        // flight commits before we look, so it is released too instead of slipping past us.
        await client.query(
          `
            select id from fulfillment_manifests
            where business_id = $1 and status not in ('COMPLETED', 'CANCELLED')
            order by id
            for no key update
          `,
          [input.businessId]
        );
        const released = await client.query<{ id: string }>(
          `
            update fulfillment_manifests
            set driver_user_id = null, updated_at = $3
            where business_id = $1 and driver_user_id = $2
              and status not in ('COMPLETED', 'CANCELLED')
              and ($4::timestamptz is null or updated_at < $4::timestamptz)
            returning id
          `,
          [
            input.businessId,
            input.userId,
            now,
            input.joined === true ? (input.at ?? now.toISOString()) : null
          ]
        );
        for (const row of released.rows) {
          await appendOutbox(client, {
            businessId: input.businessId,
            eventType: "manifest.driver_assigned",
            eventKey: `manifest.driver_assigned:${row.id}:${randomUUID()}`,
            payload: {
              manifestId: row.id,
              driverUserId: null,
              previousDriverUserId: input.userId,
              reason: input.joined === true ? "stale_on_rejoin" : "driver_left"
            },
            now
          });
        }
        if (released.rows.length > 0) {
          context.log("fulfillment.driver_assignments_released", {
            businessId: input.businessId,
            driverUserId: input.userId,
            manifests: released.rows.length
          });
        }
        return released.rows.length;
      });
    },

    async cancelManifest(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const reason = actor.reason.trim();
      if (reason === "" || reason.length > 240) {
        throw new Cp2Error(
          400,
          "manifest_cancellation_reason_invalid",
          "Give a reason of 1 to 240 characters."
        );
      }
      const now = actor.now ?? new Date();
      const cancelled = await context.transaction(async (client) => {
        const manifest = await lockManifest(client, actor.businessId, actor.manifestId);
        if (!canTransitionManifest(manifest.status, "CANCELLED")) {
          throw new Cp2Error(
            409,
            "manifest_transition_invalid",
            `A ${manifest.status} manifest cannot be cancelled.`
          );
        }
        await client.query(
          `update fulfillment_orders
              set state = 'POOLED', updated_at = $3
            where business_id = $1 and state = 'ALLOCATED'
              and id in (
                select fulfillment_order_id from fulfillment_manifest_stops
                 where business_id = $1 and manifest_id = $2 and allocation_active
              )`,
          [actor.businessId, manifest.id, now]
        );
        const released = await client.query<{ invoice_id: string }>(
          `update fulfillment_manifest_stops
             set allocation_active = false, released_at = $3,
                 release_reason = 'REMOVED_BY_DISPATCHER', updated_at = $3
           where business_id = $1 and manifest_id = $2 and allocation_active
           returning invoice_id`,
          [actor.businessId, manifest.id, now]
        );
        await client.query(
          `update fulfillment_vehicle_reservations
             set active = false, released_at = $3, release_reason = $4, updated_at = $3
           where business_id = $1 and manifest_id = $2 and active`,
          [actor.businessId, manifest.id, now, reason]
        );
        const updated = (
          await client.query<ManifestRow>(
            `update fulfillment_manifests
                set status = 'CANCELLED', updated_at = $3
              where business_id = $1 and id = $2
              returning *`,
            [actor.businessId, manifest.id, now]
          )
        ).rows[0] as ManifestRow;
        await appendOutbox(client, {
          businessId: actor.businessId,
          eventType: "manifest.cancelled",
          eventKey: `manifest.cancelled:${manifest.id}`,
          payload: {
            manifestId: manifest.id,
            reason,
            releasedInvoiceIds: released.rows.map((row) => row.invoice_id)
          },
          now
        });
        return {
          summary: await manifestSummary(client, actor.businessId, updated),
          invoiceIds: released.rows.map((row) => row.invoice_id)
        };
      });
      for (const invoiceId of cancelled.invoiceIds) {
        context.applyLogisticsStatus({
          businessId: actor.businessId,
          invoiceId,
          status: "ready",
          actorId: userId
        });
      }
      return cancelled.summary;
    },

    async evaluateDispatch(actor) {
      const userId = actor[scheduledEvaluation]
        ? "system:fulfillment-cutoff"
        : context.authorize(actor, "fulfillment:dispatch").userId;
      const now = actor.now ?? new Date();
      const timeZone = context.businessTimezone(actor.businessId);
      if (timeZone === null) {
        throw new Cp2Error(
          422,
          "business_timezone_required",
          "Configure the business timezone before evaluating dispatch."
        );
      }
      return context.transaction(async (client) => {
        const corridor = await lockCorridor(client, actor.businessId, actor.corridorId);
        const policy = await effectivePolicy(client, actor.businessId, corridor.policy_override_id);
        if (policy === null) {
          throw new Cp2Error(422, "no_dispatch_policy", "This corridor has no dispatch policy.");
        }
        const rows = await pooledRows(client, actor.businessId, { corridorId: corridor.id });
        let allocatable = 0n;
        let oldest: Date | null = null;
        for (const row of rows) {
          if (
            row.weight_status !== "RESOLVED" ||
            row.total_weight_grams === null ||
            staleReasons(row).length > 0
          )
            continue;
          allocatable += parseGrams(row.total_weight_grams, "totalWeightGrams");
          if (oldest === null || row.confirmed_at < oldest) oldest = row.confirmed_at;
        }
        const vehicles = await client.query<{
          id: string;
          capacity_grams: string;
          active: boolean;
        }>(
          "select id, capacity_grams, active from fulfillment_vehicles where business_id = $1 order by id",
          [actor.businessId]
        );
        const evaluation = evaluateDispatchPolicy({
          allocatableGrams: allocatable,
          targetLoadGrams: parseGrams(policy.target_load_grams, "targetLoadGrams"),
          minimumDispatchLoadGrams:
            policy.minimum_dispatch_load_grams === null
              ? null
              : parseGrams(policy.minimum_dispatch_load_grams, "minimumDispatchLoadGrams"),
          oldestWaitingAgeHours:
            oldest === null ? null : Math.max(0, (now.getTime() - oldest.getTime()) / 3_600_000),
          maxWaitHours: policy.max_wait_hours,
          fallbackActions: policy.under_threshold_fallback,
          vehicles: vehicles.rows.map((vehicle) => ({
            id: vehicle.id,
            capacityGrams: parseGrams(vehicle.capacity_grams, "capacityGrams"),
            active: vehicle.active
          })),
          compatibleCorridors: []
        });
        const businessDate = formatLocalDate(now, timeZone);
        const recommendation =
          evaluation.recommendation === null
            ? null
            : evaluation.recommendation.action === "TRY_SMALLER_VEHICLE"
              ? {
                  ...evaluation.recommendation,
                  capacityGrams: formatGrams(evaluation.recommendation.capacityGrams)
                }
              : evaluation.recommendation;
        const evaluationId = randomUUID();
        const previousOutcome = (
          await client.query<{ outcome: EvaluationRow["outcome"] }>(
            "select outcome from fulfillment_dispatch_evaluations where business_id = $1 and corridor_id = $2 order by business_date desc, evaluated_at desc limit 1",
            [actor.businessId, corridor.id]
          )
        ).rows[0]?.outcome;
        const inserted = await client.query<EvaluationRow>(
          `
            insert into fulfillment_dispatch_evaluations
              (id, business_id, corridor_id, policy_version_id, business_date, outcome, readiness,
               max_wait_reached, recommendation, reason, evaluated_by, evaluated_at)
            values ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb, $10, $11, $12)
            on conflict (business_id, corridor_id, business_date) do nothing
            returning *
          `,
          [
            evaluationId,
            actor.businessId,
            corridor.id,
            policy.id,
            businessDate,
            evaluation.outcome,
            evaluation.readiness,
            evaluation.maxWaitReached,
            recommendation === null ? null : JSON.stringify(recommendation),
            evaluation.reason,
            userId,
            now
          ]
        );
        const persisted =
          inserted.rows[0] ??
          (
            await client.query<EvaluationRow>(
              "select * from fulfillment_dispatch_evaluations where business_id = $1 and corridor_id = $2 and business_date = $3::date",
              [actor.businessId, corridor.id, businessDate]
            )
          ).rows[0];
        if (persisted === undefined) throw new Error("Dispatch evaluation disappeared.");
        if (persisted.outcome === "APPROVAL_REQUIRED") {
          await client.query(
            `
              insert into fulfillment_dispatch_approvals
                (id, business_id, corridor_id, evaluation_id, policy_version_id, status,
                 created_at, updated_at)
              values ($1, $2, $3, $4, $5, 'OPEN', $6, $6)
              on conflict do nothing
            `,
            [
              randomUUID(),
              actor.businessId,
              corridor.id,
              persisted.id,
              persisted.policy_version_id,
              now
            ]
          );
          await appendOutbox(client, {
            businessId: actor.businessId,
            eventType: "dispatch.approval_required",
            eventKey: `dispatch.approval_required:${persisted.id}`,
            payload: { corridorId: corridor.id, evaluationId: persisted.id },
            now
          });
        }
        if (
          inserted.rows[0] !== undefined &&
          persisted.outcome === "READY" &&
          previousOutcome !== "READY"
        ) {
          await appendOutbox(client, {
            businessId: actor.businessId,
            eventType: "corridor.threshold_reached",
            eventKey: `corridor.threshold_reached:${persisted.id}`,
            payload: { corridorId: corridor.id, evaluationId: persisted.id },
            now
          });
        }
        return {
          outcome: persisted.outcome,
          readiness: persisted.readiness,
          maxWaitReached: persisted.max_wait_reached,
          recommendation: persisted.recommendation,
          reason: persisted.reason
        } as DispatchEvaluationSummary;
      });
    },

    async evaluateDueDispatches(input = {}) {
      const now = input.now ?? new Date();
      const corridors = await pool.query<{
        business_id: string;
        id: string;
        policy_override_id: string | null;
      }>(
        "select business_id, id, policy_override_id from fulfillment_corridors where active order by business_id, id"
      );
      let evaluated = 0;
      let skipped = 0;
      let failed = 0;
      for (const corridor of corridors.rows) {
        const timeZone = context.businessTimezone(corridor.business_id);
        if (timeZone === null) {
          skipped += 1;
          continue;
        }
        const policy = await effectivePolicy(
          pool,
          corridor.business_id,
          corridor.policy_override_id
        );
        if (policy === null || !isAtOrAfterLocalCutoff(now, timeZone, policy.cutoff_local_time)) {
          skipped += 1;
          continue;
        }
        try {
          await this.evaluateDispatch({
            sessionId: null,
            businessId: corridor.business_id,
            corridorId: corridor.id,
            now,
            [scheduledEvaluation]: true
          });
          evaluated += 1;
        } catch (error) {
          failed += 1;
          context.log("fulfillment.scheduled_evaluation_failed", {
            businessId: corridor.business_id,
            corridorId: corridor.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      return { evaluated, skipped, failed };
    },

    async listDispatchApprovals(actor) {
      context.authorize(actor, "fulfillment:dispatch");
      const result = await pool.query<ApprovalRow>(
        "select * from fulfillment_dispatch_approvals where business_id = $1 and ($2::text is null or status = $2) order by created_at desc, id",
        [actor.businessId, actor.status ?? null]
      );
      return result.rows.map(approvalSummary);
    },

    async decideDispatchApproval(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const reason = actor.reason.trim();
      if (reason === "" || reason.length > 240) {
        throw new Cp2Error(400, "approval_reason_invalid", "Give a reason of 1 to 240 characters.");
      }
      if (!isUuid(actor.approvalId)) {
        throw new Cp2Error(404, "dispatch_approval_not_found", "Approval was not found.");
      }
      const now = actor.now ?? new Date();
      return context.transaction(async (client) => {
        const existing = (
          await client.query<ApprovalRow>(
            "select * from fulfillment_dispatch_approvals where business_id = $1 and id = $2 for update",
            [actor.businessId, actor.approvalId]
          )
        ).rows[0];
        if (existing === undefined) {
          throw new Cp2Error(404, "dispatch_approval_not_found", "Approval was not found.");
        }
        if (existing.status !== "OPEN") {
          throw new Cp2Error(409, "dispatch_approval_decided", "Approval was already decided.");
        }
        const status =
          actor.decision === "APPROVE"
            ? "APPROVED"
            : actor.decision === "DEFER"
              ? "DEFERRED"
              : "REJECTED";
        const updated = (
          await client.query<ApprovalRow>(
            "update fulfillment_dispatch_approvals set status = $3, reason = $4, decided_by = $5, decided_at = $6, updated_at = $6 where business_id = $1 and id = $2 returning *",
            [actor.businessId, existing.id, status, reason, userId, now]
          )
        ).rows[0] as ApprovalRow;
        return approvalSummary(updated);
      });
    },

    async recordDelivery(actor) {
      const { userId } = context.authorize(actor, "delivery:record");
      // Dispatchers record on any manifest; a driver only on the trip assigned to them.
      const dispatcher = context.hasPermission(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      const note = actor.note?.trim() || null;
      if ((actor.outcome === "FAILED" || actor.outcome === "SKIPPED") && note === null) {
        throw new Cp2Error(
          400,
          "delivery_reason_required",
          "Say why the delivery failed or was skipped."
        );
      }
      if (note !== null && note.length > 240) {
        throw new Cp2Error(
          400,
          "delivery_note_too_long",
          "The note must be 240 characters or fewer."
        );
      }
      if (!isUuid(actor.stopId)) throw new Cp2Error(404, "stop_not_found", "Stop was not found.");
      const outcome = await context.transaction(async (client) => {
        const manifest = await lockManifest(client, actor.businessId, actor.manifestId);
        if (!dispatcher && manifest.driver_user_id !== userId) throw manifestNotFound();
        if (manifest.status !== "CLOSED" && manifest.status !== "DEPARTED") {
          throw new Cp2Error(
            409,
            "manifest_not_dispatched",
            "Deliveries are recorded once the manifest is closed.",
            false,
            { status: manifest.status }
          );
        }
        const stopPre = (
          await client.query<StopRow>(
            "select * from fulfillment_manifest_stops where business_id = $1 and manifest_id = $2 and id = $3",
            [actor.businessId, manifest.id, actor.stopId]
          )
        ).rows[0];
        if (stopPre === undefined) throw new Cp2Error(404, "stop_not_found", "Stop was not found.");
        await client.query("select id from fulfillment_orders where id = $1 for update", [
          stopPre.fulfillment_order_id
        ]);
        const stop = (
          await client.query<StopRow>(
            "select * from fulfillment_manifest_stops where id = $1 for update",
            [stopPre.id]
          )
        ).rows[0] as StopRow;
        const terminal = stop.delivery_status !== "PENDING" && stop.delivery_status !== "ARRIVED";
        if (
          !stop.allocation_active ||
          terminal ||
          (stop.delivery_status === "ARRIVED" && actor.outcome === "ARRIVED")
        ) {
          throw new Cp2Error(
            409,
            "stop_already_recorded",
            "This stop's delivery was already recorded.",
            false,
            {
              deliveryStatus: stop.delivery_status
            }
          );
        }
        const releaseReason: ManifestStopReleaseReason | null =
          actor.outcome === "FAILED"
            ? "DELIVERY_FAILED"
            : actor.outcome === "SKIPPED"
              ? "DELIVERY_SKIPPED"
              : null;
        await client.query(
          `
            update fulfillment_manifest_stops
            set delivery_status = $2, delivery_note = coalesce($3, delivery_note),
                delivery_recorded_by = $4, delivery_recorded_at = $5, updated_at = $5,
                allocation_active = $6, released_at = $7, release_reason = $8
            where id = $1
          `,
          [
            stop.id,
            actor.outcome,
            note,
            userId,
            now,
            releaseReason === null,
            releaseReason === null ? null : now,
            releaseReason
          ]
        );
        if (actor.outcome === "DELIVERED") {
          await client.query(
            "update fulfillment_orders set state = 'DELIVERED', delivered_at = $2, updated_at = $2 where id = $1",
            [stop.fulfillment_order_id, now]
          );
        } else if (releaseReason !== null) {
          // Failed or skipped: back to the pool with its original confirmation age (A21).
          await client.query(
            "update fulfillment_orders set state = 'POOLED', updated_at = $2 where id = $1",
            [stop.fulfillment_order_id, now]
          );
        }
        const open = await client.query(
          "select 1 from fulfillment_manifest_stops where manifest_id = $1 and allocation_active and delivery_status in ('PENDING', 'ARRIVED') limit 1",
          [manifest.id]
        );
        if (open.rows.length === 0) {
          await client.query(
            "update fulfillment_manifests set status = 'COMPLETED', completed_at = $2, updated_at = $2 where id = $1",
            [manifest.id, now]
          );
          await appendOutbox(client, {
            businessId: actor.businessId,
            eventType: "delivery.completed",
            eventKey: `manifest.completed:${manifest.id}`,
            payload: { manifestId: manifest.id },
            now
          });
        }
        if (actor.outcome === "DELIVERED" || actor.outcome === "FAILED") {
          await appendOutbox(client, {
            businessId: actor.businessId,
            eventType: actor.outcome === "DELIVERED" ? "delivery.completed" : "delivery.failed",
            eventKey: `delivery.${actor.outcome.toLowerCase()}:${stop.id}`,
            payload: {
              manifestId: manifest.id,
              stopId: stop.id,
              invoiceId: stop.invoice_id,
              orderWeightGrams: stop.order_weight_grams
            },
            now
          });
        }
        context.log(
          actor.outcome === "DELIVERED"
            ? "fulfillment.delivery_recorded"
            : actor.outcome === "ARRIVED"
              ? "fulfillment.stop_arrived"
              : "fulfillment.delivery_not_completed",
          {
            businessId: actor.businessId,
            manifestId: manifest.id,
            stopId: stop.id,
            invoiceId: stop.invoice_id,
            outcome: actor.outcome,
            actorId: userId
          }
        );
        return {
          invoiceId: stop.invoice_id,
          summary: await manifestSummary(
            client,
            actor.businessId,
            await lockManifest(client, actor.businessId, manifest.id)
          )
        };
      });
      if (actor.outcome === "DELIVERED") {
        context.applyLogisticsStatus({
          businessId: actor.businessId,
          invoiceId: outcome.invoiceId,
          status: "completed",
          actorId: userId
        });
      }
      return outcome.summary;
    },

    async cancelOrderFulfillment(actor) {
      const { userId } = context.authorize(actor, "fulfillment:dispatch");
      const now = actor.now ?? new Date();
      const reason = actor.reason?.trim() || null;
      if (reason !== null && reason.length > 240) {
        throw new Cp2Error(
          400,
          "cancel_reason_too_long",
          "The reason must be 240 characters or fewer."
        );
      }
      context.requireConfirmedOrder(actor.businessId, actor.invoiceId);
      const released = await context.transaction((client) =>
        releasePooledOrder(
          client,
          actor.businessId,
          actor.invoiceId,
          { state: "CANCELLED", reason },
          now
        )
      );
      context.applyLogisticsStatus({
        businessId: actor.businessId,
        invoiceId: actor.invoiceId,
        status: "cancelled",
        actorId: userId
      });
      context.log("fulfillment.order_cancelled", {
        businessId: actor.businessId,
        invoiceId: actor.invoiceId,
        previousState: released.previousState,
        releasedManifestId: released.releasedManifestId,
        actorId: userId
      });
      return operations.getOrderFulfillment(actor);
    }
  };
  return operations;
}

// ---------------------------------------------------------------------------------------------

interface CorridorLockRow {
  id: string;
  name: string;
  active: boolean;
  geometry_version: number;
  policy_override_id: string | null;
}

type CorridorPoolCorridorRow = CorridorLockRow;

interface PolicyRow {
  id: string;
  policy_id: string;
  version: number;
  target_load_grams: string;
  minimum_dispatch_load_grams: string | null;
  cutoff_local_time: string;
  max_wait_hours: number;
  under_threshold_fallback: Array<
    "TRY_SMALLER_VEHICLE" | "TRY_COMPATIBLE_CORRIDOR" | "REQUIRE_DISPATCH_APPROVAL"
  >;
}

interface PoolRow {
  id: string;
  invoice_id: string;
  customer_id: string | null;
  confirmed_at: Date;
  weight_status: "RESOLVED" | "UNRESOLVED" | null;
  total_weight_grams: string | null;
  state: string;
  resolution_id: string | null;
  corridor_id: string | null;
  corridor_geometry_version: number | null;
  shop_location_id: string | null;
  distance_along_meters: string | null;
  diversion_meters: string | null;
  corridor_geometry_version_now: number | null;
  current_location_id: string | null;
  latitude: string | null;
  longitude: string | null;
}

interface ManifestRow {
  id: string;
  business_id: string;
  corridor_id: string;
  corridor_geometry_version: number;
  policy_version_id: string;
  policy_id: string;
  policy_version: number;
  vehicle_id: string;
  vehicle_capacity_grams: string;
  status: ManifestStatus;
  total_weight_grams: string;
  planned_departure_at: Date | null;
  closed_at: Date | null;
  departed_at: Date | null;
  completed_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  driver_user_id: string | null;
}

interface ApprovalRow {
  id: string;
  business_id: string;
  corridor_id: string;
  evaluation_id: string;
  policy_version_id: string;
  status: "OPEN" | "APPROVED" | "DEFERRED" | "REJECTED";
  reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface EvaluationRow {
  id: string;
  policy_version_id: string;
  outcome: "READY" | "WAIT" | "FALLBACK" | "APPROVAL_REQUIRED";
  readiness: "ACCUMULATING" | "DISPATCHABLE" | "DISPATCH_READY";
  max_wait_reached: boolean;
  recommendation: DispatchEvaluationSummary["recommendation"];
  reason: DispatchEvaluationSummary["reason"];
}

function approvalSummary(row: ApprovalRow): DispatchApprovalSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    corridorId: row.corridor_id,
    evaluationId: row.evaluation_id,
    policyVersionId: row.policy_version_id,
    status: row.status,
    reason: row.reason,
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function formatLocalDate(instant: Date, timeZone: string): string {
  const date = localDate(instant, timeZone);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function isAtOrAfterLocalCutoff(instant: Date, timeZone: string, cutoff: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("hour")}:${value("minute")}:${value("second")}` >= cutoff.slice(0, 8);
}

function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

interface StopRow {
  id: string;
  business_id: string;
  manifest_id: string;
  fulfillment_order_id: string;
  invoice_id: string;
  customer_id: string | null;
  sequence: number;
  distance_along_meters: string;
  diversion_meters: string;
  latitude: string;
  longitude: string;
  order_weight_grams: string;
  allocation_active: boolean;
  delivery_status: ManifestStopDeliveryStatus;
  delivery_note: string | null;
  release_reason: ManifestStopReleaseReason | null;
  delivery_recorded_at: Date | null;
}

/** A16 staleness, computed: resolution geometry version or shop location no longer current. */
function staleReasons(row: PoolRow): Array<"GEOMETRY_CHANGED" | "LOCATION_CHANGED"> {
  if (row.resolution_id === null) return [];
  const reasons: Array<"GEOMETRY_CHANGED" | "LOCATION_CHANGED"> = [];
  if (row.corridor_geometry_version !== row.corridor_geometry_version_now)
    reasons.push("GEOMETRY_CHANGED");
  if (row.shop_location_id !== row.current_location_id) reasons.push("LOCATION_CHANGED");
  return reasons;
}

function stopSummary(
  stop: StopRow,
  customerName: (businessId: string, customerId: string) => string | null,
  deliveryDetails: DispatchOperationsContext["deliveryDetails"]
): ManifestStopSummary {
  const details = deliveryDetails(stop.business_id, stop.invoice_id);
  return {
    id: stop.id,
    manifestId: stop.manifest_id,
    invoiceId: stop.invoice_id,
    fulfillmentOrderId: stop.fulfillment_order_id,
    customerId: stop.customer_id,
    customerName:
      stop.customer_id === null ? null : customerName(stop.business_id, stop.customer_id),
    sequence: stop.sequence,
    distanceAlongMeters: Number(stop.distance_along_meters),
    diversionMeters: Number(stop.diversion_meters),
    latitude: Number(stop.latitude),
    longitude: Number(stop.longitude),
    orderWeightGrams: stop.order_weight_grams,
    items: details.items,
    payOnDeliveryAmount: details.payOnDeliveryAmount,
    allocationActive: stop.allocation_active,
    deliveryStatus: stop.delivery_status,
    deliveryNote: stop.delivery_note,
    releaseReason: stop.release_reason,
    deliveryRecordedAt: iso(stop.delivery_recorded_at)
  };
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function manifestNotFound(): Cp2Error {
  return new Cp2Error(404, "manifest_not_found", "Manifest was not found.");
}
