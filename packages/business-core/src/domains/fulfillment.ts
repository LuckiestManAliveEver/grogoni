/**
 * Pure, deterministic fulfillment rules (docs/architecture/corridor-fulfillment.md). No I/O, no
 * clock, no framework: the API's FulfillmentService and SalesDomain call these, and so does any
 * test, so there is exactly one interpretation of weight, policy validity and coordinates.
 *
 * Weight is exact: integer grams as `bigint`, never binary floating point. Invoice quantities are
 * JS numbers that may be fractional (for example 2.5 bags), so a line weight is computed from the
 * quantity's exact decimal representation; if the product is not a whole number of grams the line
 * is UNRESOLVED (NON_INTEGRAL_WEIGHT) rather than rounded (Phase 0 decision D6).
 */
import {
  formatGrams,
  parseGrams,
  type DispatchFallbackAction,
  type DispatchOverflowStrategy,
  type GramsString,
  type InvoiceItemSummary,
  type WeightStatus,
  type WeightUnresolvedReason
} from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

export type LineWeightResult =
  | { status: "RESOLVED"; totalWeightGrams: bigint }
  | { status: "UNRESOLVED"; reason: WeightUnresolvedReason };

export type OrderFulfillmentWeight =
  | { status: "RESOLVED"; totalWeightGrams: bigint }
  | {
      status: "UNRESOLVED";
      unresolvedLineIds: string[];
      unresolvedLines: Array<{ lineId: string; reason: WeightUnresolvedReason }>;
    };

/**
 * Exact decimal form of a finite, non-negative JS number as `digits / 10^scale`. Uses the
 * number's shortest round-trip representation (what `String(n)` prints), including exponent form,
 * so `2.5` is exactly 25/10 and `0.1` is exactly 1/10 - not the binary approximation.
 */
export function exactDecimal(value: number): { digits: bigint; scale: number } | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const text = String(value).toLowerCase();
  const [mantissa = "", exponentText] = text.split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole = "", fraction = ""] = mantissa.split(".");
  let digits = BigInt(`${whole}${fraction}` || "0");
  let scale = fraction.length - exponent;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { digits, scale };
}

/** `quantity x unitWeightGrams` in exact integer grams, or the reason it has no weight. */
export function calculateLineWeight(
  unitWeightGrams: bigint | null,
  quantity: number
): LineWeightResult {
  if (unitWeightGrams === null) {
    return { status: "UNRESOLVED", reason: "MISSING_UNIT_WEIGHT" };
  }
  const decimal = exactDecimal(quantity);
  if (decimal === null) {
    return { status: "UNRESOLVED", reason: "NON_INTEGRAL_WEIGHT" };
  }
  const numerator = decimal.digits * unitWeightGrams;
  const denominator = 10n ** BigInt(decimal.scale);
  if (numerator % denominator !== 0n) {
    return { status: "UNRESOLVED", reason: "NON_INTEGRAL_WEIGHT" };
  }
  return { status: "RESOLVED", totalWeightGrams: numerator / denominator };
}

export interface InvoiceLineWeightSnapshot {
  unitWeightGramsSnapshot: GramsString | null;
  totalWeightGrams: GramsString | null;
  weightStatus: WeightStatus;
  weightUnresolvedReason: WeightUnresolvedReason | null;
}

/**
 * The snapshot a line receives at invoice confirmation (A4), from the product's weight at that
 * instant. Stored on the line; never recomputed from the live catalogue afterward.
 */
export function snapshotInvoiceLineWeight(
  productUnitWeightGrams: GramsString | null | undefined,
  quantity: number
): InvoiceLineWeightSnapshot {
  const unitWeight =
    productUnitWeightGrams === null || productUnitWeightGrams === undefined
      ? null
      : parseGrams(productUnitWeightGrams, "unitWeightGrams");
  const result = calculateLineWeight(unitWeight, quantity);
  return result.status === "RESOLVED"
    ? {
        unitWeightGramsSnapshot: formatGrams(unitWeight as bigint),
        totalWeightGrams: formatGrams(result.totalWeightGrams),
        weightStatus: "RESOLVED",
        weightUnresolvedReason: null
      }
    : {
        unitWeightGramsSnapshot: unitWeight === null ? null : formatGrams(unitWeight),
        totalWeightGrams: null,
        weightStatus: "UNRESOLVED",
        weightUnresolvedReason: result.reason
      };
}

type WeightedLine = Pick<InvoiceItemSummary, "id"> &
  Partial<Pick<InvoiceItemSummary, "totalWeightGrams" | "weightStatus" | "weightUnresolvedReason">>;

/**
 * THE canonical order fulfillment weight (A5). Derived only from the order's line snapshots. Any
 * line without a resolved snapshot makes the whole order UNRESOLVED - an unknown line is never
 * counted as zero. Pooling, manifests, API responses and runtime tools must all call this rather
 * than summing lines themselves.
 */
export function calculateOrderFulfillmentWeight(order: {
  items: readonly WeightedLine[];
}): OrderFulfillmentWeight {
  let total = 0n;
  const unresolvedLines: Array<{ lineId: string; reason: WeightUnresolvedReason }> = [];
  for (const line of order.items) {
    if (line.weightStatus === "RESOLVED" && typeof line.totalWeightGrams === "string") {
      total += parseGrams(line.totalWeightGrams, "totalWeightGrams");
      continue;
    }
    unresolvedLines.push({
      lineId: line.id,
      reason:
        line.weightStatus === "UNRESOLVED"
          ? (line.weightUnresolvedReason ?? "MISSING_UNIT_WEIGHT")
          : "NOT_SNAPSHOTTED"
    });
  }
  if (order.items.length > 0 && unresolvedLines.length === 0) {
    return { status: "RESOLVED", totalWeightGrams: total };
  }
  return {
    status: "UNRESOLVED",
    unresolvedLineIds: unresolvedLines.map((line) => line.lineId),
    unresolvedLines
  };
}

// ---------------------------------------------------------------------------------------------
// Coordinates, timezone, local time
// ---------------------------------------------------------------------------------------------

export function validateCoordinates(input: {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
}): ValidationResult {
  const errors: string[] = [];
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) {
    errors.push("Latitude must be between -90 and 90.");
  }
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) {
    errors.push("Longitude must be between -180 and 180.");
  }
  if (
    input.accuracyMeters !== null &&
    input.accuracyMeters !== undefined &&
    (!Number.isFinite(input.accuracyMeters) ||
      input.accuracyMeters < 0 ||
      input.accuracyMeters > 100_000)
  ) {
    errors.push("Location accuracy must be between 0 and 100000 metres.");
  }
  return errors.length > 0 ? invalid(...errors) : valid();
}

/** True for any IANA zone the runtime's ICU data knows (for example `Africa/Nairobi`). */
export function isValidIanaTimeZone(value: string): boolean {
  if (value.trim() !== value || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const localTimePattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u;

export function isValidLocalTime(value: string): boolean {
  return localTimePattern.test(value);
}

// ---------------------------------------------------------------------------------------------
// Vehicles and dispatch policies
// ---------------------------------------------------------------------------------------------

export interface VehicleInput {
  name: string;
  registration?: string | null;
  capacityGrams: bigint;
  active?: boolean;
}

export function validateVehicleInput(input: VehicleInput): ValidationResult {
  const errors: string[] = [];
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    errors.push("Vehicle name must be between 1 and 80 characters.");
  }
  if ((input.registration ?? "").trim().length > 32) {
    errors.push("Vehicle registration must be 32 characters or fewer.");
  }
  if (input.capacityGrams <= 0n) {
    errors.push("Vehicle capacity must be greater than zero grams.");
  }
  return errors.length > 0 ? invalid(...errors) : valid();
}

export const dispatchFallbackActions: readonly DispatchFallbackAction[] = [
  "TRY_SMALLER_VEHICLE",
  "TRY_COMPATIBLE_CORRIDOR",
  "REQUIRE_DISPATCH_APPROVAL"
];

export const dispatchOverflowStrategies: readonly DispatchOverflowStrategy[] = ["NEXT_MANIFEST"];

export interface DispatchPolicyInput {
  name: string;
  targetLoadGrams: bigint;
  minimumDispatchLoadGrams: bigint | null;
  maxDiversionMeters: number;
  cutoffLocalTime: string;
  maxWaitHours: number;
  fulfillmentLeadDays: number;
  underThresholdFallback: DispatchFallbackAction[];
  overflowStrategy: DispatchOverflowStrategy;
}

/** A9/A10 policy invariants. The database repeats the gram checks as CHECK constraints. */
export function validateDispatchPolicyInput(input: DispatchPolicyInput): ValidationResult {
  const errors: string[] = [];
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    errors.push("Policy name must be between 1 and 80 characters.");
  }
  if (input.targetLoadGrams <= 0n) {
    errors.push("Target load must be greater than zero grams.");
  }
  if (input.minimumDispatchLoadGrams !== null) {
    if (input.minimumDispatchLoadGrams <= 0n) {
      errors.push("Minimum dispatch load must be greater than zero grams when set.");
    } else if (input.minimumDispatchLoadGrams > input.targetLoadGrams) {
      errors.push("Minimum dispatch load cannot exceed the target load.");
    }
  }
  if (
    !Number.isInteger(input.maxDiversionMeters) ||
    input.maxDiversionMeters <= 0 ||
    input.maxDiversionMeters > 1_000_000
  ) {
    errors.push("Maximum diversion must be a whole number of metres between 1 and 1000000.");
  }
  if (!isValidLocalTime(input.cutoffLocalTime)) {
    errors.push("Cutoff must be a local time in HH:MM (24-hour) format.");
  }
  if (
    !Number.isInteger(input.maxWaitHours) ||
    input.maxWaitHours < 1 ||
    input.maxWaitHours > 8760
  ) {
    errors.push("Maximum wait must be a whole number of hours between 1 and 8760.");
  }
  if (
    !Number.isInteger(input.fulfillmentLeadDays) ||
    input.fulfillmentLeadDays < 0 ||
    input.fulfillmentLeadDays > 60
  ) {
    errors.push("Fulfillment lead time must be a whole number of days between 0 and 60.");
  }
  const seen = new Set<string>();
  for (const action of input.underThresholdFallback) {
    if (!dispatchFallbackActions.includes(action)) {
      errors.push(`Fallback action ${String(action)} is not supported.`);
    } else if (seen.has(action)) {
      errors.push(`Fallback action ${action} is listed more than once.`);
    }
    seen.add(action);
  }
  if (!dispatchOverflowStrategies.includes(input.overflowStrategy)) {
    errors.push("Overflow strategy is not supported.");
  }
  return errors.length > 0 ? invalid(...errors) : valid();
}
