import { useEffect, useState } from "react";
import type { UnifiedCheckoutSummary } from "@grogoni/shared-types";
import { apiFetch } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";

/**
 * Confirms a unified checkout as N contact pickups + M shop orders, each with its own live
 * status, and shows any items that could not be ordered rather than omitting them.
 */
export default function FulfilmentSplitCard(props: { unifiedCheckoutId: string }) {
  const [checkout, setCheckout] = useState<UnifiedCheckoutSummary | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void apiFetch<UnifiedCheckoutSummary>(
      `/buy/checkouts/${encodeURIComponent(props.unifiedCheckoutId)}`
    )
      .then((loaded) => {
        if (!cancelled) setCheckout(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [props.unifiedCheckoutId]);

  if (checkout === null) {
    return (
      <section className="record-form fulfilment-split-card" aria-label="Order">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading order…</p>}
      </section>
    );
  }

  const contactCount = checkout.handoffs.filter((h) => h.kind === "contact").length;
  const catalogueCount = checkout.handoffs.filter((h) => h.kind === "catalogue").length;

  return (
    <section className="record-form fulfilment-split-card" aria-label="Order confirmation">
      <div className="section-heading">
        <p className="eyebrow">Checked out</p>
        <h3>
          {contactCount} contact pickup{contactCount === 1 ? "" : "s"} + {catalogueCount} shop order
          {catalogueCount === 1 ? "" : "s"}
        </h3>
      </div>
      {checkout.handoffs.map((handoff) => (
        <div className="fulfilment-handoff-row" key={handoff.orderId}>
          <span
            className={`buy-source-badge buy-source-${handoff.kind === "contact" ? "contact" : "catalogue"}`}
          >
            {handoff.kind === "contact" ? "Pickup" : "Shop order"}: {handoff.sourceLabel}
          </span>
          <span>{handoff.status.replaceAll("_", " ")}</span>
        </div>
      ))}
      {checkout.failures.length > 0 ? (
        <div className="fulfilment-failures" aria-label="Items that could not be ordered">
          <p className="shell-note">These items could not be ordered:</p>
          {checkout.failures.map((failure, index) => (
            <p className="shell-note" key={`${failure.sourceLabel}-${index}`}>
              {failure.title} from {failure.sourceLabel} - {failure.reason}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
