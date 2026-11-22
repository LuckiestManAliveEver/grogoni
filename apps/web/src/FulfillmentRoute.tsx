import type { CSSProperties } from "react";
import type { FulfillmentMethod, FulfillmentStatus } from "./grogoni-application-shared";
import { fulfillmentCopy } from "./fulfillment-copy";
import { fulfillmentRoute } from "./fulfillment-route";
import { MatatuIcon } from "./MatatuIcon";
import "./design-d.css";

/**
 * The matatu route for one delivery or pickup (Design D2): received → ready → on the way →
 * delivered, drawn from the record's FulfillmentStatus. Display only; status changes stay with the
 * buttons and selects that already send them.
 */
export function FulfillmentRoute(props: { status: FulfillmentStatus; method: FulfillmentMethod }) {
  const t = fulfillmentCopy();
  const route = fulfillmentRoute(props.status, props.method, t);
  const style = { "--route-position": `${Math.round(route.position * 100)}%` } as CSSProperties;
  return (
    <div
      className={`fulfillment-route${route.cancelled ? " cancelled" : ""}${route.moving ? " moving" : ""}`}
      role="img"
      aria-label={t.routeProgress(route.statusLabel)}
      style={style}
      data-fulfillment-status={props.status}
    >
      <div className="fulfillment-route-road" aria-hidden="true">
        <span className="fulfillment-route-travelled" />
        {route.stops.map((stop, index) => (
          <span
            key={stop.key}
            className={`fulfillment-route-pin${stop.reached ? " reached" : ""}${
              stop.current ? " current" : ""
            }`}
            style={
              {
                "--pin-position": `${route.stops.length === 1 ? 0 : (index / (route.stops.length - 1)) * 100}%`
              } as CSSProperties
            }
          />
        ))}
        <span className="fulfillment-route-vehicle">
          <MatatuIcon />
        </span>
      </div>
      <div className="fulfillment-route-labels" aria-hidden="true">
        {route.stops.map((stop) => (
          <small key={stop.key} className={stop.current ? "current" : undefined}>
            {stop.label}
          </small>
        ))}
      </div>
    </div>
  );
}
