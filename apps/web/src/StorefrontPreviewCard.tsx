import { commerceAddressFromGrogoniId } from "@grogoni/shared-types";

import { type ProductSummary } from "./grogoni-application-shared";

import { formatMoney } from "./formatters";

export interface StorefrontPreviewCardProps {
  businessName: string;
  products: ProductSummary[];
  grogoniId: string;
  onBack: () => void;
  onOpenProfile: () => void;
  onAddToOrder: (product: ProductSummary) => void;
  onSell: () => void;
  onMessage: () => void;
}

export function StorefrontPreviewCard({
  businessName,
  products,
  grogoniId,
  onBack,
  onOpenProfile,
  onAddToOrder,
  onSell,
  onMessage
}: StorefrontPreviewCardProps) {
  return (
    <section
      className="generated-card-message storefront-preview-card"
      aria-label={`${businessName} storefront`}
    >
      <div className="generated-card-header">
        <button className="secondary" type="button" onClick={onBack}>
          Back
        </button>
        <span className="mode-badge">Customer view</span>
      </div>
      <button className="storefront-preview-heading" type="button" onClick={onOpenProfile}>
        <span className="storefront-preview-logo">{businessName.slice(0, 1).toUpperCase()}</span>
        <div>
          <h2>{businessName}</h2>
          <p>{commerceAddressFromGrogoniId(grogoniId)}</p>
        </div>
      </button>
      {products.length === 0 ? (
        <div className="inline-empty-state">
          <strong>No public products yet</strong>
          <p>Switch to seller controls and add your first catalogue item.</p>
        </div>
      ) : (
        <div className="storefront-preview-products">
          {products.slice(0, 8).map((product) => (
            <article key={product.id}>
              <strong>{product.name}</strong>
              <span>{product.quantity > 0 ? "In stock" : "Out of stock"}</span>
              <p>
                {product.sellingPrice === null
                  ? `Sold per ${product.unit}`
                  : `${formatMoney(product.sellingPrice)} / ${product.unit}`}
              </p>
              <button
                type="button"
                disabled={product.quantity <= 0}
                onClick={() => onAddToOrder(product)}
                title={product.quantity <= 0 ? "This product is out of stock." : undefined}
              >
                Add to request
              </button>
            </article>
          ))}
        </div>
      )}
      <div className="compact-actions">
        <button type="button" onClick={onSell}>
          {products.length === 0 ? "Add products" : "Switch mode"}
        </button>
        <button className="secondary" type="button" onClick={onMessage}>
          Message shop
        </button>
      </div>
    </section>
  );
}
