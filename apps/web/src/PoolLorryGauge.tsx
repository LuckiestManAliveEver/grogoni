import type { CSSProperties } from "react";
import type { CorridorPoolReadiness } from "@grogoni/shared-types";
import { fulfillmentCopy } from "./fulfillment-copy";
import "./design-d.css";

/**
 * A corridor pool as a lorry bed filling with crates (Design D3). The native progress element
 * stays the accessible value; the lorry is the picture of it. Readiness colours come from the
 * server's readiness, never from the percentage alone.
 */
export function PoolLorryGauge(props: {
  percentFilled: number;
  readiness: CorridorPoolReadiness | null;
}) {
  const t = fulfillmentCopy();
  const percent = Math.max(0, Math.min(100, props.percentFilled));
  const style = { "--pool-fill": `${percent}%` } as CSSProperties;
  return (
    <div className="pool-lorry" data-readiness={props.readiness ?? "NONE"}>
      <div className="pool-lorry-picture" aria-hidden="true" style={style}>
        <div className="pool-lorry-bed">
          <div className="pool-lorry-load" />
        </div>
        <svg
          className="pool-lorry-cab"
          width="46"
          height="42"
          viewBox="0 0 46 42"
          fill="none"
          focusable="false"
        >
          <path
            d="M2 6h22l12 12v14H2z"
            fill="var(--grogoni-line, #323a48)"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M24 9v10h10" fill="var(--grogoni-paper-dim, #1b202b)" stroke="currentColor" />
          <circle
            cx="12"
            cy="36"
            r="4.5"
            fill="var(--grogoni-paper, #12151c)"
            stroke="currentColor"
          />
          <circle
            cx="32"
            cy="36"
            r="4.5"
            fill="var(--grogoni-paper, #12151c)"
            stroke="currentColor"
          />
        </svg>
      </div>
      <progress
        className="visually-hidden"
        max={100}
        value={percent}
        aria-label={t.poolLoad(percent)}
      >
        {props.percentFilled}%
      </progress>
    </div>
  );
}
