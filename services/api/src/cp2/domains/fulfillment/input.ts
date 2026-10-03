/**
 * Input parsers for the public fulfillment operations, shared by every transport that reaches
 * them: the HTTP routes (routes.ts) and the MCP gateway (mcp/fulfillment-tools.ts). One parser per
 * input shape, so an agent calling a tool and a person pressing a button are validated identically.
 * These only shape and type-check input; the domain rules themselves (policy invariants, geometry,
 * capacity) stay in business-core and the fulfillment service.
 */
import type { DispatchPolicyInput } from "@grogoni/business-core";
import {
  GramsFormatError,
  parseNullableGrams,
  parsePositiveGrams,
  type DispatchApprovalDecision,
  type DispatchFallbackAction,
  type DispatchOverflowStrategy,
  type ManifestStatus
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import {
  parseBoolean,
  parseNonNegativeInteger,
  parseNullableString,
  parseNumber,
  parsePositiveInteger,
  parseString
} from "../../route-helpers.js";
import type { DeliveryOutcome } from "./dispatch.js";
import type { VehiclePatchInput } from "./service.js";

type Body = Record<string, unknown>;

export const manifestStatuses: readonly ManifestStatus[] = [
  "DRAFT",
  "OPEN",
  "CLOSED",
  "DEPARTED",
  "COMPLETED",
  "CANCELLED"
];
export const deliveryOutcomes: readonly DeliveryOutcome[] = [
  "ARRIVED",
  "DELIVERED",
  "FAILED",
  "SKIPPED"
];
export const approvalDecisions: readonly DispatchApprovalDecision[] = [
  "APPROVE",
  "DEFER",
  "REJECT"
];
export const approvalStatuses = ["OPEN", "APPROVED", "DEFERRED", "REJECTED"] as const;

export function parseGramsField(value: unknown, field: string, positive: true): bigint;
export function parseGramsField(value: unknown, field: string, positive: false): bigint | null;
export function parseGramsField(value: unknown, field: string, positive: boolean): bigint | null {
  try {
    return positive ? parsePositiveGrams(value, field) : parseNullableGrams(value, field);
  } catch (error) {
    if (error instanceof GramsFormatError) {
      throw new Cp2Error(400, "grams_invalid", error.message, false, { field });
    }
    throw error;
  }
}

export function parsePolicyBody(body: Body): DispatchPolicyInput {
  const fallback = body.underThresholdFallback ?? [];
  if (!Array.isArray(fallback) || !fallback.every((entry) => typeof entry === "string")) {
    throw new Cp2Error(
      400,
      "fallback_invalid",
      "underThresholdFallback must be an array of fallback action names."
    );
  }
  return {
    name: parseString(body.name, "name"),
    targetLoadGrams: parseGramsField(body.targetLoadGrams, "targetLoadGrams", true),
    minimumDispatchLoadGrams: parseGramsField(
      body.minimumDispatchLoadGrams,
      "minimumDispatchLoadGrams",
      false
    ),
    maxDiversionMeters: parsePositiveInteger(body.maxDiversionMeters, "maxDiversionMeters"),
    cutoffLocalTime: parseString(body.cutoffLocalTime, "cutoffLocalTime"),
    maxWaitHours: parsePositiveInteger(body.maxWaitHours, "maxWaitHours"),
    fulfillmentLeadDays: parseNonNegativeInteger(body.fulfillmentLeadDays, "fulfillmentLeadDays"),
    underThresholdFallback: fallback as DispatchFallbackAction[],
    overflowStrategy: parseString(
      body.overflowStrategy ?? "NEXT_MANIFEST",
      "overflowStrategy"
    ) as DispatchOverflowStrategy
  };
}

/** A revision body: the policy plus the optional optimistic-concurrency `expectedVersion`. */
export function parsePolicyRevisionBody(body: Body) {
  return {
    policy: parsePolicyBody(body),
    ...(body.expectedVersion === undefined || body.expectedVersion === null
      ? {}
      : { expectedVersion: parsePositiveInteger(body.expectedVersion, "expectedVersion") }),
    ...parseExpectedDefault(body)
  };
}

/** Optional `expectedDefaultPolicyId`: absent = no check, null = "no default yet", else an id. */
export function parseExpectedDefault(body: Body): { expectedDefaultPolicyId?: string | null } {
  if (body.expectedDefaultPolicyId === undefined) return {};
  const value = parseNullableString(body.expectedDefaultPolicyId);
  if (value === null) return { expectedDefaultPolicyId: null };
  // A malformed id is a bad request, not a conflict; case differences are the same policy.
  if (!uuidPattern.test(value)) {
    throw new Cp2Error(
      400,
      "expected_default_policy_invalid",
      "expectedDefaultPolicyId must be a policy id (UUID) or null."
    );
  }
  return { expectedDefaultPolicyId: value.toLowerCase() };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseOptionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  return value === undefined ? fallback : parseBoolean(value, field);
}

export function parseVehicleBody(body: Body) {
  return {
    name: parseString(body.name, "name"),
    registration: parseNullableString(body.registration),
    capacityGrams: parseGramsField(body.capacityGrams, "capacityGrams", true),
    active: parseOptionalBoolean(body.active, "active", true)
  };
}

export function parseVehiclePatch(body: Body): VehiclePatchInput {
  return {
    ...(body.name === undefined ? {} : { name: parseString(body.name, "name") }),
    ...(body.registration === undefined
      ? {}
      : { registration: parseNullableString(body.registration) }),
    ...(body.capacityGrams === undefined
      ? {}
      : { capacityGrams: parseGramsField(body.capacityGrams, "capacityGrams", true) }),
    ...(body.active === undefined ? {} : { active: parseBoolean(body.active, "active") })
  };
}

export function parseShopLocationBody(body: Body) {
  return {
    latitude: parseNumber(body.latitude, "latitude"),
    longitude: parseNumber(body.longitude, "longitude"),
    accuracyMeters:
      body.accuracyMeters === undefined || body.accuracyMeters === null
        ? null
        : parseNumber(body.accuracyMeters, "accuracyMeters")
  };
}

export function parseCorridorBody(body: Body) {
  return {
    name: parseString(body.name, "name"),
    originLabel: parseString(body.originLabel, "originLabel"),
    destinationLabel: parseString(body.destinationLabel, "destinationLabel"),
    // Validated (and its length computed) by the pure geometry module, never trusted.
    routeGeometry: body.routeGeometry,
    ...(body.priority === undefined
      ? {}
      : { priority: parseNonNegativeInteger(body.priority, "priority") }),
    ...(body.policyOverrideId === undefined
      ? {}
      : { policyOverrideId: parseNullableString(body.policyOverrideId) }),
    ...(body.active === undefined ? {} : { active: parseBoolean(body.active, "active") })
  };
}

export function parseCorridorPatch(body: Body) {
  if (body.routeGeometry !== undefined) {
    throw new Cp2Error(
      400,
      "corridor_geometry_separate",
      "Change route geometry with PUT .../geometry (MCP: fulfillment.update_corridor_geometry) so it gets a new geometry version."
    );
  }
  return {
    ...(body.name === undefined ? {} : { name: parseString(body.name, "name") }),
    ...(body.originLabel === undefined
      ? {}
      : { originLabel: parseString(body.originLabel, "originLabel") }),
    ...(body.destinationLabel === undefined
      ? {}
      : { destinationLabel: parseString(body.destinationLabel, "destinationLabel") }),
    ...(body.priority === undefined
      ? {}
      : { priority: parseNonNegativeInteger(body.priority, "priority") }),
    ...(body.policyOverrideId === undefined
      ? {}
      : { policyOverrideId: parseNullableString(body.policyOverrideId) }),
    ...(body.active === undefined ? {} : { active: parseBoolean(body.active, "active") })
  };
}

export function parseManifestBody(body: Body) {
  let orderIds: string[] | undefined;
  if (body.orderIds !== undefined && body.orderIds !== null) {
    if (!Array.isArray(body.orderIds) || !body.orderIds.every((id) => typeof id === "string")) {
      throw new Cp2Error(400, "invalid_selection", "orderIds must be an array of order ids.");
    }
    orderIds = body.orderIds as string[];
  }
  return {
    corridorId: parseString(body.corridorId, "corridorId"),
    vehicleId: parseString(body.vehicleId, "vehicleId"),
    ...(orderIds === undefined ? {} : { orderIds }),
    plannedDepartureAt: parseNullableString(body.plannedDepartureAt)
  };
}

/** `{ driverUserId: string | null }`: null unassigns the manifest. */
export function parseDriverBody(body: Body): { driverUserId: string | null } {
  if (!("driverUserId" in body)) {
    throw new Cp2Error(
      400,
      "driverUserId_required",
      "driverUserId is required (null to unassign)."
    );
  }
  return { driverUserId: parseNullableString(body.driverUserId) };
}

export function parseManifestStatus(value: unknown): ManifestStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (!manifestStatuses.includes(value as ManifestStatus)) {
    throw new Cp2Error(400, "manifest_status_invalid", "Manifest status is not supported.");
  }
  return value as ManifestStatus;
}

export function parseApprovalStatus(value: unknown): (typeof approvalStatuses)[number] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!approvalStatuses.includes(value as (typeof approvalStatuses)[number])) {
    throw new Cp2Error(
      400,
      "approval_status_invalid",
      "Approval status must be OPEN, APPROVED, DEFERRED or REJECTED."
    );
  }
  return value as (typeof approvalStatuses)[number];
}

export function parseApprovalDecisionBody(body: Body) {
  const decision = parseString(body.decision, "decision");
  if (!approvalDecisions.includes(decision as DispatchApprovalDecision)) {
    throw new Cp2Error(
      400,
      "approval_decision_invalid",
      "Decision must be APPROVE, DEFER or REJECT."
    );
  }
  return {
    decision: decision as DispatchApprovalDecision,
    reason: parseString(body.reason, "reason")
  };
}

export function parseDeliveryBody(body: Body) {
  const outcome = parseString(body.outcome, "outcome");
  if (!deliveryOutcomes.includes(outcome as DeliveryOutcome)) {
    throw new Cp2Error(400, "delivery_outcome_invalid", "Delivery outcome is not supported.");
  }
  return { outcome: outcome as DeliveryOutcome, note: parseNullableString(body.note) };
}
