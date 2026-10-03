/**
 * FulfillmentService - the Postgres-authoritative half of the corridor-fulfillment domain
 * (docs/architecture/corridor-fulfillment.md §5, Phase 0 decision D1 option A).
 *
 * Unlike the Cp2Store domains, this state is NOT held in memory and NOT written by the snapshot
 * writer: every read queries Postgres and every mutation commits inside its own request
 * transaction (`withFulfillmentTransaction`), so the A17 invariants are enforced by the database
 * before the caller gets a response. Pure rules (validation, weight) come from
 * @grogoni/business-core; authorization and shop existence come from the Cp2Store through the narrow
 * `FulfillmentServiceDeps` interface - this module never reaches into store internals.
 *
 * In `CP2_STORE=memory` mode there is no database, so `createUnavailableFulfillmentService`
 * rejects every call with 503 `fulfillment_requires_postgres` (decision D2) instead of shipping a
 * second, non-transactional implementation of the same rules.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  validateCoordinates,
  validateDispatchPolicyInput,
  validateVehicleInput,
  type BusinessPermission,
  type DispatchPolicyInput
} from "@grogoni/business-core";
import {
  formatGrams,
  formatNullableGrams,
  type ConfirmedOrderReference,
  type FulfillmentStatus,
  parseGrams,
  type DispatchFallbackAction,
  type DispatchOverflowStrategy,
  type DispatchPolicySummary,
  type ShopLocationStatusSummary,
  type ShopLocationSummary,
  type VehicleSummary,
  type BusinessRole
} from "@grogoni/shared-types";
import { Cp2Error, assertValid } from "../../cp2-error.js";
import {
  fulfillmentRequestHash,
  normalizeIdempotencyKey,
  runIdempotent,
  withFulfillmentTransaction,
  type FulfillmentTransactionOptions
} from "./transaction.js";
import { createCorridorOperations, type CorridorOperations } from "./corridors.js";
import {
  createDispatchOperations,
  type DispatchInternalOperations,
  type DispatchOperations
} from "./dispatch.js";
import type { Cp2Store } from "../../store.js";

export const fulfillmentFoundationMigration = "090_fulfillment_foundation.sql";

export interface FulfillmentServiceDeps {
  /** Throws Cp2Error (401/403/404/410) exactly as in-store mutations do. */
  authorize: (input: {
    sessionId: string | null;
    businessId: string;
    permission: BusinessPermission;
  }) => { userId: string };
  hasPermission: (input: {
    sessionId: string | null;
    businessId: string;
    permission: BusinessPermission;
  }) => boolean;
  /** Members of a business with role and name (driver assignment); caller already authorized. */
  businessMembers: (
    businessId: string
  ) => Array<{ userId: string; displayName: string; role: BusinessRole }>;
  /** Throws 404 unless `customerId` is a shop of `businessId`. */
  requireCustomer: (businessId: string, customerId: string) => { id: string };
  /** Throws 404 for an unknown order and 409 for a draft; returns the confirmed order's shop. */
  requireConfirmedOrder: (businessId: string, invoiceId: string) => ConfirmedOrderReference;
  /** Display name of a shop for manifests and pools; null if it no longer exists. */
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
  /** Projects fulfillment progress onto the canonical LogisticsSummary (never forced). */
  applyLogisticsStatus: (input: {
    businessId: string;
    invoiceId: string;
    status: FulfillmentStatus;
    actorId: string;
  }) => void;
}

/** The one mapping from the Cp2Store's public bridge to FulfillmentServiceDeps (index.ts, tests). */
export function fulfillmentDepsFromStore(store: Cp2Store): FulfillmentServiceDeps {
  return {
    authorize: (input) => store.authorizeBusinessPermission(input),
    hasPermission: (input) => store.hasBusinessPermission(input),
    businessMembers: (businessId) => store.listBusinessMembersForFulfillment(businessId),
    requireCustomer: (businessId, customerId) =>
      store.requireBusinessCustomer(businessId, customerId),
    requireConfirmedOrder: (businessId, invoiceId) =>
      store.requireConfirmedOrderReference(businessId, invoiceId),
    customerName: (businessId, customerId) => {
      try {
        return store.requireBusinessCustomer(businessId, customerId).name;
      } catch {
        return null;
      }
    },
    deliveryDetails: (businessId, invoiceId) =>
      store.fulfillmentDeliveryDetails(businessId, invoiceId),
    businessTimezone: (businessId) => store.businessTimezone(businessId),
    listIntakeCandidates: () => store.listFulfillmentIntakeCandidates(),
    existingInvoiceIds: (businessId, invoiceIds) =>
      store.existingInvoiceIds(businessId, invoiceIds),
    applyLogisticsStatus: (input) => {
      const result = store.applyFulfillmentLogisticsStatus(input);
      if (!result.applied && result.status !== null) {
        logFulfillmentEvent("fulfillment.logistics_projection_skipped", {
          businessId: input.businessId,
          invoiceId: input.invoiceId,
          requested: input.status,
          current: result.status
        });
      }
    }
  };
}

interface Actor {
  sessionId: string | null;
  businessId: string;
  idempotencyKey?: string | null;
  now?: Date;
}

export interface VehicleMutationInput {
  name: string;
  registration: string | null;
  capacityGrams: bigint;
  active: boolean;
}

export interface VehiclePatchInput {
  name?: string;
  registration?: string | null;
  capacityGrams?: bigint;
  active?: boolean;
}

export interface ShopLocationCaptureInput {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
}

export interface EffectiveDispatchPolicySummary {
  businessId: string;
  defaultPolicyId: string | null;
  policy: DispatchPolicySummary | null;
}

export interface FulfillmentService
  extends CorridorOperations, DispatchOperations, DispatchInternalOperations {
  readonly available: boolean;
  listVehicles(input: Actor & { includeInactive?: boolean }): Promise<VehicleSummary[]>;
  createVehicle(input: Actor & { vehicle: VehicleMutationInput }): Promise<VehicleSummary>;
  updateVehicle(
    input: Actor & { vehicleId: string; patch: VehiclePatchInput }
  ): Promise<VehicleSummary>;
  listDispatchPolicies(
    input: Actor & { includeHistory?: boolean }
  ): Promise<DispatchPolicySummary[]>;
  createDispatchPolicy(
    input: Actor & {
      policy: DispatchPolicyInput;
      makeBusinessDefault: boolean;
      /**
       * Optimistic concurrency on the business default: the default policy lineage the caller saw
       * (null = none yet). When given and the default has changed, refused with 409
       * `default_policy_changed` instead of replacing someone else's default.
       */
      expectedDefaultPolicyId?: string | null;
    }
  ): Promise<DispatchPolicySummary>;
  reviseDispatchPolicy(
    input: Actor & {
      policyId: string;
      policy: DispatchPolicyInput;
      /**
       * Optimistic concurrency: the version the caller edited. When given and the active version
       * has moved on (someone else revised it), the revision is refused with 409
       * `dispatch_policy_version_conflict` instead of silently replacing the newer rules.
       */
      expectedVersion?: number | null;
      /** As on create: the caller edits this lineage believing it is the business default. */
      expectedDefaultPolicyId?: string | null;
    }
  ): Promise<DispatchPolicySummary>;
  setDefaultDispatchPolicy(
    input: Actor & { policyId: string }
  ): Promise<EffectiveDispatchPolicySummary>;
  getEffectiveDefaultPolicy(input: Actor): Promise<EffectiveDispatchPolicySummary>;
  captureShopLocation(
    input: Actor & { customerId: string; location: ShopLocationCaptureInput }
  ): Promise<ShopLocationStatusSummary>;
  getShopLocation(input: Actor & { customerId: string }): Promise<ShopLocationStatusSummary>;
  listShopLocationHistory(input: Actor & { customerId: string }): Promise<ShopLocationSummary[]>;
  /** A23 retention; returns the number of records removed. */
  purgeExpiredIdempotencyRecords(input: { now?: Date; retentionHours?: number }): Promise<number>;
  deliverPendingOutboxEvents(input?: { now?: Date; batchSize?: number }): Promise<{
    delivered: number;
    failed: number;
  }>;
}

export function createUnavailableFulfillmentService(): FulfillmentService {
  const unavailable = async (): Promise<never> => {
    throw new Cp2Error(
      503,
      "fulfillment_requires_postgres",
      "Delivery planning needs the database-backed store. It is not available in memory mode."
    );
  };
  return {
    available: false,
    listVehicles: unavailable,
    createVehicle: unavailable,
    updateVehicle: unavailable,
    listDispatchPolicies: unavailable,
    createDispatchPolicy: unavailable,
    reviseDispatchPolicy: unavailable,
    setDefaultDispatchPolicy: unavailable,
    getEffectiveDefaultPolicy: unavailable,
    captureShopLocation: unavailable,
    getShopLocation: unavailable,
    listShopLocationHistory: unavailable,
    listCorridors: unavailable,
    getCorridor: unavailable,
    createCorridor: unavailable,
    updateCorridor: unavailable,
    updateCorridorGeometry: unavailable,
    listCorridorGeometryVersions: unavailable,
    resolveCorridorForShop: unavailable,
    resolveCorridorForOrder: unavailable,
    assignCorridorManually: unavailable,
    getResolutionStatus: unavailable,
    getActivePools: unavailable,
    getCorridorPool: unavailable,
    getOrderFulfillment: unavailable,
    intakeOrderForDispatcher: unavailable,
    createManifest: unavailable,
    listManifests: unavailable,
    getManifest: unavailable,
    removeOrderFromManifest: unavailable,
    closeManifest: unavailable,
    departManifest: unavailable,
    assignManifestDriver: unavailable,
    listMyManifests: unavailable,
    listAssignableDrivers: unavailable,
    releaseDriverAssignments: async () => 0,
    cancelManifest: unavailable,
    evaluateDispatch: unavailable,
    listDispatchApprovals: unavailable,
    decideDispatchApproval: unavailable,
    recordDelivery: unavailable,
    cancelOrderFulfillment: unavailable,
    intakeOrder: unavailable,
    reconcileIntake: async () => ({ takenIn: 0, orphaned: 0, failed: 0 }),
    evaluateDueDispatches: async () => ({ evaluated: 0, skipped: 0, failed: 0 }),
    purgeExpiredIdempotencyRecords: async () => 0,
    deliverPendingOutboxEvents: async () => ({ delivered: 0, failed: 0 })
  };
}

/** Fails fast at boot, like `assertDatabaseMigrated`, if migration 090 has not been applied. */
export async function assertFulfillmentSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{ applied: boolean }>(
    "select exists (select 1 from grogoni_schema_migrations where filename = $1) as applied",
    [fulfillmentFoundationMigration]
  );
  if (result.rows[0]?.applied !== true) {
    throw new Error(
      `Database migrations are not up to date. Run "pnpm db:migrate" before starting the API. Missing ${fulfillmentFoundationMigration}.`
    );
  }
}

export function createPostgresFulfillmentService(input: {
  pool: Pool;
  deps: FulfillmentServiceDeps;
  transactionOptions?: FulfillmentTransactionOptions;
  idempotencyRetentionHours?: number;
  deliverOutboxEvent?: (event: {
    id: string;
    businessId: string;
    eventType: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  }) => Promise<void>;
}): FulfillmentService {
  const { pool, deps } = input;
  const transaction = <T>(run: (client: PoolClient) => Promise<T>) =>
    withFulfillmentTransaction(pool, run, input.transactionOptions);

  const authorize = (actor: Actor, permission: BusinessPermission) =>
    deps.authorize({ sessionId: actor.sessionId, businessId: actor.businessId, permission });

  const idempotent = <T>(
    client: PoolClient,
    actor: Actor,
    operation: string,
    request: unknown,
    now: Date,
    mutate: () => Promise<T>
  ) =>
    runIdempotent(
      client,
      {
        businessId: actor.businessId,
        operation,
        key: normalizeIdempotencyKey(actor.idempotencyKey),
        requestHash: fulfillmentRequestHash(request),
        now
      },
      mutate
    );

  async function requireVehicle(
    client: PoolClient,
    businessId: string,
    vehicleId: string,
    lock: boolean
  ): Promise<VehicleRow> {
    requireUuid(vehicleId, "vehicle_not_found", "Vehicle was not found.");
    const result = await client.query<VehicleRow>(
      `select * from fulfillment_vehicles where business_id = $1 and id = $2${lock ? " for update" : ""}`,
      [businessId, vehicleId]
    );
    const row = result.rows[0];
    if (row === undefined) throw new Cp2Error(404, "vehicle_not_found", "Vehicle was not found.");
    return row;
  }

  async function activePolicyVersion(
    client: PoolClient | Pool,
    businessId: string,
    policyId: string
  ): Promise<PolicyRow | null> {
    if (!isUuid(policyId)) return null;
    const result = await client.query<PolicyRow>(
      `
        select * from fulfillment_dispatch_policies
        where business_id = $1 and policy_id = $2 and active
      `,
      [businessId, policyId]
    );
    return result.rows[0] ?? null;
  }

  async function effectiveDefault(
    client: PoolClient | Pool,
    businessId: string
  ): Promise<EffectiveDispatchPolicySummary> {
    const settings = await client.query<{ default_policy_id: string | null }>(
      "select default_policy_id from fulfillment_business_settings where business_id = $1",
      [businessId]
    );
    const defaultPolicyId = settings.rows[0]?.default_policy_id ?? null;
    const policy =
      defaultPolicyId === null
        ? null
        : await activePolicyVersion(client, businessId, defaultPolicyId);
    return {
      businessId,
      defaultPolicyId,
      policy: policy === null ? null : policySummary(policy, defaultPolicyId)
    };
  }

  async function setDefaultPointer(
    client: PoolClient,
    businessId: string,
    policyId: string,
    actorId: string,
    now: Date
  ): Promise<void> {
    await client.query(
      `
        insert into fulfillment_business_settings (business_id, default_policy_id, updated_by, updated_at)
        values ($1, $2, $3, $4)
        on conflict (business_id) do update set
          default_policy_id = excluded.default_policy_id,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `,
      [businessId, policyId, actorId, now]
    );
  }

  /**
   * Locks the business's default-policy pointer row (creating an empty one if none exists, so two
   * first-ever creates serialize too) and refuses when it no longer points where the caller
   * expected. `expected === undefined` means the caller asked for no check. Lock order: a policy
   * lineage (if any) is locked before this row, as setDefaultDispatchPolicy does.
   */
  async function assertDefaultPointer(
    client: PoolClient,
    businessId: string,
    expected: string | null | undefined,
    actorId: string,
    now: Date
  ): Promise<void> {
    if (expected === undefined) return;
    await client.query(
      `
        insert into fulfillment_business_settings (business_id, default_policy_id, updated_by, updated_at)
        values ($1, null, $2, $3)
        on conflict (business_id) do nothing
      `,
      [businessId, actorId, now]
    );
    const current =
      (
        await client.query<{ default_policy_id: string | null }>(
          "select default_policy_id from fulfillment_business_settings where business_id = $1 for update",
          [businessId]
        )
      ).rows[0]?.default_policy_id ?? null;
    if (current !== expected) {
      throw new Cp2Error(
        409,
        "default_policy_changed",
        "The business's default dispatch rules were changed since you opened them. Review the latest and save again.",
        false,
        { expectedDefaultPolicyId: expected, defaultPolicyId: current }
      );
    }
  }

  async function defaultPolicyId(client: PoolClient | Pool, businessId: string) {
    const result = await client.query<{ default_policy_id: string | null }>(
      "select default_policy_id from fulfillment_business_settings where business_id = $1",
      [businessId]
    );
    return result.rows[0]?.default_policy_id ?? null;
  }

  async function locationStatus(
    client: PoolClient | Pool,
    actor: Actor,
    customerId: string
  ): Promise<ShopLocationStatusSummary> {
    const precise = deps.hasPermission({
      sessionId: actor.sessionId,
      businessId: actor.businessId,
      permission: "shop_location:read_precise"
    });
    const result = await client.query<LocationRow>(
      `
        select * from fulfillment_shop_locations
        where business_id = $1 and customer_id = $2 and superseded_at is null
      `,
      [actor.businessId, customerId]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return {
        businessId: actor.businessId,
        customerId,
        locationStatus: "UNRESOLVED",
        coordinatesRedacted: !precise,
        current: null
      };
    }
    const location = locationSummary(row);
    return {
      businessId: actor.businessId,
      customerId,
      locationStatus: "RESOLVED",
      coordinatesRedacted: !precise,
      current: precise
        ? location
        : { ...location, latitude: null, longitude: null, accuracyMeters: null }
    };
  }

  const corridors = createCorridorOperations({
    pool,
    authorize,
    requireCustomer: deps.requireCustomer,
    requireConfirmedOrder: deps.requireConfirmedOrder,
    transaction,
    idempotent,
    requireActivePolicyLineage: async (client, businessId, policyId) => {
      if ((await activePolicyVersion(client, businessId, policyId)) === null) {
        throw new Cp2Error(404, "dispatch_policy_not_found", "Dispatch policy was not found.");
      }
    },
    log: logFulfillmentEvent
  });
  const dispatch = createDispatchOperations({
    pool,
    authorize,
    hasPermission: (actor, permission) =>
      deps.hasPermission({ sessionId: actor.sessionId, businessId: actor.businessId, permission }),
    requireConfirmedOrder: deps.requireConfirmedOrder,
    businessMembers: deps.businessMembers,
    customerName: deps.customerName,
    deliveryDetails: deps.deliveryDetails,
    businessTimezone: deps.businessTimezone,
    listIntakeCandidates: deps.listIntakeCandidates,
    existingInvoiceIds: deps.existingInvoiceIds,
    applyLogisticsStatus: deps.applyLogisticsStatus,
    getResolutionStatus: (actor) => corridors.getResolutionStatus(actor),
    resolveCorridorAsSystem: (input) => corridors.resolveCorridorAsSystem(input),
    transaction,
    idempotent,
    log: logFulfillmentEvent
  });

  return {
    available: true,
    ...dispatch,

    ...corridors,

    async listVehicles(actor) {
      authorize(actor, "fulfillment:read");
      const result = await pool.query<VehicleRow>(
        `
          select * from fulfillment_vehicles
          where business_id = $1 ${actor.includeInactive === true ? "" : "and active"}
          order by name, id
        `,
        [actor.businessId]
      );
      return result.rows.map(vehicleSummary);
    },

    async createVehicle(actor) {
      const { userId } = authorize(actor, "fulfillment:manage");
      const vehicle = normalizeVehicle(actor.vehicle);
      assertValid(validateVehicleInput(vehicle));
      const now = actor.now ?? new Date();
      return transaction((client) =>
        idempotent(
          client,
          actor,
          "fulfillment.createVehicle",
          { ...vehicle, capacityGrams: formatGrams(vehicle.capacityGrams) },
          now,
          async () => {
            const result = await client
              .query<VehicleRow>(
                `
                  insert into fulfillment_vehicles
                    (id, business_id, name, registration, capacity_grams, active, created_by, created_at, updated_at)
                  values ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $8)
                  returning *
                `,
                [
                  randomUUID(),
                  actor.businessId,
                  vehicle.name,
                  vehicle.registration,
                  formatGrams(vehicle.capacityGrams),
                  vehicle.active,
                  userId,
                  now
                ]
              )
              .catch(rethrowRegistrationConflict);
            const created = vehicleSummary(result.rows[0] as VehicleRow);
            logFulfillmentEvent("fulfillment.vehicle_created", {
              businessId: actor.businessId,
              vehicleId: created.id,
              capacityGrams: created.capacityGrams
            });
            return created;
          }
        )
      );
    },

    async updateVehicle(actor) {
      const { userId } = authorize(actor, "fulfillment:manage");
      const now = actor.now ?? new Date();
      const request = {
        vehicleId: actor.vehicleId,
        ...actor.patch,
        capacityGrams:
          actor.patch.capacityGrams === undefined
            ? undefined
            : formatGrams(actor.patch.capacityGrams)
      };
      // A23: a retried update replays its first result instead of re-applying the patch over a
      // change someone made in between.
      return transaction((client) =>
        idempotent(client, actor, "fulfillment.updateVehicle", request, now, async () => {
          const existing = await requireVehicle(client, actor.businessId, actor.vehicleId, true);
          const next = normalizeVehicle({
            name: actor.patch.name ?? existing.name,
            registration:
              actor.patch.registration === undefined
                ? existing.registration
                : actor.patch.registration,
            capacityGrams:
              actor.patch.capacityGrams ?? parseGrams(existing.capacity_grams, "capacityGrams"),
            active: actor.patch.active ?? existing.active
          });
          assertValid(validateVehicleInput(next));
          const result = await client
            .query<VehicleRow>(
              `
              update fulfillment_vehicles
              set name = $3, registration = $4, capacity_grams = $5::bigint, active = $6, updated_at = $7
              where business_id = $1 and id = $2
              returning *
            `,
              [
                actor.businessId,
                existing.id,
                next.name,
                next.registration,
                formatGrams(next.capacityGrams),
                next.active,
                now
              ]
            )
            .catch(rethrowRegistrationConflict);
          const updated = vehicleSummary(result.rows[0] as VehicleRow);
          logFulfillmentEvent("fulfillment.vehicle_updated", {
            businessId: actor.businessId,
            vehicleId: updated.id,
            actorId: userId,
            capacityGrams: updated.capacityGrams,
            active: updated.active
          });
          return updated;
        })
      );
    },

    async listDispatchPolicies(actor) {
      authorize(actor, "fulfillment:read");
      const defaultId = await defaultPolicyId(pool, actor.businessId);
      const result = await pool.query<PolicyRow>(
        `
          select * from fulfillment_dispatch_policies
          where business_id = $1 ${actor.includeHistory === true ? "" : "and active"}
          order by name, policy_id, version desc
        `,
        [actor.businessId]
      );
      return result.rows.map((row) => policySummary(row, defaultId));
    },

    async createDispatchPolicy(actor) {
      const { userId } = authorize(actor, "fulfillment:manage");
      const policy = normalizePolicy(actor.policy);
      assertValid(validateDispatchPolicyInput(policy));
      const now = actor.now ?? new Date();
      return transaction((client) =>
        idempotent(
          client,
          actor,
          "fulfillment.createDispatchPolicy",
          {
            ...policyRequest(policy),
            makeBusinessDefault: actor.makeBusinessDefault,
            expectedDefaultPolicyId: actor.expectedDefaultPolicyId
          },
          now,
          async () => {
            await assertDefaultPointer(
              client,
              actor.businessId,
              actor.expectedDefaultPolicyId,
              userId,
              now
            );
            const policyId = randomUUID();
            const row = await insertPolicyVersion(client, {
              businessId: actor.businessId,
              policyId,
              version: 1,
              policy,
              supersedesId: null,
              actorId: userId,
              now
            });
            if (actor.makeBusinessDefault) {
              await setDefaultPointer(client, actor.businessId, policyId, userId, now);
            }
            const created = policySummary(
              row,
              actor.makeBusinessDefault ? policyId : await defaultPolicyId(client, actor.businessId)
            );
            logFulfillmentEvent("fulfillment.dispatch_policy_created", {
              businessId: actor.businessId,
              policyId,
              version: 1,
              isBusinessDefault: created.isBusinessDefault
            });
            return created;
          }
        )
      );
    },

    async reviseDispatchPolicy(actor) {
      const { userId } = authorize(actor, "fulfillment:manage");
      const policy = normalizePolicy(actor.policy);
      assertValid(validateDispatchPolicyInput(policy));
      const now = actor.now ?? new Date();
      return transaction((client) =>
        idempotent(
          client,
          actor,
          "fulfillment.reviseDispatchPolicy",
          {
            policyId: actor.policyId,
            ...policyRequest(policy),
            expectedVersion: actor.expectedVersion ?? null,
            expectedDefaultPolicyId: actor.expectedDefaultPolicyId
          },
          now,
          async () => {
            // Serialize revisions of one lineage on a STABLE row: version 1 is never modified.
            // Locking the active version instead would be wrong under READ COMMITTED - a waiter
            // re-checks `active` after the winner commits, no longer matches, and sees nothing.
            // The (policy_id, version) unique constraint is the database backstop.
            await lockPolicyLineage(client, actor.businessId, actor.policyId);
            const current = await activePolicyVersion(client, actor.businessId, actor.policyId);
            if (current === null) {
              throw new Cp2Error(
                404,
                "dispatch_policy_not_found",
                "Dispatch policy was not found."
              );
            }
            await assertDefaultPointer(
              client,
              actor.businessId,
              actor.expectedDefaultPolicyId,
              userId,
              now
            );
            const expectedVersion = actor.expectedVersion ?? null;
            if (expectedVersion !== null && current.version !== expectedVersion) {
              throw new Cp2Error(
                409,
                "dispatch_policy_version_conflict",
                "These dispatch rules were changed since you opened them. Review the latest version and save again.",
                false,
                { expectedVersion, currentVersion: current.version }
              );
            }
            await client.query(
              "update fulfillment_dispatch_policies set active = false where id = $1",
              [current.id]
            );
            const row = await insertPolicyVersion(client, {
              businessId: actor.businessId,
              policyId: current.policy_id,
              version: current.version + 1,
              policy,
              supersedesId: current.id,
              actorId: userId,
              now
            });
            const revised = policySummary(row, await defaultPolicyId(client, actor.businessId));
            logFulfillmentEvent("fulfillment.dispatch_policy_revised", {
              businessId: actor.businessId,
              policyId: revised.policyId,
              version: revised.version,
              supersedesVersion: current.version
            });
            return revised;
          }
        )
      );
    },

    async setDefaultDispatchPolicy(actor) {
      const { userId } = authorize(actor, "fulfillment:manage");
      const now = actor.now ?? new Date();
      return transaction((client) =>
        idempotent(
          client,
          actor,
          "fulfillment.setDefaultDispatchPolicy",
          { policyId: actor.policyId },
          now,
          async () => {
            await lockPolicyLineage(client, actor.businessId, actor.policyId);
            const policy = await activePolicyVersion(client, actor.businessId, actor.policyId);
            if (policy === null) {
              throw new Cp2Error(
                404,
                "dispatch_policy_not_found",
                "Dispatch policy was not found."
              );
            }
            await setDefaultPointer(client, actor.businessId, policy.policy_id, userId, now);
            logFulfillmentEvent("fulfillment.default_policy_set", {
              businessId: actor.businessId,
              policyId: policy.policy_id,
              version: policy.version
            });
            return effectiveDefault(client, actor.businessId);
          }
        )
      );
    },

    async getEffectiveDefaultPolicy(actor) {
      authorize(actor, "fulfillment:read");
      return effectiveDefault(pool, actor.businessId);
    },

    async captureShopLocation(actor) {
      const { userId } = authorize(actor, "shop_location:write");
      deps.requireCustomer(actor.businessId, actor.customerId);
      const location = normalizeLocation(actor.location);
      assertValid(validateCoordinates(location));
      const requestNow = actor.now ?? new Date();
      return transaction(async (client) => {
        await idempotent(
          client,
          actor,
          "fulfillment.captureShopLocation",
          { customerId: actor.customerId, ...location },
          requestNow,
          async () => {
            await lockShopLocation(client, actor.businessId, actor.customerId);
            const capturedAt =
              actor.now ??
              (await client.query<{ captured_at: Date }>("select clock_timestamp() as captured_at"))
                .rows[0]?.captured_at;
            if (capturedAt === undefined) throw new Error("Database clock was unavailable.");
            const current = await client.query<{ id: string }>(
              `
                select id from fulfillment_shop_locations
                where business_id = $1 and customer_id = $2 and superseded_at is null
              `,
              [actor.businessId, actor.customerId]
            );
            const previousId = current.rows[0]?.id ?? null;
            if (previousId !== null) {
              await client.query(
                "update fulfillment_shop_locations set superseded_at = $2 where id = $1",
                [previousId, capturedAt]
              );
            }
            const id = randomUUID();
            await client.query(
              `
                insert into fulfillment_shop_locations
                  (id, business_id, customer_id, latitude, longitude, accuracy_meters,
                   captured_at, captured_by, superseded_at, created_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, null, $7)
              `,
              [
                id,
                actor.businessId,
                actor.customerId,
                location.latitude,
                location.longitude,
                location.accuracyMeters,
                capturedAt,
                userId
              ]
            );
            // Stable IDs only - coordinates are personal/location data and never logged.
            logFulfillmentEvent("fulfillment.shop_location_captured", {
              businessId: actor.businessId,
              customerId: actor.customerId,
              locationId: id,
              supersededLocationId: previousId
            });
            return { locationId: id };
          }
        );
        return locationStatus(client, actor, actor.customerId);
      });
    },

    async getShopLocation(actor) {
      authorize(actor, "fulfillment:read");
      deps.requireCustomer(actor.businessId, actor.customerId);
      return locationStatus(pool, actor, actor.customerId);
    },

    async listShopLocationHistory(actor) {
      authorize(actor, "shop_location:read_precise");
      deps.requireCustomer(actor.businessId, actor.customerId);
      const result = await pool.query<LocationRow>(
        `
          select * from fulfillment_shop_locations
          where business_id = $1 and customer_id = $2
          order by created_at desc, id desc
        `,
        [actor.businessId, actor.customerId]
      );
      return result.rows.map(locationSummary);
    },

    async purgeExpiredIdempotencyRecords(options) {
      const now = options.now ?? new Date();
      const hours = options.retentionHours ?? input.idempotencyRetentionHours ?? 24;
      if (!Number.isInteger(hours) || hours < 24) {
        throw new Error("Fulfillment idempotency records must be retained for at least 24 hours.");
      }
      const result = await pool.query(
        "delete from fulfillment_idempotency_records where created_at < $1",
        [new Date(now.getTime() - hours * 3_600_000)]
      );
      return result.rowCount ?? 0;
    },

    async deliverPendingOutboxEvents(options = {}) {
      const now = options.now ?? new Date();
      const batchSize = options.batchSize ?? 50;
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
        throw new Error("Fulfillment outbox batch size must be between 1 and 200.");
      }
      let delivered = 0;
      let failed = 0;
      for (let index = 0; index < batchSize; index += 1) {
        const processed = await transaction(async (client) => {
          const event = (
            await client.query<{
              id: string;
              business_id: string;
              event_type: string;
              payload: Record<string, unknown>;
              occurred_at: Date;
            }>(
              `select id, business_id, event_type, payload, occurred_at
                 from fulfillment_outbox_events
                where delivered_at is null
                order by occurred_at, id
                for update skip locked
                limit 1`
            )
          ).rows[0];
          if (event === undefined) return null;
          try {
            const delivery = {
              id: event.id,
              businessId: event.business_id,
              eventType: event.event_type,
              payload: event.payload,
              occurredAt: event.occurred_at.toISOString()
            };
            if (input.deliverOutboxEvent === undefined) {
              logFulfillmentEvent("fulfillment.outbox_delivered", delivery);
            } else {
              await input.deliverOutboxEvent(delivery);
            }
            await client.query(
              "update fulfillment_outbox_events set delivered_at = $2, attempt_count = attempt_count + 1, last_error = null where id = $1",
              [event.id, now]
            );
            return true;
          } catch (error) {
            await client.query(
              "update fulfillment_outbox_events set attempt_count = attempt_count + 1, last_error = $2 where id = $1",
              [event.id, (error instanceof Error ? error.message : String(error)).slice(0, 500)]
            );
            return false;
          }
        });
        if (processed === null) break;
        if (processed) delivered += 1;
        else {
          failed += 1;
          break;
        }
      }
      return { delivered, failed };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Rows, mapping, normalization
// ---------------------------------------------------------------------------------------------

interface VehicleRow {
  id: string;
  business_id: string;
  name: string;
  registration: string | null;
  capacity_grams: string;
  active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface PolicyRow {
  id: string;
  policy_id: string;
  business_id: string;
  version: number;
  name: string;
  target_load_grams: string;
  minimum_dispatch_load_grams: string | null;
  max_diversion_meters: number;
  cutoff_local_time: string;
  max_wait_hours: number;
  fulfillment_lead_days: number;
  under_threshold_fallback: string[];
  overflow_strategy: string;
  active: boolean;
  supersedes_id: string | null;
  created_by: string;
  created_at: Date;
}

interface LocationRow {
  id: string;
  business_id: string;
  customer_id: string;
  latitude: string;
  longitude: string;
  accuracy_meters: number | null;
  captured_at: Date;
  captured_by: string;
  superseded_at: Date | null;
}

/** Locks a policy lineage via its immutable version-1 row (A17 "stable serialization point"). */
async function lockPolicyLineage(
  client: PoolClient,
  businessId: string,
  policyId: string
): Promise<void> {
  if (!isUuid(policyId)) return;
  await client.query(
    `
      select id from fulfillment_dispatch_policies
      where business_id = $1 and policy_id = $2 and version = 1
      for update
    `,
    [businessId, policyId]
  );
}

/**
 * Serializes location captures for one shop. A row lock cannot do this: the first capture for a
 * shop has no row to lock, and the current row stops matching `superseded_at is null` once a
 * concurrent capture supersedes it. So this is the one justified `pg_advisory_xact_lock`
 * (A17): transaction-scoped (released at COMMIT/ROLLBACK, safe behind the transaction-mode
 * pooler - never a session lock); the key is a 64-bit hash of a namespaced
 * `business:customer` string; it protects only "who supersedes the current location of this
 * shop". A hash collision can only make two unrelated captures wait for each other - it can never
 * grant access across tenants, because every statement still filters by business_id. The
 * one-current partial unique index remains the database backstop.
 */
async function lockShopLocation(
  client: PoolClient,
  businessId: string,
  customerId: string
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `grogoni.fulfillment.shop_location:${businessId}:${customerId}`
  ]);
}

async function insertPolicyVersion(
  client: PoolClient,
  input: {
    businessId: string;
    policyId: string;
    version: number;
    policy: DispatchPolicyInput;
    supersedesId: string | null;
    actorId: string;
    now: Date;
  }
): Promise<PolicyRow> {
  const result = await client.query<PolicyRow>(
    `
      insert into fulfillment_dispatch_policies
        (id, policy_id, business_id, version, name, target_load_grams, minimum_dispatch_load_grams,
         max_diversion_meters, cutoff_local_time, max_wait_hours, fulfillment_lead_days,
         under_threshold_fallback, overflow_strategy, active, supersedes_id, created_by, created_at)
      values ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8, $9, $10, $11, $12::text[], $13, true,
              $14, $15, $16)
      returning *
    `,
    [
      randomUUID(),
      input.policyId,
      input.businessId,
      input.version,
      input.policy.name,
      formatGrams(input.policy.targetLoadGrams),
      formatNullableGrams(input.policy.minimumDispatchLoadGrams),
      input.policy.maxDiversionMeters,
      input.policy.cutoffLocalTime,
      input.policy.maxWaitHours,
      input.policy.fulfillmentLeadDays,
      input.policy.underThresholdFallback,
      input.policy.overflowStrategy,
      input.supersedesId,
      input.actorId,
      input.now
    ]
  );
  return result.rows[0] as PolicyRow;
}

function vehicleSummary(row: VehicleRow): VehicleSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    registration: row.registration,
    capacityGrams: row.capacity_grams,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function policySummary(row: PolicyRow, defaultPolicyId: string | null): DispatchPolicySummary {
  return {
    id: row.id,
    policyId: row.policy_id,
    businessId: row.business_id,
    version: row.version,
    name: row.name,
    isBusinessDefault: row.policy_id === defaultPolicyId,
    targetLoadGrams: row.target_load_grams,
    minimumDispatchLoadGrams: row.minimum_dispatch_load_grams,
    maxDiversionMeters: row.max_diversion_meters,
    cutoffLocalTime: row.cutoff_local_time,
    maxWaitHours: row.max_wait_hours,
    fulfillmentLeadDays: row.fulfillment_lead_days,
    underThresholdFallback: row.under_threshold_fallback as DispatchFallbackAction[],
    overflowStrategy: row.overflow_strategy as DispatchOverflowStrategy,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString()
  };
}

function locationSummary(row: LocationRow): ShopLocationSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    customerId: row.customer_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracyMeters: row.accuracy_meters,
    capturedAt: row.captured_at.toISOString(),
    capturedBy: row.captured_by,
    supersededAt: row.superseded_at === null ? null : row.superseded_at.toISOString()
  };
}

function normalizeVehicle(input: VehicleMutationInput): VehicleMutationInput {
  const registration = input.registration?.trim() ?? "";
  return {
    name: input.name.trim(),
    registration: registration === "" ? null : registration,
    capacityGrams: input.capacityGrams,
    active: input.active
  };
}

function normalizePolicy(input: DispatchPolicyInput): DispatchPolicyInput {
  return { ...input, name: input.name.trim() };
}

function policyRequest(policy: DispatchPolicyInput) {
  return {
    ...policy,
    targetLoadGrams: formatGrams(policy.targetLoadGrams),
    minimumDispatchLoadGrams: formatNullableGrams(policy.minimumDispatchLoadGrams)
  };
}

/** Stored as numeric(9,6) (about 0.1 m); rounding here keeps the response equal to the row. */
function normalizeLocation(input: ShopLocationCaptureInput): ShopLocationCaptureInput {
  const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
  return {
    latitude: round6(input.latitude),
    longitude: round6(input.longitude),
    accuracyMeters:
      input.accuracyMeters === null || !Number.isFinite(input.accuracyMeters)
        ? input.accuracyMeters
        : Math.round(input.accuracyMeters)
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function requireUuid(value: string, code: string, message: string): void {
  if (!isUuid(value)) throw new Cp2Error(404, code, message);
}

function rethrowRegistrationConflict(error: unknown): never {
  if ((error as { code?: string; constraint?: string } | null)?.code === "23505") {
    throw new Cp2Error(
      409,
      "vehicle_registration_taken",
      "Another vehicle in this business already has that registration."
    );
  }
  throw error;
}

/** Phase 1 observability (A19): structured logs with stable ids, no personal data. */
function logFulfillmentEvent(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...fields }));
}
