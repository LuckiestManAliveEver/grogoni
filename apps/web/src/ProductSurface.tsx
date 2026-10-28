import { lazy } from "react";
import { loadLazyModuleWithRecovery } from "./lazy-module-recovery";
const CommerceSourcesPanel = lazy(() =>
  loadLazyModuleWithRecovery("commerce-sources", () => import("./CommerceSourcesPanel"))
);
import { Suspense, useState } from "react";

import {
  ProductCapturePanel,
  type ProductFormState,
  type ProductSummary
} from "./grogoni-application-shared";

import { formatOptionalMoney } from "./formatters";
import CatalogueBrowsePanel from "./CatalogueBrowsePanel";
import CatalogueShareSettingsCard from "./CatalogueShareSettingsCard";

export interface ProductSurfaceProps {
  businessId: string;
  products: ProductSummary[];
  form: ProductFormState;
  stockProductId: string;
  stockQuantityAfter: string;
  stockReason: string;
  onFormChange: (form: ProductFormState) => void;
  onSave: () => void;
  onReset: () => void;
  onAdd: () => void;
  onEdit: (product: ProductSummary) => void;
  onRemove: (productId: string) => void;
  onStockProductChange: (productId: string) => void;
  onStockQuantityAfterChange: (quantity: string) => void;
  onStockReasonChange: (reason: string) => void;
  onAdjustStock: () => void;
  onPublished: () => Promise<void>;
}

export function ProductSurface(props: ProductSurfaceProps) {
  const [isBrowsingCatalogues, setIsBrowsingCatalogues] = useState(false);
  return (
    <div className="records-surface product-business-card-surface">
      <Suspense fallback={null}>
        <CommerceSourcesPanel businessId={props.businessId} products={props.products} />
      </Suspense>
      <Suspense fallback={<div className="inline-loading-card">Opening quick capture…</div>}>
        <ProductCapturePanel
          businessId={props.businessId}
          products={props.products}
          onPublished={props.onPublished}
        />
      </Suspense>
      <div className="row-actions">
        <button
          className="secondary"
          type="button"
          onClick={() => setIsBrowsingCatalogues((open) => !open)}
        >
          {isBrowsingCatalogues ? "Cancel" : "Browse shared catalogues"}
        </button>
      </div>
      {isBrowsingCatalogues ? (
        <CatalogueBrowsePanel
          businessId={props.businessId}
          onDuplicated={() => void props.onPublished()}
          onClose={() => setIsBrowsingCatalogues(false)}
        />
      ) : null}
      <section className="record-form business-card-editor" aria-label="Product form">
        <div className="business-card-editor-header">
          <div className="section-heading">
            <p className="eyebrow">{props.form.id === null ? "New product" : "Edit product"}</p>
            <h3>{props.form.id === null ? "Add stock item" : "Update stock item"}</h3>
          </div>
          <div className="business-card-editor-actions">
            <button type="button" onClick={props.onSave}>
              Save
            </button>
            <button className="secondary" type="button" onClick={props.onReset}>
              Clear
            </button>
            {props.form.id === null ? null : (
              <button
                className="danger"
                type="button"
                onClick={() => props.onRemove(props.form.id ?? "")}
              >
                Delete
              </button>
            )}
          </div>
        </div>
        <label>
          Item name
          <input
            value={props.form.name}
            onChange={(event) => props.onFormChange({ ...props.form, name: event.target.value })}
          />
        </label>
        <div className="form-row">
          <label>
            SKU
            <input
              value={props.form.sku}
              onChange={(event) => props.onFormChange({ ...props.form, sku: event.target.value })}
            />
          </label>
          <label>
            Unit
            <input
              value={props.form.unit}
              onChange={(event) => props.onFormChange({ ...props.form, unit: event.target.value })}
            />
          </label>
        </div>
        <label>
          Quantity
          <input
            value={props.form.quantity}
            onChange={(event) =>
              props.onFormChange({ ...props.form, quantity: event.target.value })
            }
            inputMode="decimal"
          />
        </label>
        <details className="optional-card-fields">
          <summary>Prices</summary>
          <div className="form-row">
            <label>
              Buying price
              <input
                value={props.form.buyingPrice}
                onChange={(event) =>
                  props.onFormChange({ ...props.form, buyingPrice: event.target.value })
                }
                inputMode="decimal"
                placeholder="Optional"
              />
            </label>
            <label>
              Selling price
              <input
                value={props.form.sellingPrice}
                onChange={(event) =>
                  props.onFormChange({ ...props.form, sellingPrice: event.target.value })
                }
                inputMode="decimal"
                placeholder="Optional"
              />
            </label>
          </div>
        </details>
      </section>

      <section className="record-list product-card-list" aria-label="Product catalogue">
        <div className="surface-header-row">
          <div className="section-heading">
            <p className="eyebrow">Catalogue</p>
            <h3>Existing products</h3>
          </div>
          <button type="button" onClick={props.onAdd}>
            Add
          </button>
        </div>
        {props.products.length === 0 ? (
          <div className="empty-record">
            <h3>No products yet</h3>
            <p>Add the first product to start stock records.</p>
          </div>
        ) : (
          <div className="product-card-list-grid">
            {props.products.map((product) => (
              <article className="product-card-list-item" key={product.id}>
                <div>
                  <strong>{product.name}</strong>
                  <span>
                    {product.quantity} {product.unit}
                    {product.sku === null ? "" : ` · ${product.sku}`}
                  </span>
                  <small>
                    Buy {formatOptionalMoney(product.buyingPrice)} · Sell{" "}
                    {formatOptionalMoney(product.sellingPrice)}
                  </small>
                </div>
                <div className="compact-actions">
                  <button type="button" onClick={() => props.onEdit(product)}>
                    Edit
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => props.onRemove(product.id)}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="record-form compact-stock-card" aria-label="Stock adjustment">
        <div className="section-heading">
          <p className="eyebrow">Inventory</p>
          <h3>Adjust stock</h3>
        </div>
        <label>
          Product
          <select
            value={props.stockProductId}
            onChange={(event) => props.onStockProductChange(event.target.value)}
          >
            <option value="">Select product</option>
            {props.products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Counted quantity
          <input
            value={props.stockQuantityAfter}
            onChange={(event) => props.onStockQuantityAfterChange(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          Reason
          <input
            value={props.stockReason}
            onChange={(event) => props.onStockReasonChange(event.target.value)}
          />
        </label>
        <button type="button" onClick={props.onAdjustStock} disabled={props.stockProductId === ""}>
          Record movement
        </button>
      </section>

      <CatalogueShareSettingsCard businessId={props.businessId} />
    </div>
  );
}
