/**
 * Wire/record shapes for the corridor-fulfillment domain (docs/architecture/
 * corridor-fulfillment.md). Every gram value is a `GramsString` (see ./grams.ts); `bigint` never
 * appears in these types because they cross JSON boundaries.
 */
import type { GramsString } from "./grams.js";

/**
 * Where a canonical order came from (Phase 1c). Descriptive only: no commerce or fulfillment logic
 * may branch on it. When the source is a messaging channel, the invoice also carries the existing
 * `MessageChannel` literal (for example `whatsapp_business`). Historical invoices have no source.
 */
export const orderSources = [
  "FIELD_SALES",
  "RETAIL_SALES",
  "GROGONI_CHAT",
  "WHATSAPP",
  "TELEGRAM",
  "TIKTOK",
  "INSTAGRAM",
  "PHONE",
  "MANUAL",
  "API"
] as const;

export type OrderSource = (typeof orderSources)[number];

export function isOrderSource(value: unknown): value is OrderSource {
  return typeof value === "string" && (orderSources as readonly string[]).includes(value);
}

export type WeightStatus = "RESOLVED" | "UNRESOLVED";

/**
 * Why a line (or an order) has no authoritative weight. Unknown is never zero:
 * - MISSING_UNIT_WEIGHT: the product had no `unitWeightGrams` when the order was confirmed.
 * - NON_INTEGRAL_WEIGHT: quantity x unit weight is not a whole number of grams.
 * - NOT_SNAPSHOTTED: the line was confirmed before weight snapshots existed.
 */
export type WeightUnresolvedReason =
  "MISSING_UNIT_WEIGHT" | "NON_INTEGRAL_WEIGHT" | "NOT_SNAPSHOTTED";

export type OrderFulfillmentWeightSummary =
  | { status: "RESOLVED"; totalWeightGrams: GramsString }
  | {
      status: "UNRESOLVED";
      unresolvedLineIds: string[];
      unresolvedLines: Array<{ lineId: string; reason: WeightUnresolvedReason }>;
    };

export interface VehicleSummary {
  id: string;
  businessId: string;
  name: string;
  registration: string | null;
  capacityGrams: GramsString;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type DispatchFallbackAction =
  "TRY_SMALLER_VEHICLE" | "TRY_COMPATIBLE_CORRIDOR" | "REQUIRE_DISPATCH_APPROVAL";

export type DispatchOverflowStrategy = "NEXT_MANIFEST";

/**
 * One immutable policy version. Editing a policy appends a new version (same `policyId`, higher
 * `version`) and deactivates the previous one, so a manifest that references
 * `(policyId, version)` keeps its original interpretation forever (A9).
 */
export interface DispatchPolicySummary {
  id: string;
  policyId: string;
  businessId: string;
  version: number;
  name: string;
  isBusinessDefault: boolean;
  targetLoadGrams: GramsString;
  minimumDispatchLoadGrams: GramsString | null;
  maxDiversionMeters: number;
  /** Business-local wall-clock time, `HH:MM` (24h). Interpreted in the business timezone. */
  cutoffLocalTime: string;
  maxWaitHours: number;
  fulfillmentLeadDays: number;
  underThresholdFallback: DispatchFallbackAction[];
  overflowStrategy: DispatchOverflowStrategy;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export type ShopLocationStatus = "RESOLVED" | "UNRESOLVED";

/** One captured delivery point for a shop (a business's `CustomerSummary`). Append-only. */
export interface ShopLocationSummary {
  id: string;
  businessId: string;
  customerId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAt: string;
  capturedBy: string;
  supersededAt: string | null;
}

/**
 * A shop's current delivery-point state. `current` carries precise coordinates only for actors
 * holding `shop_location:read_precise`; everyone else sees status and capture metadata with
 * `coordinatesRedacted: true` (A6).
 */
export interface ShopLocationStatusSummary {
  businessId: string;
  customerId: string;
  locationStatus: ShopLocationStatus;
  coordinatesRedacted: boolean;
  current:
    | ShopLocationSummary
    | (Omit<ShopLocationSummary, "latitude" | "longitude" | "accuracyMeters"> & {
        latitude: null;
        longitude: null;
        accuracyMeters: null;
      })
    | null;
}

export interface FulfillmentSettingsSummary {
  businessId: string;
  /** IANA timezone, or null when the business has not configured one yet. */
  timezone: string | null;
  /**
   * Whether this caller may change setup (timezone, dispatch policy, vehicles, corridors): its role
   * holds `fulfillment:manage` (the owner) and, over MCP, its token has `mcp:act`. Server-computed
   * so no client duplicates the role table.
   */
  viewerCanManage: boolean;
}

// ---------------------------------------------------------------------------------------------
// Phase 1b: corridors and resolution provenance (A14-A16)
// ---------------------------------------------------------------------------------------------

export interface CorridorLineString {
  type: "LineString";
  /** `[longitude, latitude]` pairs, origin first. */
  coordinates: Array<[number, number]>;
}

export interface CorridorSummary {
  id: string;
  businessId: string;
  name: string;
  originLabel: string;
  destinationLabel: string;
  origin: { latitude: number; longitude: number };
  destination: { latitude: number; longitude: number };
  routeGeometry: CorridorLineString;
  /** Server-computed route length. A distance, not a physical quantity: metres, 3 decimals. */
  distanceMeters: number;
  geometryVersion: number;
  priority: number;
  /** Policy lineage whose active version overrides the business default for this corridor. */
  policyOverrideId: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorridorGeometryVersionSummary {
  corridorId: string;
  version: number;
  routeGeometry: CorridorLineString;
  distanceMeters: number;
  createdBy: string;
  createdAt: string;
}

export type CorridorUnresolvedReasonCode =
  | "NO_LOCATION"
  | "NO_ACTIVE_CORRIDOR"
  | "NO_DISPATCH_POLICY"
  | "OUTSIDE_TOLERANCE"
  | "INVALID_GEOMETRY";

export type CorridorSelectionReasonCode =
  "ONLY_CANDIDATE" | "SMALLEST_DIVERSION" | "PRIORITY_TIE_BREAK" | "ID_TIE_BREAK";

export interface CorridorMatchSummary {
  corridorId: string;
  corridorName: string;
  geometryVersion: number;
  diversionMeters: number;
  distanceAlongMeters: number;
  segmentIndex: number;
  maxDiversionMeters: number;
}

/** A computed (not persisted) corridor match for a shop's current delivery point. */
export type CorridorMatchResultSummary =
  | {
      status: "RESOLVED";
      shopLocationId: string;
      selected: CorridorMatchSummary;
      alternatives: CorridorMatchSummary[];
      reason: CorridorSelectionReasonCode;
    }
  | {
      status: "UNRESOLVED";
      shopLocationId: string | null;
      reason: CorridorUnresolvedReasonCode;
      nearest: CorridorMatchSummary | null;
    };

export type CorridorResolutionMethod = "AUTO" | "MANUAL";

/** One append-only provenance record: why an order was associated with a corridor (A16). */
export interface CorridorResolutionSummary {
  id: string;
  businessId: string;
  fulfillmentOrderId: string;
  invoiceId: string;
  corridorId: string;
  corridorGeometryVersion: number;
  shopLocationId: string;
  diversionMeters: number;
  distanceAlongMeters: number;
  segmentIndex: number;
  maxDiversionMeters: number;
  resolutionMethod: CorridorResolutionMethod;
  resolvedBy: string;
  resolvedAt: string;
  supersededAt: string | null;
}

export type CorridorResolutionStaleReason = "GEOMETRY_CHANGED" | "LOCATION_CHANGED";

export interface CorridorResolutionStatusSummary {
  businessId: string;
  invoiceId: string;
  resolutionStatus: "RESOLVED" | "UNRESOLVED";
  current: CorridorResolutionSummary | null;
  /** Computed, never repaired silently: a stale order must be re-resolved or confirmed. */
  stale: boolean;
  staleReasons: CorridorResolutionStaleReason[];
  history: CorridorResolutionSummary[];
}

export type ResolveOrderCorridorResultSummary =
  | {
      outcome: "RESOLVED";
      resolution: CorridorResolutionSummary;
      alternatives: CorridorMatchSummary[];
      reason: CorridorSelectionReasonCode | "MANUAL_ASSIGNMENT";
    }
  | {
      outcome: "UNRESOLVED";
      reason: CorridorUnresolvedReasonCode;
      nearest: CorridorMatchSummary | null;
      /** The previous resolution, if any, is left untouched (and may now be stale). */
      current: CorridorResolutionSummary | null;
    };

// ---------------------------------------------------------------------------------------------
// Phase 1c: intake, pools, manifests
// ---------------------------------------------------------------------------------------------

/** What the Postgres-authoritative fulfillment side needs to know about a confirmed order. */
export interface ConfirmedOrderReference {
  invoiceId: string;
  customerId: string | null;
  confirmedAt: string;
  source: OrderSource | null;
  /** A delivery logistics record exists (Phase 0 decision D4). */
  deliveryIntent: boolean;
  /** The canonical A5 weight, computed once from the confirmation-time line snapshots. */
  weight: OrderFulfillmentWeightSummary;
}

export type CorridorPoolReadiness =
  "ACCUMULATING" | "DISPATCHABLE" | "DISPATCH_READY" | "APPROVAL_REQUIRED";

/**
 * A corridor pool, computed from live authoritative state (A13); nothing here is persisted.
 * - `eligibleTotalWeightGrams` includes stale orders (A16: they stay in the pool total).
 * - `allocatableWeightGrams` excludes stale orders; readiness is computed from it (A13: "eligible,
 *   non-stale resolved weight"), because stale orders cannot be allocated until re-resolved.
 * - Unresolved-weight orders count toward no gram total, only toward `unresolvedWeightCount`.
 */
export interface CorridorPoolSummary {
  corridorId: string;
  corridorName: string;
  corridorActive: boolean;
  geometryVersion: number;
  policy: {
    policyId: string;
    version: number;
    cutoffLocalTime: string;
    maxWaitHours: number;
  } | null;
  eligibleOrderCount: number;
  eligibleTotalWeightGrams: GramsString;
  allocatableWeightGrams: GramsString;
  targetLoadGrams: GramsString | null;
  minimumDispatchLoadGrams: GramsString | null;
  percentFilled: number | null;
  oldestWaitingOrderConfirmedAt: string | null;
  oldestWaitingOrderAgeSeconds: number | null;
  nextCutoffAt: string | null;
  timeUntilCutoffSeconds: number | null;
  /** Null when the corridor has no effective dispatch policy. */
  readiness: CorridorPoolReadiness | null;
  needsResolution: boolean;
  unresolvedWeightCount: number;
  unresolvedLocationCount: number;
  staleResolutionCount: number;
  /** Orders heavier than the largest active vehicle (A21 REQUIRES_PLANNING). */
  requiresPlanningCount: number;
}

export interface CorridorPoolOrderSummary {
  invoiceId: string;
  fulfillmentOrderId: string;
  customerId: string | null;
  customerName: string | null;
  confirmedAt: string;
  ageSeconds: number;
  weightStatus: WeightStatus;
  totalWeightGrams: GramsString | null;
  stale: boolean;
  staleReasons: Array<"GEOMETRY_CHANGED" | "LOCATION_CHANGED">;
  distanceAlongMeters: number;
  diversionMeters: number;
  requiresPlanning: boolean;
}

export interface CorridorPoolDetailSummary extends CorridorPoolSummary {
  orders: CorridorPoolOrderSummary[];
}

/** Orders in fulfillment that are on no corridor yet, or not yet taken in. Never hidden. */
export interface UnassignedFulfillmentSummary {
  orderCount: number;
  unresolvedLocationCount: number;
  noCorridorCount: number;
  unresolvedWeightCount: number;
  pendingIntakeCount: number;
  orphanedCount: number;
}

export interface ActivePoolsSummary {
  businessId: string;
  timezone: string | null;
  generatedAt: string;
  pools: CorridorPoolSummary[];
  unassigned: UnassignedFulfillmentSummary;
}

export type ManifestStatus = "DRAFT" | "OPEN" | "CLOSED" | "DEPARTED" | "COMPLETED" | "CANCELLED";

export type ManifestStopDeliveryStatus = "PENDING" | "ARRIVED" | "DELIVERED" | "FAILED" | "SKIPPED";

export type ManifestStopReleaseReason =
  "REMOVED_BY_DISPATCHER" | "ORDER_CANCELLED" | "DELIVERY_FAILED" | "DELIVERY_SKIPPED";

export interface ManifestStopSummary {
  id: string;
  manifestId: string;
  invoiceId: string;
  fulfillmentOrderId: string;
  customerId: string | null;
  customerName: string | null;
  sequence: number;
  distanceAlongMeters: number;
  diversionMeters: number;
  latitude: number;
  longitude: number;
  orderWeightGrams: GramsString;
  items: Array<{
    productName: string;
    quantity: number;
  }>;
  /** Outstanding canonical invoice balance; null when the order is fully paid. */
  payOnDeliveryAmount: number | null;
  allocationActive: boolean;
  deliveryStatus: ManifestStopDeliveryStatus;
  deliveryNote: string | null;
  releaseReason: ManifestStopReleaseReason | null;
  deliveryRecordedAt: string | null;
}

export interface ManifestSummary {
  id: string;
  businessId: string;
  corridorId: string;
  corridorGeometryVersion: number;
  policyId: string;
  policyVersion: number;
  vehicleId: string;
  vehicleCapacityGrams: GramsString;
  status: ManifestStatus;
  /** Weight loaded on the trip: active stops while OPEN, frozen at close. */
  totalWeightGrams: GramsString;
  plannedDepartureAt: string | null;
  closedAt: string | null;
  departedAt: string | null;
  completedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The member this trip is assigned to, or null (dispatchers work it). */
  driverUserId: string | null;
  /** The assigned driver's name; null when unassigned or no longer a member of the business. */
  driverName: string | null;
  stops: ManifestStopSummary[];
}

/** A member of the business who can be assigned a manifest (their role can record deliveries). */
export interface AssignableDriverSummary {
  userId: string;
  displayName: string;
  role: string;
}

export interface CreateManifestResultSummary {
  manifest: ManifestSummary;
  allocatedInvoiceIds: string[];
  /** Fit-able orders left pooled because the vehicle was full (A21 skip-and-continue). */
  skippedInvoiceIds: string[];
  /** Orders heavier than this vehicle (A21 REQUIRES_PLANNING). */
  requiresPlanningInvoiceIds: string[];
}

export type FulfillmentOrderStateCode =
  "POOLED" | "ALLOCATED" | "DELIVERED" | "CANCELLED" | "ORPHANED";

export interface OrderFulfillmentStatusSummary {
  businessId: string;
  invoiceId: string;
  intakeStatus: "NOT_FOR_DELIVERY" | "PENDING_INTAKE" | "TAKEN_IN";
  state: FulfillmentOrderStateCode | null;
  weight: OrderFulfillmentWeightSummary;
  corridor: CorridorResolutionStatusSummary | null;
  allocation: {
    manifestId: string;
    manifestStatus: ManifestStatus;
    stopId: string;
    sequence: number;
    deliveryStatus: ManifestStopDeliveryStatus;
  } | null;
}

// ---------------------------------------------------------------------------------------------
// Phase 2: deterministic policy evaluation and manifest lifecycle
// ---------------------------------------------------------------------------------------------

export type DispatchEvaluationOutcome = "READY" | "WAIT" | "FALLBACK" | "APPROVAL_REQUIRED";

export type DispatchRecommendation =
  | {
      action: "TRY_SMALLER_VEHICLE";
      vehicleId: string;
      capacityGrams: GramsString;
    }
  | {
      action: "TRY_COMPATIBLE_CORRIDOR";
      corridorId: string;
    };

/** Result of the idempotent, clock-injected Phase 2 policy evaluator. */
export interface DispatchEvaluationSummary {
  outcome: DispatchEvaluationOutcome;
  readiness: CorridorPoolReadiness;
  maxWaitReached: boolean;
  recommendation: DispatchRecommendation | null;
  reason:
    | "TARGET_REACHED"
    | "MAX_WAIT_NOT_REACHED"
    | "FALLBACK_RECOMMENDED"
    | "APPROVAL_POLICY"
    | "NO_ACTIONABLE_FALLBACK";
}

export type DispatchApprovalDecision = "APPROVE" | "DEFER" | "REJECT";

export type DispatchApprovalStatus = "OPEN" | "APPROVED" | "DEFERRED" | "REJECTED";

export interface DispatchApprovalSummary {
  id: string;
  businessId: string;
  corridorId: string;
  evaluationId: string;
  policyVersionId: string;
  status: DispatchApprovalStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
