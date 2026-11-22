import type { ManifestSummary } from "@grogoni/shared-types";
import { fulfillmentCopy } from "./fulfillment-copy";
import { manifestStopState, manifestTripProgress } from "./fulfillment-route";
import { MatatuIcon } from "./MatatuIcon";
import "./design-d.css";

/**
 * The trip progress strip above a manifest's stops (Design D4): one segment per stop in road
 * order, coloured by its delivery outcome. The count is said in text for assistive technology.
 */
export function ManifestTripStrip(props: { manifest: Pick<ManifestSummary, "stops"> }) {
  const t = fulfillmentCopy();
  const progress = manifestTripProgress(props.manifest);
  if (progress.total === 0) return null;
  const stops = [...props.manifest.stops]
    .filter((stop) => stop.allocationActive)
    .sort((left, right) => left.sequence - right.sequence);
  return (
    <div
      className="manifest-trip-strip"
      role="img"
      aria-label={t.tripProgress(progress.done, progress.total)}
    >
      {stops.map((stop) => (
        <i key={stop.id} data-delivery-status={manifestStopState(stop)} aria-hidden="true" />
      ))}
    </div>
  );
}

/** The stop's pin on the route line; the vehicle sits on the stop it is at. Decorative. */
export function ManifestStopMarker(props: { current: boolean }) {
  return (
    <i className={`manifest-stop-marker${props.current ? " current" : ""}`} aria-hidden="true">
      {props.current ? <MatatuIcon /> : null}
    </i>
  );
}
