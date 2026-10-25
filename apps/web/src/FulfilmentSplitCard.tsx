import { useEffect, useState } from "react";
import type { UnifiedCheckoutSummary } from "@grogoni/shared-types";
import { apiFetch } from "./lib/api";
import { formatMoney } from "./formatters";
import { getUserFacingErrorMessage } from "./user-facing-error";

/**
 * Confirms a unified checkout as N contact pickups + M shop orders, each with its own live
 * status, and shows any items that could not be ordered rather than omitting them.
 */
export default function FulfilmentSplitCard(props: { unifiedCheckoutId: string }) {
  const [checkout, setCheckout] = useState<UnifiedCheckoutSummary | null>(null);
  const [message, setMessage] = useState("");

  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setCheckout(null);
    setMessage("");
    setLoading(true);
    let cancelled = false;
    void apiFetch<UnifiedCheckoutSummary>(
      `/buy/checkouts/${encodeURIComponent(props.unifiedCheckoutId)}`
    )
      .then((loaded) => {
        if (!cancelled) setCheckout(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.unifiedCheckoutId, revision]);

  if (checkout === null) {
    return (
      <section className="record-form fulfilment-split-card" aria-label="Order">
        {message.length > 0 ? <p role="alert">{message}</p> : <p>Loading receipt…</p>}
        {!loading && (
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            Try again
          </button>
        )}
      </section>
    );
  }

  const receiptItems = checkout.handoffs.flatMap((handoff) => handoff.items ?? []);
  const total = receiptItems.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0);
  const hasUnknownPrices =
    (checkout.externalRequests?.length ?? 0) > 0 ||
    receiptItems.some((item) => item.unitPrice === null) ||
    checkout.handoffs.some((handoff) => handoff.items === undefined);

  const contactCount = checkout.handoffs.filter((h) => h.kind === "contact").length;
  const catalogueCount = checkout.handoffs.filter((h) => h.kind === "catalogue").length;

  return (
    <section className="record-form fulfilment-split-card" aria-label="Unified receipt">
      <div className="section-heading">
        <p className="eyebrow">{checkout.handoffs.length ? "Order receipt" : "Checkout summary"}</p>
        <h3>
          {contactCount} contact pickup{contactCount === 1 ? "" : "s"} + {catalogueCount} shop order
          {catalogueCount === 1 ? "" : "s"}
        </h3>
      </div>
      <p>Checkout ID: {checkout.id}</p>
      <p>
        <strong>
          {hasUnknownPrices ? "Known total" : "Order total"}: {formatMoney(total)}
        </strong>
      </p>
      {hasUnknownPrices && (
        <p>The total excludes items whose prices are still awaiting confirmation.</p>
      )}
      <p>Payment has not been collected by this checkout. Arrange payment with each seller.</p>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        Refresh order status
      </button>
      {checkout.handoffs.map((handoff) => (
        <div className="fulfilment-handoff-row" key={handoff.orderId}>
          <span
            className={`buy-source-badge buy-source-${handoff.kind === "contact" ? "contact" : "catalogue"}`}
          >
            {handoff.kind === "contact" ? "Pickup" : "Shop order"}: {handoff.sourceLabel}
          </span>
          <span>{handoff.status.replaceAll("_", " ")}</span>
          <p>Order ID: {handoff.orderId}</p>
          {handoff.items ? (
            <>
              <ul>
                {handoff.items.map((item, index) => (
                  <li key={index}>
                    {item.title} × {item.quantity} —{" "}
                    {item.unitPrice === null
                      ? "Price on request"
                      : `${formatMoney(item.unitPrice)} each; ${formatMoney(item.unitPrice * item.quantity)}`}
                  </li>
                ))}
              </ul>
              <p>
                {handoff.items.some((item) => item.unitPrice === null)
                  ? "Known subtotal"
                  : "Subtotal"}
                :{" "}
                {formatMoney(
                  handoff.items.reduce(
                    (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity,
                    0
                  )
                )}
              </p>
            </>
          ) : (
            <p>Item details are unavailable for this order.</p>
          )}
        </div>
      ))}
      {(checkout.externalRequests?.length ?? 0) > 0 && (
        <div aria-label="External retailer checkout links">
          <h4>External retailers — checkout pending</h4>
          <p>
            These items have not been ordered. Prices, delivery and availability must be confirmed
            on each retailer’s website.
          </p>
          {checkout.externalRequests!.map((item, index) => (
            <p key={index}>
              {item.title} × {item.quantity} — {item.sourceLabel}{" "}
              <a href={item.websiteUrl} target="_blank" rel="noopener noreferrer">
                Continue on retailer website
              </a>
            </p>
          ))}
        </div>
      )}
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
