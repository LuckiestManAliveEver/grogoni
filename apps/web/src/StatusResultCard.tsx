import type { BuyResultSummary } from "@grogoni/shared-types";

/**
 * One row in the BUY feed - a contact's status or a catalogue listing, rendered distinctly by
 * sourceKind (never merged into a generic "product result" look) so a buyer can tell at a glance
 * whether they're looking at a friend's status or a shop's catalogue. Sibling to
 * StatusBroadcastCard/UnifiedCartSummary/FulfilmentSplitCard - same "one card per commerce
 * object" convention.
 */
export function StatusResultCard(props: {
  result: BuyResultSummary;
  isAuthenticated: boolean;
  onAddToCart: (result: BuyResultSummary) => void;
  // Optional: a guest browsing without an account has no cart to add to, but every result should
  // still lead somewhere - signup - rather than a dead end. Callers that already gate guest
  // browsing some other way (or never render this card unauthenticated) can leave it unset.
  onSignUp?: () => void;
}) {
  const { result } = props;
  return (
    <div className="buy-result-card">
      <span className={`buy-result-thumb buy-result-thumb-${result.sourceKind}`} aria-hidden="true">
        {result.sourceKind === "contact" ? "C" : "S"}
      </span>
      <span className="buy-result-copy">
        <span className={`buy-source-badge buy-source-${result.sourceKind}`}>
          {result.sourceKind === "contact" ? "Contact" : "Marketplace"} · {result.sourceLabel}
        </span>
        <strong>{result.title}</strong>
        <span className="buy-result-price">
          {result.price === null ? "Price on request" : `KSh ${result.price}`}
        </span>
      </span>
      {props.isAuthenticated ? (
        <button type="button" onClick={() => props.onAddToCart(result)}>
          + Add
        </button>
      ) : props.onSignUp !== undefined ? (
        <button type="button" onClick={props.onSignUp}>
          Sign up to message this seller
        </button>
      ) : null}
    </div>
  );
}
