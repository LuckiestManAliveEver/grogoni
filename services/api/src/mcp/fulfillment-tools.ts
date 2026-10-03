/**
 * Corridor fulfillment over MCP (docs/architecture/corridor-fulfillment.md, "MCP tools").
 *
 * Every public fulfillment operation that the HTTP surface exposes is one tool here, declared as
 * data: name, scope, JSON input schema and a `run` that parses with the same parsers as the HTTP
 * routes (cp2/domains/fulfillment/input.ts) and calls the same FulfillmentService / Cp2Store
 * method. No fulfillment rule lives in this file. The caller runs `run` inside
 * `store.runFulfillmentForMcp`, so the service authorizes the MCP principal against its business
 * membership and role exactly as it would a browser session (A8, tenant isolation).
 *
 * Reads need `mcp:read`; mutations need `mcp:act`. Each mutation declares its `retry` contract
 * (see `RetryContract`) and appends it to its description, so what an agent reads about repeating
 * a call is true: `replay` tools require an `idempotencyKey`, `refused` and `deduplicated` tools
 * accept one, and the `absolute` tool takes none. Gram values are decimal strings in both
 * directions (A22).
 */
import type { McpAccessScope } from "@grogoni/shared-types";
import { Cp2Error, type Cp2Store } from "../cp2/store.js";
import type { FulfillmentService } from "../cp2/domains/fulfillment/service.js";
import {
  approvalDecisions,
  approvalStatuses,
  deliveryOutcomes,
  manifestStatuses,
  parseApprovalDecisionBody,
  parseApprovalStatus,
  parseCorridorBody,
  parseCorridorPatch,
  parseDeliveryBody,
  parseDriverBody,
  parseManifestBody,
  parseManifestStatus,
  parseOptionalBoolean,
  parseExpectedDefault,
  parsePolicyBody,
  parsePolicyRevisionBody,
  parseShopLocationBody,
  parseVehicleBody,
  parseVehiclePatch
} from "../cp2/domains/fulfillment/input.js";
import { parseNullableString, parseString } from "../cp2/route-helpers.js";

type JsonSchema = Record<string, unknown>;

export interface FulfillmentToolContext {
  args: Record<string, unknown>;
  businessId: string;
  service: FulfillmentService;
  store: Cp2Store;
}

interface FulfillmentActor {
  sessionId: null;
  businessId: string;
  idempotencyKey: string | null;
}

export interface FulfillmentMcpTool {
  name: string;
  description: string;
  scope: McpAccessScope;
  /** Cancels or removes work that a person already planned. */
  destructive?: boolean;
  /** Mutations only: what happens when an agent repeats the call (see `retryContracts`). */
  retry?: RetryContract;
  properties: Record<string, JsonSchema>;
  required: string[];
  run(context: FulfillmentToolContext, actor: FulfillmentActor): unknown;
}

/**
 * What repeating a mutation does, stated per tool so the description an agent reads is true:
 * - replay: an A23 idempotency record in the same transaction; the same key and arguments return
 *   the first result without applying anything again, the same key with other arguments is refused
 *   (`idempotency_key_reused`). The key is required.
 * - refused: a state transition; once it has happened, repeating it is refused
 *   (`manifest_not_open`, `stop_already_recorded`, ...) instead of being applied twice.
 * - deduplicated: the domain keeps one result (one intake per order, one evaluation per corridor
 *   and business day), so repeating it returns that result.
 * - absolute: writes an absolute value; repeating it writes the same value again. The business
 *   timezone lives in the Cp2Store, which cannot share a transaction with the fulfillment
 *   idempotency table, so this is the one tool that does not use a key.
 */
export type RetryContract = "replay" | "refused" | "deduplicated" | "absolute";

const retryContracts: Record<RetryContract, string> = {
  replay:
    "Requires idempotencyKey: retrying with the same key and arguments returns the first result without applying it again; the same key with different arguments is refused.",
  refused:
    "Safe to retry: once it has happened, repeating it is refused rather than applied twice.",
  deduplicated:
    "Safe to retry: the domain keeps a single result, so repeating it returns that result.",
  absolute:
    "Sets an absolute value; repeating it writes the same value again and succeeds (no idempotencyKey)."
};

const uuid: JsonSchema = { type: "string", format: "uuid" };
const grams = (description: string): JsonSchema => ({
  type: "string",
  pattern: "^(0|[1-9][0-9]*)$",
  description: `${description} Whole grams as a decimal string, e.g. "6000000" for 6,000 kg.`
});
const reason: JsonSchema = { type: "string", minLength: 1, maxLength: 240 };
const text = (maxLength: number): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const lineString: JsonSchema = {
  type: "object",
  description:
    "GeoJSON LineString of the road, origin first. Coordinates are [longitude, latitude]. The server validates it and computes its length.",
  required: ["type", "coordinates"],
  properties: {
    type: { const: "LineString" },
    coordinates: {
      type: "array",
      minItems: 2,
      maxItems: 5000,
      items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } }
    }
  }
};
const policyProperties: Record<string, JsonSchema> = {
  name: text(80),
  targetLoadGrams: grams("Pooled load at which a corridor becomes DISPATCH_READY."),
  minimumDispatchLoadGrams: {
    ...grams("Optional economical minimum; null disables it."),
    type: ["string", "null"]
  },
  maxDiversionMeters: { type: "integer", minimum: 1, maximum: 1_000_000 },
  cutoffLocalTime: {
    type: "string",
    pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
    description: "Business-local HH:MM (24h), interpreted in the business timezone."
  },
  maxWaitHours: { type: "integer", minimum: 1, maximum: 8760 },
  fulfillmentLeadDays: { type: "integer", minimum: 0, maximum: 60 },
  underThresholdFallback: {
    type: "array",
    uniqueItems: true,
    items: { enum: ["TRY_SMALLER_VEHICLE", "TRY_COMPATIBLE_CORRIDOR", "REQUIRE_DISPATCH_APPROVAL"] }
  },
  overflowStrategy: { enum: ["NEXT_MANIFEST"] }
};
const expectedDefaultPolicyId: JsonSchema = {
  type: ["string", "null"],
  format: "uuid",
  description:
    "The business default policy you based this on (null if there was none). If the default changed since, refused (409) instead of replacing it."
};
const policyRequired = [
  "name",
  "targetLoadGrams",
  "maxDiversionMeters",
  "cutoffLocalTime",
  "maxWaitHours",
  "fulfillmentLeadDays"
];
const corridorProperties: Record<string, JsonSchema> = {
  name: text(80),
  originLabel: text(120),
  destinationLabel: text(120),
  priority: {
    type: "integer",
    minimum: 0,
    maximum: 1_000_000,
    description: "Lower wins a diversion tie. Default 100."
  },
  policyOverrideId: { type: ["string", "null"], format: "uuid" },
  active: { type: "boolean" }
};

const id = (args: Record<string, unknown>, field: string) => parseString(args[field], field);

export const fulfillmentMcpTools: readonly FulfillmentMcpTool[] = [
  // ---- Setup: timezone, dispatch policy, vehicles (owner) -------------------------------------
  {
    name: "fulfillment.get_settings",
    description: "Read the business's fulfillment settings (its IANA timezone, or null if unset).",
    scope: "mcp:read",
    properties: {},
    required: [],
    run: ({ store, businessId }) => store.getFulfillmentSettings({ sessionId: null, businessId })
  },
  {
    name: "fulfillment.update_settings",
    description:
      "Set the business's IANA timezone (e.g. Africa/Nairobi). Cutoff and next-day delivery are computed in it. Owner only.",
    scope: "mcp:act",
    retry: "absolute",
    properties: {
      timezone: { type: ["string", "null"], minLength: 1, maxLength: 64 },
      expectedTimezone: {
        type: ["string", "null"],
        description:
          "The timezone you saw; if it changed since, the update is refused (409) instead of overwriting it."
      }
    },
    required: ["timezone"],
    run: ({ store, businessId, args }) =>
      store.updateBusinessTimezone({
        sessionId: null,
        businessId,
        timezone: parseNullableString(args.timezone),
        ...(args.expectedTimezone === undefined
          ? {}
          : { expectedTimezone: parseNullableString(args.expectedTimezone) })
      })
  },
  {
    name: "fulfillment.list_policies",
    description: "List the business's dispatch policies (active versions, or full history).",
    scope: "mcp:read",
    properties: { includeHistory: { type: "boolean" } },
    required: [],
    run: ({ service, args }, actor) =>
      service.listDispatchPolicies({
        ...actor,
        includeHistory: parseOptionalBoolean(args.includeHistory, "includeHistory", false)
      })
  },
  {
    name: "fulfillment.get_default_policy",
    description: "Read the business default dispatch policy that corridors use unless overridden.",
    scope: "mcp:read",
    properties: {},
    required: [],
    run: ({ service }, actor) => service.getEffectiveDefaultPolicy(actor)
  },
  {
    name: "fulfillment.create_policy",
    description:
      "Create a dispatch policy (target load, cutoff, max wait, diversion tolerance). Pass makeBusinessDefault to make it the default. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: {
      ...policyProperties,
      makeBusinessDefault: { type: "boolean" },
      expectedDefaultPolicyId
    },
    required: policyRequired,
    run: ({ service, args }, actor) =>
      service.createDispatchPolicy({
        ...actor,
        policy: parsePolicyBody(args),
        ...parseExpectedDefault(args),
        makeBusinessDefault: parseOptionalBoolean(
          args.makeBusinessDefault,
          "makeBusinessDefault",
          false
        )
      })
  },
  {
    name: "fulfillment.revise_policy",
    description:
      "Append a new version of a dispatch policy. Manifests keep the version they were planned under. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: {
      policyId: uuid,
      ...policyProperties,
      expectedDefaultPolicyId,
      expectedVersion: {
        type: "integer",
        minimum: 1,
        description:
          "The version you based this on; if the rules changed since, the revision is refused (409) instead of overwriting them."
      }
    },
    required: ["policyId", ...policyRequired],
    run: ({ service, args }, actor) =>
      service.reviseDispatchPolicy({
        ...actor,
        policyId: id(args, "policyId"),
        ...parsePolicyRevisionBody(args)
      })
  },
  {
    name: "fulfillment.set_default_policy",
    description: "Make an existing dispatch policy the business default. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: { policyId: uuid },
    required: ["policyId"],
    run: ({ service, args }, actor) =>
      service.setDefaultDispatchPolicy({ ...actor, policyId: id(args, "policyId") })
  },
  {
    name: "fulfillment.list_vehicles",
    description: "List the business's vehicles with their capacity in grams.",
    scope: "mcp:read",
    properties: { includeInactive: { type: "boolean" } },
    required: [],
    run: ({ service, args }, actor) =>
      service.listVehicles({
        ...actor,
        includeInactive: parseOptionalBoolean(args.includeInactive, "includeInactive", false)
      })
  },
  {
    name: "fulfillment.create_vehicle",
    description: "Add a vehicle with its load capacity. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: {
      name: text(80),
      registration: { type: ["string", "null"], maxLength: 32 },
      capacityGrams: grams("Maximum load."),
      active: { type: "boolean" }
    },
    required: ["name", "capacityGrams"],
    run: ({ service, args }, actor) =>
      service.createVehicle({ ...actor, vehicle: parseVehicleBody(args) })
  },
  {
    name: "fulfillment.update_vehicle",
    description: "Rename, re-register, change capacity of, or deactivate a vehicle. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: {
      vehicleId: uuid,
      name: text(80),
      registration: { type: ["string", "null"], maxLength: 32 },
      capacityGrams: grams("Maximum load."),
      active: { type: "boolean" }
    },
    required: ["vehicleId"],
    run: ({ service, args }, actor) =>
      service.updateVehicle({
        ...actor,
        vehicleId: id(args, "vehicleId"),
        patch: parseVehiclePatch(args)
      })
  },

  // ---- Corridors and shop locations ------------------------------------------------------------
  {
    name: "fulfillment.list_corridors",
    description: "List the business's delivery corridors (established roads).",
    scope: "mcp:read",
    properties: { includeInactive: { type: "boolean" } },
    required: [],
    run: ({ service, args }, actor) =>
      service.listCorridors({
        ...actor,
        includeInactive: parseOptionalBoolean(args.includeInactive, "includeInactive", false)
      })
  },
  {
    name: "fulfillment.get_corridor",
    description: "Read one corridor with its route geometry, length and geometry version.",
    scope: "mcp:read",
    properties: { corridorId: uuid },
    required: ["corridorId"],
    run: ({ service, args }, actor) =>
      service.getCorridor({ ...actor, corridorId: id(args, "corridorId") })
  },
  {
    name: "fulfillment.list_corridor_geometry_versions",
    description: "List every historical route geometry of a corridor.",
    scope: "mcp:read",
    properties: { corridorId: uuid },
    required: ["corridorId"],
    run: ({ service, args }, actor) =>
      service.listCorridorGeometryVersions({ ...actor, corridorId: id(args, "corridorId") })
  },
  {
    name: "fulfillment.create_corridor",
    description: "Create a delivery corridor from a road polyline. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: { ...corridorProperties, routeGeometry: lineString },
    required: ["name", "originLabel", "destinationLabel", "routeGeometry"],
    run: ({ service, args }, actor) =>
      service.createCorridor({ ...actor, corridor: parseCorridorBody(args) })
  },
  {
    name: "fulfillment.update_corridor",
    description:
      "Change a corridor's name, labels, priority, policy override or active flag. Use update_corridor_geometry for the route. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: { corridorId: uuid, ...corridorProperties },
    required: ["corridorId"],
    run: ({ service, args }, actor) =>
      service.updateCorridor({
        ...actor,
        corridorId: id(args, "corridorId"),
        patch: parseCorridorPatch(
          Object.fromEntries(Object.entries(args).filter(([key]) => key !== "corridorId"))
        )
      })
  },
  {
    name: "fulfillment.update_corridor_geometry",
    description:
      "Replace a corridor's route. Creates a new geometry version; pooled orders resolved against the old one become stale until re-resolved. Owner only.",
    scope: "mcp:act",
    retry: "replay",
    properties: { corridorId: uuid, routeGeometry: lineString },
    required: ["corridorId", "routeGeometry"],
    run: ({ service, args }, actor) =>
      service.updateCorridorGeometry({
        ...actor,
        corridorId: id(args, "corridorId"),
        routeGeometry: args.routeGeometry
      })
  },
  {
    name: "fulfillment.get_shop_location",
    description:
      "Read a shop's current delivery point. Precise coordinates are returned only to roles allowed to see them.",
    scope: "mcp:read",
    properties: { customerId: uuid },
    required: ["customerId"],
    run: ({ service, args }, actor) =>
      service.getShopLocation({ ...actor, customerId: id(args, "customerId") })
  },
  {
    name: "fulfillment.list_shop_location_history",
    description: "List every delivery point captured for a shop, newest first.",
    scope: "mcp:read",
    properties: { customerId: uuid },
    required: ["customerId"],
    run: ({ service, args }, actor) =>
      service.listShopLocationHistory({ ...actor, customerId: id(args, "customerId") })
  },
  {
    name: "fulfillment.capture_shop_location",
    description: "Record a shop's GPS delivery point. The previous point is kept in history.",
    scope: "mcp:act",
    retry: "replay",
    properties: {
      customerId: uuid,
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 },
      accuracyMeters: { type: ["number", "null"], minimum: 0 }
    },
    required: ["customerId", "latitude", "longitude"],
    run: ({ service, args }, actor) =>
      service.captureShopLocation({
        ...actor,
        customerId: id(args, "customerId"),
        location: parseShopLocationBody(args)
      })
  },
  {
    name: "fulfillment.match_shop_corridor",
    description:
      "Compute which corridor a shop's delivery point falls on, with alternatives. Read-only; nothing is persisted.",
    scope: "mcp:read",
    properties: { customerId: uuid },
    required: ["customerId"],
    run: ({ service, args }, actor) =>
      service.resolveCorridorForShop({ ...actor, customerId: id(args, "customerId") })
  },

  // ---- Orders ----------------------------------------------------------------------------------
  {
    name: "fulfillment.get_order_weight",
    description:
      "Authoritative fulfillment weight of an order: RESOLVED with total grams, or UNRESOLVED with the lines missing weight.",
    scope: "mcp:read",
    properties: { invoiceId: uuid },
    required: ["invoiceId"],
    run: ({ store, businessId, args }) =>
      store.getOrderFulfillmentWeight({
        sessionId: null,
        businessId,
        invoiceId: id(args, "invoiceId")
      })
  },
  {
    name: "fulfillment.get_order",
    description: "Read an order's fulfillment state: pool, corridor, manifest and delivery status.",
    scope: "mcp:read",
    properties: { invoiceId: uuid },
    required: ["invoiceId"],
    run: ({ service, args }, actor) =>
      service.getOrderFulfillment({ ...actor, invoiceId: id(args, "invoiceId") })
  },
  {
    name: "fulfillment.get_order_resolution",
    description:
      "Read an order's current corridor resolution, its provenance, and whether it is stale.",
    scope: "mcp:read",
    properties: { invoiceId: uuid },
    required: ["invoiceId"],
    run: ({ service, args }, actor) =>
      service.getResolutionStatus({ ...actor, invoiceId: id(args, "invoiceId") })
  },
  {
    name: "fulfillment.resolve_order_corridor",
    description:
      "Re-resolve an order's corridor from its shop's current location. Appends a provenance record; clears staleness.",
    scope: "mcp:act",
    retry: "replay",
    properties: { invoiceId: uuid },
    required: ["invoiceId"],
    run: ({ service, args }, actor) =>
      service.resolveCorridorForOrder({ ...actor, invoiceId: id(args, "invoiceId") })
  },
  {
    name: "fulfillment.assign_order_corridor",
    description:
      "Manually assign an order to one of its qualifying corridor alternatives. Off-corridor assignment is refused.",
    scope: "mcp:act",
    retry: "replay",
    properties: { invoiceId: uuid, corridorId: uuid },
    required: ["invoiceId", "corridorId"],
    run: ({ service, args }, actor) =>
      service.assignCorridorManually({
        ...actor,
        invoiceId: id(args, "invoiceId"),
        corridorId: id(args, "corridorId")
      })
  },
  {
    name: "fulfillment.intake_order",
    description:
      "Take a confirmed order into fulfillment (weight snapshot and corridor resolution) if intake did not run.",
    scope: "mcp:act",
    retry: "deduplicated",
    properties: { invoiceId: uuid },
    required: ["invoiceId"],
    run: ({ service, args }, actor) =>
      service.intakeOrderForDispatcher({ ...actor, invoiceId: id(args, "invoiceId") })
  },
  {
    name: "fulfillment.cancel_order",
    description:
      "Cancel an order's fulfillment. Before a manifest it leaves the pool; on an open manifest its stop is released.",
    scope: "mcp:act",
    retry: "refused",
    destructive: true,
    properties: { invoiceId: uuid, reason: { ...reason, type: ["string", "null"] } },
    required: ["invoiceId"],
    run: ({ service, args }, actor) =>
      service.cancelOrderFulfillment({
        ...actor,
        invoiceId: id(args, "invoiceId"),
        reason: parseNullableString(args.reason)
      })
  },

  // ---- Pools, dispatch, manifests, delivery ----------------------------------------------------
  {
    name: "fulfillment.list_pools",
    description:
      "Every active corridor pool with pooled grams, target, readiness and resolution counts, plus orders not on any corridor.",
    scope: "mcp:read",
    properties: {},
    required: [],
    run: ({ service }, actor) => service.getActivePools(actor)
  },
  {
    name: "fulfillment.get_corridor_load",
    description:
      "Return the authoritative pooled load, readiness and orders for one delivery corridor.",
    scope: "mcp:read",
    properties: { corridorId: uuid },
    required: ["corridorId"],
    run: ({ service, args }, actor) =>
      service.getCorridorPool({ ...actor, corridorId: id(args, "corridorId") })
  },
  {
    name: "fulfillment.evaluate_dispatch",
    description: "Idempotently evaluate dispatch policy for one corridor and business-local day.",
    scope: "mcp:act",
    retry: "deduplicated",
    properties: { corridorId: uuid },
    required: ["corridorId"],
    run: ({ service, args }, actor) =>
      service.evaluateDispatch({ ...actor, corridorId: id(args, "corridorId") })
  },
  {
    name: "fulfillment.list_dispatch_approvals",
    description: "List dispatch approvals raised by policy evaluation.",
    scope: "mcp:read",
    properties: { status: { enum: [...approvalStatuses] } },
    required: [],
    run: ({ service, args }, actor) => {
      const status = parseApprovalStatus(args.status);
      return service.listDispatchApprovals({
        ...actor,
        ...(status === undefined ? {} : { status })
      });
    }
  },
  {
    name: "fulfillment.decide_dispatch_approval",
    description: "Approve, defer or reject an open dispatch approval, with a reason.",
    scope: "mcp:act",
    retry: "refused",
    properties: { approvalId: uuid, decision: { enum: [...approvalDecisions] }, reason },
    required: ["approvalId", "decision", "reason"],
    run: ({ service, args }, actor) =>
      service.decideDispatchApproval({
        ...actor,
        approvalId: id(args, "approvalId"),
        ...parseApprovalDecisionBody(args)
      })
  },
  {
    name: "fulfillment.list_manifests",
    description: "List delivery manifests, optionally by status.",
    scope: "mcp:read",
    properties: { status: { enum: [...manifestStatuses] } },
    required: [],
    run: ({ service, args }, actor) => {
      const status = parseManifestStatus(args.status);
      return service.listManifests({ ...actor, ...(status === undefined ? {} : { status }) });
    }
  },
  {
    name: "fulfillment.get_manifest",
    description: "Read one manifest with its ordered stops, snapshots and delivery status.",
    scope: "mcp:read",
    properties: { manifestId: uuid },
    required: ["manifestId"],
    run: ({ service, args }, actor) =>
      service.getManifest({ ...actor, manifestId: id(args, "manifestId") })
  },
  {
    name: "fulfillment.create_manifest",
    description:
      "Plan a delivery trip on a corridor with a chosen vehicle. Without orderIds the oldest pooled orders that fit are taken (the rest stay pooled); with orderIds the selection is all-or-nothing. Never exceeds vehicle capacity.",
    scope: "mcp:act",
    retry: "replay",
    properties: {
      corridorId: uuid,
      vehicleId: uuid,
      orderIds: { type: "array", items: uuid, minItems: 1 },
      plannedDepartureAt: { type: ["string", "null"], format: "date-time" }
    },
    required: ["corridorId", "vehicleId"],
    run: ({ service, args }, actor) =>
      service.createManifest({ ...actor, ...parseManifestBody(args) })
  },
  {
    name: "fulfillment.remove_order_from_manifest",
    description: "Return one order from an OPEN manifest to its corridor pool.",
    scope: "mcp:act",
    retry: "refused",
    destructive: true,
    properties: { manifestId: uuid, invoiceId: uuid },
    required: ["manifestId", "invoiceId"],
    run: ({ service, args }, actor) =>
      service.removeOrderFromManifest({
        ...actor,
        manifestId: id(args, "manifestId"),
        invoiceId: id(args, "invoiceId")
      })
  },
  {
    name: "fulfillment.close_manifest",
    description: "Close an OPEN manifest so its load is frozen for loading.",
    scope: "mcp:act",
    retry: "refused",
    properties: { manifestId: uuid },
    required: ["manifestId"],
    run: ({ service, args }, actor) =>
      service.closeManifest({ ...actor, manifestId: id(args, "manifestId") })
  },
  {
    name: "fulfillment.depart_manifest",
    description: "Mark a CLOSED manifest as departed. A person decides this; readiness never does.",
    scope: "mcp:act",
    retry: "refused",
    properties: { manifestId: uuid },
    required: ["manifestId"],
    run: ({ service, args }, actor) =>
      service.departManifest({ ...actor, manifestId: id(args, "manifestId") })
  },
  {
    name: "fulfillment.assign_manifest_driver",
    description:
      "Assign a manifest to a member who can record deliveries (a driver, manager or the owner), or unassign it with null. A driver then sees and works only their own manifests.",
    scope: "mcp:act",
    retry: "replay",
    properties: { manifestId: uuid, driverUserId: { type: ["string", "null"], minLength: 1 } },
    required: ["manifestId", "driverUserId"],
    run: ({ service, args }, actor) =>
      service.assignManifestDriver({
        ...actor,
        manifestId: id(args, "manifestId"),
        ...parseDriverBody(args)
      })
  },
  {
    name: "fulfillment.list_my_manifests",
    description:
      "The calling member's own assigned trips that are open, closed or on the road, with ordered stops.",
    scope: "mcp:read",
    properties: {},
    required: [],
    run: ({ service }, actor) => service.listMyManifests(actor)
  },
  {
    name: "fulfillment.list_assignable_drivers",
    description: "Members of the business a manifest can be assigned to.",
    scope: "mcp:read",
    properties: {},
    required: [],
    run: ({ service }, actor) => service.listAssignableDrivers(actor)
  },
  {
    name: "fulfillment.cancel_manifest",
    description:
      "Cancel an OPEN or CLOSED manifest. Its orders return to their pools with their original age and the vehicle is released.",
    scope: "mcp:act",
    retry: "refused",
    destructive: true,
    properties: { manifestId: uuid, reason },
    required: ["manifestId", "reason"],
    run: ({ service, args }, actor) =>
      service.cancelManifest({
        ...actor,
        manifestId: id(args, "manifestId"),
        reason: parseString(args.reason, "reason")
      })
  },
  {
    name: "fulfillment.record_delivery",
    description:
      "Record a stop outcome on a CLOSED or DEPARTED manifest. FAILED and SKIPPED need a note.",
    scope: "mcp:act",
    retry: "refused",
    properties: {
      manifestId: uuid,
      stopId: uuid,
      outcome: { enum: [...deliveryOutcomes] },
      note: { type: ["string", "null"], maxLength: 240 }
    },
    required: ["manifestId", "stopId", "outcome"],
    run: ({ service, args }, actor) =>
      service.recordDelivery({
        ...actor,
        manifestId: id(args, "manifestId"),
        stopId: id(args, "stopId"),
        ...parseDeliveryBody(args)
      })
  }
];

const toolsByName = new Map(fulfillmentMcpTools.map((tool) => [tool.name, tool]));

export function findFulfillmentMcpTool(name: string): FulfillmentMcpTool | undefined {
  return toolsByName.get(name);
}

/**
 * The MCP `tools/list` descriptor: `shopId` always; on mutations an `idempotencyKey`, required
 * where the tool replays from an idempotency record, and the tool's true retry behaviour appended
 * to its description.
 */
export function describeFulfillmentMcpTool(
  tool: FulfillmentMcpTool,
  securitySchemes: unknown
): Record<string, unknown> {
  const mutation = tool.scope === "mcp:act";
  const keyRequired = tool.retry === "replay";
  return {
    name: tool.name,
    description:
      mutation && tool.retry !== undefined
        ? `${tool.description} ${retryContracts[tool.retry]}`
        : tool.description,
    securitySchemes,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["shopId", ...tool.required, ...(keyRequired ? ["idempotencyKey"] : [])],
      properties: {
        shopId: uuid,
        ...tool.properties,
        ...(mutation && tool.retry !== "absolute"
          ? { idempotencyKey: { type: "string", minLength: 1, maxLength: 200 } }
          : {})
      }
    },
    annotations: {
      readOnlyHint: !mutation,
      destructiveHint: tool.destructive === true,
      // Every mutation here is safe to repeat with the same arguments: replayed, refused,
      // deduplicated, or (absolute) writing the same value again.
      idempotentHint: mutation,
      openWorldHint: false
    }
  };
}

/**
 * Runs one tool for an already scope-checked principal. `additionalProperties: false` is enforced
 * here too, so a misspelled field fails loudly instead of being silently ignored.
 */
export function runFulfillmentMcpTool(
  tool: FulfillmentMcpTool,
  context: FulfillmentToolContext
): unknown {
  const mutation = tool.scope === "mcp:act";
  const allowed = new Set([
    "shopId",
    // An absolute write has no use for a key; refusing one says so instead of ignoring it.
    ...(mutation && tool.retry !== "absolute" ? ["idempotencyKey"] : []),
    ...Object.keys(tool.properties)
  ]);
  const unknown = Object.keys(context.args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Cp2Error(400, "mcp_input_invalid", `Unknown argument(s): ${unknown.join(", ")}.`);
  }
  const actor: FulfillmentActor = {
    sessionId: null,
    businessId: context.businessId,
    idempotencyKey:
      tool.retry === "replay"
        ? parseString(context.args.idempotencyKey, "idempotencyKey")
        : mutation
          ? parseNullableString(context.args.idempotencyKey)
          : null
  };
  return tool.run(context, actor);
}
