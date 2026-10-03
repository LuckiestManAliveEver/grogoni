import type { BuyResultSourceKind } from "@grogoni/shared-types";

export interface UnifiedCartItem {
  cartItemId: string;
  sourceKind: BuyResultSourceKind;
  sourceId: string;
  sourceLabel: string;
  title: string;
  price: number | null;
  quantity: number;
}

/**
 * Renders the buy cart grouped by source - never flattened into anonymous lines, so the buyer
 * always sees which contact or shop each item is coming from, through review and checkout.
 */
export default function UnifiedCartSummary(props: {
  items: UnifiedCartItem[];
  isCheckingOut: boolean;
  onRemove: (cartItemId: string) => void;
  onCheckout: () => void;
}) {
  const groups = new Map<string, UnifiedCartItem[]>();
  for (const item of props.items) {
    const key = `${item.sourceKind}:${item.sourceId}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const total = props.items.reduce((sum, item) => sum + (item.price ?? 0) * item.quantity, 0);

  return (
    <section className="record-form unified-cart-summary" aria-label="Your cart">
      <div className="section-heading">
        <p className="eyebrow">Cart</p>
        <h3>
          {props.items.length} item{props.items.length === 1 ? "" : "s"} from {groups.size} source
          {groups.size === 1 ? "" : "s"}
        </h3>
      </div>
      {[...groups.entries()].map(([key, group]) => (
        <div className="cart-source-group" key={key}>
          <span className={`buy-source-badge buy-source-${group[0]!.sourceKind}`}>
            {group[0]!.sourceKind === "contact" ? "From your contacts" : "Marketplaces"}
          </span>
          {group.map((item) => (
            <div className="cart-item-row" key={item.cartItemId}>
              <span
                className={`cart-item-thumb cart-item-thumb-${item.sourceKind}`}
                aria-hidden="true"
              >
                {item.title.trim().slice(0, 1).toUpperCase()}
              </span>
              <span className="cart-item-copy">
                <strong>
                  {item.title} × {item.quantity}
                </strong>
                <small>{item.sourceLabel}</small>
              </span>
              <span className="cart-item-price">
                {item.price === null ? "Price on request" : `KSh ${item.price * item.quantity}`}
              </span>
              <button
                type="button"
                className="secondary"
                aria-label={`Remove ${item.title} from cart`}
                onClick={() => props.onRemove(item.cartItemId)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
      <div className="cart-total-row">
        <strong>Total</strong>
        <strong>KSh {total}</strong>
      </div>
      <button type="button" disabled={props.isCheckingOut} onClick={props.onCheckout}>
        {props.isCheckingOut ? "Checking out…" : "Checkout"}
      </button>
    </section>
  );
}
