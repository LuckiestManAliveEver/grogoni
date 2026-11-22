import type {
  ManifestStopDeliveryStatus,
  ManifestStopSummary,
  ManifestSummary
} from "@grogoni/shared-types";
import type { FulfillmentMethod, FulfillmentStatus } from "./grogoni-application-shared";
import type { FulfillmentCopy } from "./fulfillment-copy";

// Design D2/D4: pure models behind the matatu route pictures, kept apart from the components so the
// mapping from server status to stops is tested directly. Nothing here guesses at history the
// server does not return: a cancelled delivery shows no progress because LogisticsSummary does not
// say how far it got.

export interface FulfillmentRouteStop {
  key: "received" | "ready" | "onTheWay" | "arrived";
  label: string;
  reached: boolean;
  current: boolean;
}

export interface FulfillmentRouteModel {
  stops: FulfillmentRouteStop[];
  /** 0..1 along the road, where the vehicle is drawn. */
  position: number;
  moving: boolean;
  cancelled: boolean;
  statusLabel: string;
}

const deliveryOrder: Partial<Record<FulfillmentStatus, number>> = {
  pending: 0,
  ready: 1,
  out_for_delivery: 2,
  completed: 3
};

const pickupOrder: Partial<Record<FulfillmentStatus, number>> = {
  pending: 0,
  ready: 1,
  completed: 2
};

export function fulfillmentRoute(
  status: FulfillmentStatus,
  method: FulfillmentMethod,
  copy: Pick<FulfillmentCopy, "routeStop" | "fulfillmentStatus">
): FulfillmentRouteModel {
  const keys: FulfillmentRouteStop["key"][] =
    method === "delivery"
      ? ["received", "ready", "onTheWay", "arrived"]
      : ["received", "ready", "arrived"];
  const labels: Record<FulfillmentRouteStop["key"], string> = {
    received: copy.routeStop.received,
    ready: copy.routeStop.ready,
    onTheWay: copy.routeStop.onTheWay,
    arrived: method === "delivery" ? copy.routeStop.delivered : copy.routeStop.collected
  };
  const cancelled = status === "cancelled";
  // A pickup that is somehow "out_for_delivery" (not a legal transition) is drawn as ready.
  const reachedIndex = cancelled
    ? -1
    : ((method === "delivery" ? deliveryOrder[status] : pickupOrder[status]) ?? 1);
  const stops = keys.map((key, index) => ({
    key,
    label: labels[key],
    reached: index <= reachedIndex,
    current: index === reachedIndex
  }));
  return {
    stops,
    position: reachedIndex <= 0 ? 0 : reachedIndex / (keys.length - 1),
    moving: !cancelled && method === "delivery" && status === "out_for_delivery",
    cancelled,
    statusLabel: copy.fulfillmentStatus[status]
  };
}

/** A stop's state on the manifest route; released stops are no longer on the trip. */
export type ManifestRouteStopState = ManifestStopDeliveryStatus | "RELEASED";

export function manifestStopState(stop: ManifestStopSummary): ManifestRouteStopState {
  return stop.allocationActive ? stop.deliveryStatus : "RELEASED";
}

/**
 * Where the vehicle is on a trip that has left: the stop it has arrived at, else the next stop
 * still waiting. Null before departure and once nothing is left to visit.
 */
export function currentManifestStopId(
  manifest: Pick<ManifestSummary, "status" | "stops">
): string | null {
  if (manifest.status !== "DEPARTED") return null;
  const active = [...manifest.stops]
    .filter((stop) => stop.allocationActive)
    .sort((left, right) => left.sequence - right.sequence);
  const arrived = active.find((stop) => stop.deliveryStatus === "ARRIVED");
  if (arrived !== undefined) return arrived.id;
  return active.find((stop) => stop.deliveryStatus === "PENDING")?.id ?? null;
}

/** Stops with a final outcome, over the stops still on the trip, for the trip progress strip. */
export function manifestTripProgress(manifest: Pick<ManifestSummary, "stops">): {
  done: number;
  total: number;
} {
  const active = manifest.stops.filter((stop) => stop.allocationActive);
  const done = active.filter(
    (stop) =>
      stop.deliveryStatus === "DELIVERED" ||
      stop.deliveryStatus === "FAILED" ||
      stop.deliveryStatus === "SKIPPED"
  ).length;
  return { done, total: active.length };
}
