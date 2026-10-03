/**
 * Corridor operations for the Postgres-authoritative FulfillmentService (Phase 1b,
 * docs/architecture/corridor-fulfillment.md A14-A17). Geometry and matching are the pure
 * business-core functions; this module only loads rows, applies A17 locking, and persists
 * append-only provenance.
 *
 * Lock order (A17 §6.1): corridor rows (ascending id) -> order row. Every write that changes an
 * order's corridor resolution follows lock-then-recheck: read without locks, lock, re-read, and
 * retry (FulfillmentRecheckConflict) if anything it depended on changed in between. Row locks
 * target stable predicates (`id`) only - never a predicate a concurrent winner could flip, which
 * would make a READ COMMITTED waiter silently skip the row (see §11.4).
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  resolveCorridor,
  validateCorridorGeometry,
  type BusinessPermission,
  type CorridorMatch,
  type CorridorResolution
} from "@grogoni/business-core";
import type {
  ConfirmedOrderReference,
  CorridorGeometryVersionSummary,
  CorridorLineString,
  CorridorMatchResultSummary,
  CorridorMatchSummary,
  CorridorResolutionStaleReason,
  CorridorResolutionStatusSummary,
  CorridorResolutionSummary,
  CorridorSummary,
  ResolveOrderCorridorResultSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { FulfillmentRecheckConflict } from "./transaction.js";
import { upsertFulfillmentOrder } from "./order-rows.js";

export interface CorridorActor {
  sessionId: string | null;
  businessId: string;
  idempotencyKey?: string | null;
  now?: Date;
}

export interface CorridorCreateInput {
  name: string;
  originLabel: string;
  destinationLabel: string;
  routeGeometry: unknown;
  priority?: number;
  policyOverrideId?: string | null;
  active?: boolean;
}

export interface CorridorPatchInput {
  name?: string;
  originLabel?: string;
  destinationLabel?: string;
  priority?: number;
  policyOverrideId?: string | null;
  active?: boolean;
}

export interface CorridorOperations {
  listCorridors(input: CorridorActor & { includeInactive?: boolean }): Promise<CorridorSummary[]>;
  getCorridor(input: CorridorActor & { corridorId: string }): Promise<CorridorSummary>;
  createCorridor(
    input: CorridorActor & { corridor: CorridorCreateInput }
  ): Promise<CorridorSummary>;
  updateCorridor(
    input: CorridorActor & { corridorId: string; patch: CorridorPatchInput }
  ): Promise<CorridorSummary>;
  updateCorridorGeometry(
    input: CorridorActor & { corridorId: string; routeGeometry: unknown }
  ): Promise<CorridorSummary>;
  listCorridorGeometryVersions(
    input: CorridorActor & { corridorId: string }
  ): Promise<CorridorGeometryVersionSummary[]>;
  /** A15: compute (never persist) the corridor match for a shop's current delivery point. */
  resolveCorridorForShop(
    input: CorridorActor & { customerId: string }
  ): Promise<CorridorMatchResultSummary>;
  /** A16: resolve an order from its shop's current location and append an AUTO record. */
  resolveCorridorForOrder(
    input: CorridorActor & { invoiceId: string }
  ): Promise<ResolveOrderCorridorResultSummary>;
  /** A16: assign one of the currently qualifying corridors and append a MANUAL record. */
  assignCorridorManually(
    input: CorridorActor & { invoiceId: string; corridorId: string }
  ): Promise<ResolveOrderCorridorResultSummary>;
  /** A16: current resolution, computed staleness, and the full provenance history. */
  getResolutionStatus(
    input: CorridorActor & { invoiceId: string }
  ): Promise<CorridorResolutionStatusSummary>;
}

/** Internal operations for trusted callers inside the fulfillment domain (never routed). */
export interface CorridorInternalOperations {
  /** AUTO-resolve on behalf of an actor who already caused the order to enter fulfillment. */
  resolveCorridorAsSystem(input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now?: Date;
  }): Promise<ResolveOrderCorridorResultSummary>;
}

export interface CorridorOperationsContext {
  pool: Pool;
  authorize: (actor: CorridorActor, permission: BusinessPermission) => { userId: string };
  requireCustomer: (businessId: string, customerId: string) => { id: string };
  requireConfirmedOrder: (businessId: string, invoiceId: string) => ConfirmedOrderReference;
  transaction: <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
  idempotent: <T>(
    client: PoolClient,
    actor: CorridorActor,
    operation: string,
    request: unknown,
    now: Date,
    mutate: () => Promise<T>
  ) => Promise<T>;
  requireActivePolicyLineage: (
    client: PoolClient,
    businessId: string,
    policyId: string
  ) => Promise<void>;
  log: (event: string, fields: Record<string, unknown>) => void;
}

export function createCorridorOperations(
  context: CorridorOperationsContext
): CorridorOperations & CorridorInternalOperations {
  const { pool } = context;

  async function requireCorridor(
    client: PoolClient | Pool,
    businessId: string,
    corridorId: string,
    lock: boolean
  ): Promise<CorridorRow> {
    if (!isUuid(corridorId)) throw corridorNotFound();
    const result = await client.query<CorridorRow>(
      `select * from fulfillment_corridors where business_id = $1 and id = $2${lock ? " for update" : ""}`,
      [businessId, corridorId]
    );
    const row = result.rows[0];
    if (row === undefined) throw corridorNotFound();
    return row;
  }

  /** Locks corridors in ascending id order (A17 global lock order, step 1). */
  async function lockCorridors(
    client: PoolClient,
    businessId: string,
    corridorIds: Array<string | null>
  ): Promise<Map<string, CorridorRow>> {
    const ids = [...new Set(corridorIds.filter((id): id is string => id !== null))].sort();
    const locked = new Map<string, CorridorRow>();
    for (const id of ids) {
      const result = await client.query<CorridorRow>(
        "select * from fulfillment_corridors where business_id = $1 and id = $2 for update",
        [businessId, id]
      );
      const row = result.rows[0];
      if (row !== undefined) locked.set(id, row);
    }
    return locked;
  }

  async function currentShopLocation(
    client: PoolClient | Pool,
    businessId: string,
    customerId: string | null
  ): Promise<LocationRow | null> {
    if (customerId === null) return null;
    const result = await client.query<LocationRow>(
      `
        select id, latitude, longitude from fulfillment_shop_locations
        where business_id = $1 and customer_id = $2 and superseded_at is null
      `,
      [businessId, customerId]
    );
    return result.rows[0] ?? null;
  }

  /** Active corridors with their effective tolerance: override lineage ?? business default. */
  async function loadCandidates(client: PoolClient | Pool, businessId: string) {
    const result = await client.query<
      CorridorRow & { effective_max_diversion_meters: number | null }
    >(
      `
        select c.*,
               coalesce(override_policy.max_diversion_meters, default_policy.max_diversion_meters)
                 as effective_max_diversion_meters
        from fulfillment_corridors c
        left join fulfillment_dispatch_policies override_policy
          on override_policy.business_id = c.business_id
         and override_policy.policy_id = c.policy_override_id
         and override_policy.active
        left join fulfillment_business_settings settings on settings.business_id = c.business_id
        left join fulfillment_dispatch_policies default_policy
          on default_policy.business_id = c.business_id
         and default_policy.policy_id = settings.default_policy_id
         and default_policy.active
        where c.business_id = $1 and c.active
        order by c.id
      `,
      [businessId]
    );
    return result.rows;
  }

  async function computeMatch(
    client: PoolClient | Pool,
    businessId: string,
    location: LocationRow | null
  ): Promise<{ resolution: CorridorResolution; names: Map<string, string> }> {
    const candidates = await loadCandidates(client, businessId);
    const tolerance = new Map(
      candidates.map((row) => [row.id, row.effective_max_diversion_meters])
    );
    const names = new Map(candidates.map((row) => [row.id, row.name]));
    const resolution = resolveCorridor(
      location === null
        ? null
        : { latitude: Number(location.latitude), longitude: Number(location.longitude) },
      candidates.map((row) => ({
        id: row.id,
        priority: row.priority,
        geometryVersion: row.geometry_version,
        geometry: row.route_geometry
      })),
      (corridor) => tolerance.get(corridor.id) ?? null
    );
    return { resolution, names };
  }

  async function currentResolution(
    client: PoolClient | Pool,
    businessId: string,
    fulfillmentOrderId: string
  ): Promise<ResolutionRow | null> {
    const result = await client.query<ResolutionRow>(
      `
        select r.*, o.invoice_id from fulfillment_corridor_resolutions r
        join fulfillment_orders o on o.business_id = r.business_id and o.id = r.fulfillment_order_id
        where r.business_id = $1 and r.fulfillment_order_id = $2 and r.superseded_at is null
      `,
      [businessId, fulfillmentOrderId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * The shared write path for AUTO and MANUAL resolution (A16/A17 lock-then-recheck):
   * 1. unlocked reads: order row, current resolution, shop location, candidates and match;
   * 2. lock previous and chosen corridors (ascending id), then the order row;
   * 3. re-read everything the decision depended on; retry if any of it moved;
   * 4. supersede the previous record and append the new one.
   */
  async function writeResolution(
    actor: CorridorActor & { invoiceId: string },
    mode: { method: "AUTO" } | { method: "MANUAL"; corridorId: string },
    /** Set only by trusted internal callers (intake) that already established the actor. */
    systemActorId?: string
  ): Promise<ResolveOrderCorridorResultSummary> {
    const userId = systemActorId ?? context.authorize(actor, "fulfillment:dispatch").userId;
    const invoiceId = actor.invoiceId;
    const order = context.requireConfirmedOrder(actor.businessId, invoiceId);
    const now = actor.now ?? new Date();
    const operation =
      mode.method === "AUTO" ? "fulfillment.resolveCorridorForOrder" : "fulfillment.assignCorridor";
    return context.transaction((client) =>
      context.idempotent(client, actor, operation, { invoiceId, ...mode }, now, async () => {
        const { row: orderRow } = await upsertFulfillmentOrder(
          client,
          actor.businessId,
          order,
          now
        );
        const fulfillmentOrderId = orderRow.id;
        const previous = await currentResolution(client, actor.businessId, fulfillmentOrderId);
        const location = await currentShopLocation(client, actor.businessId, order.customerId);
        const { resolution, names } = await computeMatch(client, actor.businessId, location);

        let chosen: CorridorMatch;
        let reason: ResolvedReason;
        let alternatives: CorridorMatch[];
        if (resolution.status === "UNRESOLVED") {
          if (mode.method === "MANUAL") {
            throw new Cp2Error(
              422,
              "corridor_not_qualifying",
              "The shop's delivery point does not qualify for any corridor right now.",
              false,
              { reason: resolution.reason }
            );
          }
          context.log("fulfillment.corridor_resolution_failed", {
            businessId: actor.businessId,
            invoiceId,
            reason: resolution.reason
          });
          return {
            outcome: "UNRESOLVED",
            reason: resolution.reason,
            nearest: resolution.nearest === null ? null : matchSummary(resolution.nearest, names),
            current: previous === null ? null : resolutionSummary(previous)
          };
        }
        if (mode.method === "MANUAL") {
          // Off-corridor manual exceptions are not supported (A16): only a qualifying corridor.
          const qualifying = [resolution.selected, ...resolution.alternatives];
          const match = qualifying.find((candidate) => candidate.corridorId === mode.corridorId);
          if (match === undefined) {
            throw new Cp2Error(
              422,
              "corridor_not_qualifying",
              "That corridor is not a qualifying option for this shop's delivery point.",
              false,
              { corridorId: mode.corridorId }
            );
          }
          chosen = match;
          alternatives = qualifying.filter((candidate) => candidate !== match);
          reason = "MANUAL_ASSIGNMENT";
        } else {
          chosen = resolution.selected;
          alternatives = resolution.alternatives;
          reason = resolution.reason;
        }

        const locked = await lockCorridors(client, actor.businessId, [
          previous?.corridor_id ?? null,
          chosen.corridorId
        ]);
        const lockedOrder = await client.query<{ state: string }>(
          "select state from fulfillment_orders where business_id = $1 and id = $2 for update",
          [actor.businessId, fulfillmentOrderId]
        );
        // A16: resolution only changes before allocation. An allocated order must first be removed
        // from its manifest; delivered, cancelled or orphaned orders are no longer in the pool.
        const state = lockedOrder.rows[0]?.state;
        if (state !== "POOLED") {
          throw new Cp2Error(
            409,
            state === "ALLOCATED" ? "order_allocated" : "order_not_pooled",
            state === "ALLOCATED"
              ? "Remove the order from its manifest before changing its corridor."
              : "This order is no longer waiting for delivery.",
            false,
            { state: state ?? null }
          );
        }
        const lockedCorridor = locked.get(chosen.corridorId);
        const recheckPrevious = await currentResolution(
          client,
          actor.businessId,
          fulfillmentOrderId
        );
        const recheckLocation = await currentShopLocation(
          client,
          actor.businessId,
          order.customerId
        );
        // Recheck under the locks. A concurrent re-resolution may have appended a newer record
        // meanwhile; that is fine as long as its corridor is one we hold a lock on (A17: source
        // and target corridors locked). Anything else the decision depended on must be unchanged.
        if (
          lockedCorridor === undefined ||
          !lockedCorridor.active ||
          lockedCorridor.geometry_version !== chosen.geometryVersion ||
          (recheckPrevious !== null && !locked.has(recheckPrevious.corridor_id)) ||
          (recheckLocation?.id ?? null) !== (location?.id ?? null)
        ) {
          throw new FulfillmentRecheckConflict();
        }

        if (recheckPrevious !== null) {
          await client.query(
            "update fulfillment_corridor_resolutions set superseded_at = $2 where id = $1",
            [recheckPrevious.id, now]
          );
        }
        const inserted = await client.query<ResolutionRow>(
          `
            insert into fulfillment_corridor_resolutions
              (id, business_id, fulfillment_order_id, corridor_id, corridor_geometry_version,
               shop_location_id, diversion_meters, distance_along_meters, segment_index,
               max_diversion_meters, resolution_method, resolved_by, resolved_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            returning *, $14::uuid as invoice_id
          `,
          [
            randomUUID(),
            actor.businessId,
            fulfillmentOrderId,
            chosen.corridorId,
            chosen.geometryVersion,
            (location as LocationRow).id,
            roundMetres(chosen.diversionMeters),
            roundMetres(chosen.distanceAlongMeters),
            chosen.segmentIndex,
            chosen.maxDiversionMeters,
            mode.method,
            userId,
            now,
            invoiceId
          ]
        );
        const record = resolutionSummary(inserted.rows[0] as ResolutionRow);
        context.log("fulfillment.corridor_resolved", {
          businessId: actor.businessId,
          invoiceId,
          fulfillmentOrderId,
          corridorId: record.corridorId,
          corridorGeometryVersion: record.corridorGeometryVersion,
          resolutionMethod: record.resolutionMethod,
          supersededResolutionId: recheckPrevious?.id ?? null
        });
        return {
          outcome: "RESOLVED",
          resolution: record,
          alternatives: alternatives.map((match) => matchSummary(match, names)),
          reason
        };
      })
    );
  }

  return {
    async listCorridors(actor) {
      context.authorize(actor, "fulfillment:read");
      const result = await pool.query<CorridorRow>(
        `
          select * from fulfillment_corridors
          where business_id = $1 ${actor.includeInactive === true ? "" : "and active"}
          order by priority, name, id
        `,
        [actor.businessId]
      );
      return result.rows.map(corridorSummary);
    },

    async getCorridor(actor) {
      context.authorize(actor, "fulfillment:read");
      return corridorSummary(
        await requireCorridor(pool, actor.businessId, actor.corridorId, false)
      );
    },

    async createCorridor(actor) {
      const { userId } = context.authorize(actor, "fulfillment:manage");
      const input = normalizeCorridor(actor.corridor);
      const geometry = requireGeometry(actor.corridor.routeGeometry);
      const now = actor.now ?? new Date();
      return context.transaction((client) =>
        context.idempotent(
          client,
          actor,
          "fulfillment.createCorridor",
          { ...input, routeGeometry: geometry.geometry },
          now,
          async () => {
            if (input.policyOverrideId !== null) {
              await context.requireActivePolicyLineage(
                client,
                actor.businessId,
                input.policyOverrideId
              );
            }
            const id = randomUUID();
            const distance = roundMetres(geometry.distanceMeters);
            const result = await client.query<CorridorRow>(
              `
                insert into fulfillment_corridors
                  (id, business_id, name, origin_label, destination_label, route_geometry,
                   distance_meters, geometry_version, priority, policy_override_id, active,
                   created_by, created_at, updated_at)
                values ($1, $2, $3, $4, $5, $6::jsonb, $7, 1, $8, $9, $10, $11, $12, $12)
                returning *
              `,
              [
                id,
                actor.businessId,
                input.name,
                input.originLabel,
                input.destinationLabel,
                JSON.stringify(geometry.geometry),
                distance,
                input.priority,
                input.policyOverrideId,
                input.active,
                userId,
                now
              ]
            );
            await insertGeometryVersion(
              client,
              actor.businessId,
              id,
              1,
              geometry.geometry,
              distance,
              userId,
              now
            );
            const created = corridorSummary(result.rows[0] as CorridorRow);
            context.log("fulfillment.corridor_created", {
              businessId: actor.businessId,
              corridorId: id,
              geometryVersion: 1,
              distanceMeters: created.distanceMeters
            });
            return created;
          }
        )
      );
    },

    async updateCorridor(actor) {
      const { userId } = context.authorize(actor, "fulfillment:manage");
      const now = actor.now ?? new Date();
      // A23: a retried update replays its first result instead of re-applying the patch over a
      // change someone made in between.
      return context.transaction((client) =>
        context.idempotent(
          client,
          actor,
          "fulfillment.updateCorridor",
          { corridorId: actor.corridorId, ...actor.patch },
          now,
          async () => {
            const existing = await requireCorridor(
              client,
              actor.businessId,
              actor.corridorId,
              true
            );
            const next = normalizeCorridor({
              name: actor.patch.name ?? existing.name,
              originLabel: actor.patch.originLabel ?? existing.origin_label,
              destinationLabel: actor.patch.destinationLabel ?? existing.destination_label,
              routeGeometry: existing.route_geometry,
              priority: actor.patch.priority ?? existing.priority,
              policyOverrideId:
                actor.patch.policyOverrideId === undefined
                  ? existing.policy_override_id
                  : actor.patch.policyOverrideId,
              active: actor.patch.active ?? existing.active
            });
            if (
              next.policyOverrideId !== null &&
              next.policyOverrideId !== existing.policy_override_id
            ) {
              await context.requireActivePolicyLineage(
                client,
                actor.businessId,
                next.policyOverrideId
              );
            }
            const result = await client.query<CorridorRow>(
              `
            update fulfillment_corridors
            set name = $3, origin_label = $4, destination_label = $5, priority = $6,
                policy_override_id = $7, active = $8, updated_at = $9
            where business_id = $1 and id = $2
            returning *
          `,
              [
                actor.businessId,
                existing.id,
                next.name,
                next.originLabel,
                next.destinationLabel,
                next.priority,
                next.policyOverrideId,
                next.active,
                now
              ]
            );
            const updated = corridorSummary(result.rows[0] as CorridorRow);
            context.log("fulfillment.corridor_updated", {
              businessId: actor.businessId,
              corridorId: updated.id,
              actorId: userId,
              active: updated.active,
              priority: updated.priority
            });
            return updated;
          }
        )
      );
    },

    async updateCorridorGeometry(actor) {
      const { userId } = context.authorize(actor, "fulfillment:manage");
      const geometry = requireGeometry(actor.routeGeometry);
      const now = actor.now ?? new Date();
      return context.transaction((client) =>
        context.idempotent(
          client,
          actor,
          "fulfillment.updateCorridorGeometry",
          { corridorId: actor.corridorId, routeGeometry: geometry.geometry },
          now,
          async () => {
            // The corridor row lock serializes geometry edits with every resolution write for this
            // corridor, so a resolution can never be recorded against a version being replaced.
            const existing = await requireCorridor(
              client,
              actor.businessId,
              actor.corridorId,
              true
            );
            const version = existing.geometry_version + 1;
            const distance = roundMetres(geometry.distanceMeters);
            const result = await client.query<CorridorRow>(
              `
                update fulfillment_corridors
                set route_geometry = $3::jsonb, distance_meters = $4, geometry_version = $5, updated_at = $6
                where business_id = $1 and id = $2
                returning *
              `,
              [
                actor.businessId,
                existing.id,
                JSON.stringify(geometry.geometry),
                distance,
                version,
                now
              ]
            );
            await insertGeometryVersion(
              client,
              actor.businessId,
              existing.id,
              version,
              geometry.geometry,
              distance,
              userId,
              now
            );
            const updated = corridorSummary(result.rows[0] as CorridorRow);
            context.log("fulfillment.corridor_geometry_changed", {
              businessId: actor.businessId,
              corridorId: updated.id,
              previousGeometryVersion: existing.geometry_version,
              geometryVersion: version
            });
            return updated;
          }
        )
      );
    },

    async listCorridorGeometryVersions(actor) {
      context.authorize(actor, "fulfillment:read");
      await requireCorridor(pool, actor.businessId, actor.corridorId, false);
      const result = await pool.query<GeometryVersionRow>(
        `
          select * from fulfillment_corridor_geometry_versions
          where business_id = $1 and corridor_id = $2
          order by version desc
        `,
        [actor.businessId, actor.corridorId]
      );
      return result.rows.map((row) => ({
        corridorId: row.corridor_id,
        version: row.version,
        routeGeometry: row.route_geometry as CorridorLineString,
        distanceMeters: Number(row.distance_meters),
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString()
      }));
    },

    async resolveCorridorForShop(actor) {
      context.authorize(actor, "fulfillment:read");
      context.requireCustomer(actor.businessId, actor.customerId);
      const location = await currentShopLocation(pool, actor.businessId, actor.customerId);
      const { resolution, names } = await computeMatch(pool, actor.businessId, location);
      return resolution.status === "RESOLVED"
        ? {
            status: "RESOLVED",
            shopLocationId: (location as LocationRow).id,
            selected: matchSummary(resolution.selected, names),
            alternatives: resolution.alternatives.map((match) => matchSummary(match, names)),
            reason: resolution.reason
          }
        : {
            status: "UNRESOLVED",
            shopLocationId: location?.id ?? null,
            reason: resolution.reason,
            nearest: resolution.nearest === null ? null : matchSummary(resolution.nearest, names)
          };
    },

    resolveCorridorForOrder: (actor) => writeResolution(actor, { method: "AUTO" }),

    resolveCorridorAsSystem: (input) =>
      writeResolution(
        {
          sessionId: null,
          businessId: input.businessId,
          invoiceId: input.invoiceId,
          ...(input.now === undefined ? {} : { now: input.now })
        },
        { method: "AUTO" },
        input.actorId
      ),

    assignCorridorManually: (actor) =>
      writeResolution(actor, { method: "MANUAL", corridorId: actor.corridorId }),

    async getResolutionStatus(actor) {
      context.authorize(actor, "fulfillment:read");
      const order = context.requireConfirmedOrder(actor.businessId, actor.invoiceId);
      const history = await pool.query<ResolutionRow>(
        `
          select r.*, o.invoice_id from fulfillment_corridor_resolutions r
          join fulfillment_orders o on o.business_id = r.business_id and o.id = r.fulfillment_order_id
          where r.business_id = $1 and o.invoice_id = $2
          order by r.resolved_at desc, r.id desc
        `,
        [actor.businessId, order.invoiceId]
      );
      const records = history.rows.map(resolutionSummary);
      const current = records.find((record) => record.supersededAt === null) ?? null;
      const staleReasons: CorridorResolutionStaleReason[] = [];
      if (current !== null) {
        const corridor = await requireCorridor(pool, actor.businessId, current.corridorId, false);
        if (corridor.geometry_version !== current.corridorGeometryVersion) {
          staleReasons.push("GEOMETRY_CHANGED");
        }
        const location = await currentShopLocation(pool, actor.businessId, order.customerId);
        if ((location?.id ?? null) !== current.shopLocationId) {
          staleReasons.push("LOCATION_CHANGED");
        }
      }
      return {
        businessId: actor.businessId,
        invoiceId: order.invoiceId,
        resolutionStatus: current === null ? "UNRESOLVED" : "RESOLVED",
        current,
        stale: staleReasons.length > 0,
        staleReasons,
        history: records
      };
    }
  };
}

// ---------------------------------------------------------------------------------------------

type ResolvedReason = Extract<ResolveOrderCorridorResultSummary, { outcome: "RESOLVED" }>["reason"];

interface CorridorRow {
  id: string;
  business_id: string;
  name: string;
  origin_label: string;
  destination_label: string;
  route_geometry: CorridorLineString;
  distance_meters: string;
  geometry_version: number;
  priority: number;
  policy_override_id: string | null;
  active: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface GeometryVersionRow {
  corridor_id: string;
  version: number;
  route_geometry: unknown;
  distance_meters: string;
  created_by: string;
  created_at: Date;
}

interface LocationRow {
  id: string;
  latitude: string;
  longitude: string;
}

interface ResolutionRow {
  id: string;
  business_id: string;
  fulfillment_order_id: string;
  invoice_id: string;
  corridor_id: string;
  corridor_geometry_version: number;
  shop_location_id: string;
  diversion_meters: string;
  distance_along_meters: string;
  segment_index: number;
  max_diversion_meters: number;
  resolution_method: "AUTO" | "MANUAL";
  resolved_by: string;
  resolved_at: Date;
  superseded_at: Date | null;
}

async function insertGeometryVersion(
  client: PoolClient,
  businessId: string,
  corridorId: string,
  version: number,
  geometry: unknown,
  distance: number,
  actorId: string,
  now: Date
): Promise<void> {
  await client.query(
    `
      insert into fulfillment_corridor_geometry_versions
        (business_id, corridor_id, version, route_geometry, distance_meters, created_by, created_at)
      values ($1, $2, $3, $4::jsonb, $5, $6, $7)
    `,
    [businessId, corridorId, version, JSON.stringify(geometry), distance, actorId, now]
  );
}

function corridorSummary(row: CorridorRow): CorridorSummary {
  const coordinates = row.route_geometry.coordinates;
  const [originLng, originLat] = coordinates[0] as [number, number];
  const [destinationLng, destinationLat] = coordinates[coordinates.length - 1] as [number, number];
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    originLabel: row.origin_label,
    destinationLabel: row.destination_label,
    origin: { latitude: originLat, longitude: originLng },
    destination: { latitude: destinationLat, longitude: destinationLng },
    routeGeometry: row.route_geometry,
    distanceMeters: Number(row.distance_meters),
    geometryVersion: row.geometry_version,
    priority: row.priority,
    policyOverrideId: row.policy_override_id,
    active: row.active,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function resolutionSummary(row: ResolutionRow): CorridorResolutionSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    fulfillmentOrderId: row.fulfillment_order_id,
    invoiceId: row.invoice_id,
    corridorId: row.corridor_id,
    corridorGeometryVersion: row.corridor_geometry_version,
    shopLocationId: row.shop_location_id,
    diversionMeters: Number(row.diversion_meters),
    distanceAlongMeters: Number(row.distance_along_meters),
    segmentIndex: row.segment_index,
    maxDiversionMeters: row.max_diversion_meters,
    resolutionMethod: row.resolution_method,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at.toISOString(),
    supersededAt: row.superseded_at === null ? null : row.superseded_at.toISOString()
  };
}

function matchSummary(match: CorridorMatch, names: Map<string, string>): CorridorMatchSummary {
  return {
    corridorId: match.corridorId,
    corridorName: names.get(match.corridorId) ?? "",
    geometryVersion: match.geometryVersion,
    diversionMeters: roundMetres(match.diversionMeters),
    distanceAlongMeters: roundMetres(match.distanceAlongMeters),
    segmentIndex: match.segmentIndex,
    maxDiversionMeters: match.maxDiversionMeters
  };
}

/** Persisted as numeric(12,3); rounding here keeps responses equal to stored rows. */
function roundMetres(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function requireGeometry(value: unknown) {
  const validation = validateCorridorGeometry(value);
  if (!validation.ok) {
    throw new Cp2Error(400, "corridor_geometry_invalid", validation.errors.join(" "));
  }
  return validation;
}

function normalizeCorridor(input: CorridorCreateInput) {
  const name = input.name.trim();
  const originLabel = input.originLabel.trim();
  const destinationLabel = input.destinationLabel.trim();
  const priority = input.priority ?? 100;
  const errors: string[] = [];
  if (name.length < 1 || name.length > 80) errors.push("Corridor name must be 1-80 characters.");
  if (originLabel.length < 1 || originLabel.length > 120)
    errors.push("Origin label must be 1-120 characters.");
  if (destinationLabel.length < 1 || destinationLabel.length > 120)
    errors.push("Destination label must be 1-120 characters.");
  if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000)
    errors.push("Priority must be a whole number between 0 and 1000000.");
  if (errors.length > 0) throw new Cp2Error(400, "validation_failed", errors.join(" "));
  return {
    name,
    originLabel,
    destinationLabel,
    priority,
    policyOverrideId: input.policyOverrideId ?? null,
    active: input.active ?? true
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

function corridorNotFound(): Cp2Error {
  return new Cp2Error(404, "corridor_not_found", "Corridor was not found.");
}
