import { useState } from "react";
import type { ShopPresenceStatus } from "./grogoni-application-shared";
import { shopPresenceStatuses, shopSignCopy } from "./shop-sign-copy";
import "./design-d.css";

/**
 * The hanging shop sign (Design D1) for a shop's ShopPresenceStatus. Read-only for customers.
 * With onChange (the owner's own shop), tapping the sign opens the three statuses to choose from -
 * never a blind cycle, because "private" hides the shop from the marketplace. The server still
 * decides: only the owner may change presence (CP2Store.setShopPresence).
 */
export function ShopSign(props: {
  status: ShopPresenceStatus;
  onChange?: (status: ShopPresenceStatus) => void;
  compact?: boolean;
}) {
  const copy = shopSignCopy();
  const [choosing, setChoosing] = useState(false);
  const label = copy.status(copy.meaning[props.status]);
  const className = `shop-sign${props.compact === true ? " compact" : ""}`;
  // key={status} remounts the plate so its flip animation plays on every change.
  const plate = (
    <span className={`shop-sign-plate ${props.status}`} key={props.status}>
      {copy.plate[props.status]}
    </span>
  );

  if (props.onChange === undefined) {
    return (
      <span className={className} role="img" aria-label={label} title={label}>
        <span className="shop-sign-string" aria-hidden="true" />
        {plate}
      </span>
    );
  }

  const onChange = props.onChange;
  return (
    <span className={`${className} interactive`}>
      <button
        type="button"
        className="shop-sign-button"
        aria-label={`${label}. ${copy.change}`}
        aria-expanded={choosing}
        title={label}
        onClick={() => setChoosing((open) => !open)}
      >
        <span className="shop-sign-string" aria-hidden="true" />
        {plate}
      </button>
      {choosing ? (
        <span
          className="shop-sign-choices"
          role="group"
          aria-label={copy.choose}
          onKeyDown={(event) => {
            if (event.key === "Escape") setChoosing(false);
          }}
        >
          {shopPresenceStatuses.map((status) => (
            <button
              key={status}
              type="button"
              className={`shop-sign-choice ${status}`}
              aria-pressed={status === props.status}
              onClick={() => {
                setChoosing(false);
                if (status !== props.status) onChange(status);
              }}
            >
              <span className={`shop-sign-plate ${status}`}>{copy.plate[status]}</span>
              <small>{copy.meaning[status]}</small>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
