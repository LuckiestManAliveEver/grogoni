import { useEffect, useState } from "react";
import {
  commerceAddressFromGrogoniId,
  type ProductSummary,
  type ShareableCatalogueProductSummary,
  type ShareableCatalogueSummary
} from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";

export interface CatalogueBrowsePanelProps {
  businessId: string;
  onDuplicated?: (products: ProductSummary[]) => void;
  onClose?: () => void;
}

// Self-contained generated-surface card (Phase 4a pattern, see ProductManagementCard): browse
// other shops that opted their catalogue in to sharing (CatalogueShareSettingsCard), pick
// products from one, and duplicate them into this business's own catalogue via the
// catalogue-sharing domain, which itself calls the same SalesDomain.createProduct path a manual
// "Add product" uses - so duplicated products get identical validation/eventing/permission checks.
export default function CatalogueBrowsePanel({
  businessId,
  onDuplicated,
  onClose
}: CatalogueBrowsePanelProps) {
  const { isPending, runAction } = useAsyncActions();
  const [shops, setShops] = useState<ShareableCatalogueSummary[] | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [activeShop, setActiveShop] = useState<ShareableCatalogueSummary | null>(null);
  const [shopProducts, setShopProducts] = useState<ShareableCatalogueProductSummary[] | null>(null);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const query =
      appliedSearch.trim().length === 0
        ? ""
        : `?search=${encodeURIComponent(appliedSearch.trim())}`;
    void getJson<ShareableCatalogueSummary[]>(
      `/businesses/${businessId}/catalogue-marketplace/shops${query}`
    )
      .then((loaded) => {
        if (!cancelled) setShops(loaded);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, appliedSearch]);

  async function openShop(shop: ShareableCatalogueSummary) {
    const products = await getJson<ShareableCatalogueProductSummary[]>(
      `/businesses/${businessId}/catalogue-marketplace/shops/${shop.businessId}/products`
    );
    setActiveShop(shop);
    setShopProducts(products);
    setSelectedProductIds(new Set());
  }

  function toggleProduct(productId: string) {
    setSelectedProductIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  }

  async function duplicateSelected() {
    if (activeShop === null || selectedProductIds.size === 0) return;
    const created = await postJson<ProductSummary[]>(
      `/businesses/${businessId}/catalogue-marketplace/shops/${activeShop.businessId}/duplicate`,
      { productIds: [...selectedProductIds] }
    );
    onDuplicated?.(created);
    setMessage(
      `${created.length} ${created.length === 1 ? "product" : "products"} added to your catalogue from ${activeShop.businessName}.`
    );
    setSelectedProductIds(new Set());
  }

  return (
    <div className="record-form catalogue-browse-panel" aria-label="Browse shared catalogues">
      <div className="section-heading">
        <p className="eyebrow">Shared catalogues</p>
        <h3>{activeShop === null ? "Browse other shops' catalogues" : activeShop.businessName}</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}

      {activeShop === null ? (
        <>
          <form
            className="row-actions"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(searchDraft);
            }}
          >
            <label>
              Search shops
              <input
                value={searchDraft}
                placeholder="Shop name or Grogoni ID"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </label>
            <button type="submit">Search</button>
          </form>
          {shops === null ? (
            <p className="shell-note">Loading shared catalogues…</p>
          ) : shops.length === 0 ? (
            <p className="shell-note">No shops have shared their catalogue for duplication yet.</p>
          ) : (
            <div className="marketplace-directory" aria-label="Shops sharing their catalogue">
              {shops.map((shop) => (
                <button
                  className="public-shop-card"
                  type="button"
                  key={shop.businessId}
                  disabled={isPending(`catalogue-browse-open-${shop.businessId}`)}
                  onClick={() =>
                    void runAction(`catalogue-browse-open-${shop.businessId}`, async () => {
                      try {
                        await openShop(shop);
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  <strong>{shop.businessName}</strong>
                  <small>{commerceAddressFromGrogoniId(shop.grogoniId)}</small>
                  <p>
                    {shop.productCount} catalogue {shop.productCount === 1 ? "item" : "items"}
                  </p>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => {
                setActiveShop(null);
                setShopProducts(null);
                setSelectedProductIds(new Set());
              }}
            >
              Back to shops
            </button>
          </div>
          {shopProducts === null ? (
            <p className="shell-note">Loading products…</p>
          ) : shopProducts.length === 0 ? (
            <p className="shell-note">This shop hasn&apos;t added any products yet.</p>
          ) : (
            <>
              {shopProducts.map((product) => (
                <label className="product-management-item catalogue-browse-item" key={product.id}>
                  <input
                    type="checkbox"
                    checked={selectedProductIds.has(product.id)}
                    onChange={() => toggleProduct(product.id)}
                  />
                  <span>
                    <strong>{product.name}</strong>
                    <br />
                    {product.unit}
                    {product.sellingPrice === null ? "" : ` · ${product.sellingPrice}`}
                  </span>
                </label>
              ))}
              <div className="row-actions">
                <button
                  type="button"
                  disabled={
                    selectedProductIds.size === 0 || isPending("catalogue-browse-duplicate")
                  }
                  onClick={() =>
                    void runAction("catalogue-browse-duplicate", async () => {
                      try {
                        await duplicateSelected();
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  Add {selectedProductIds.size > 0 ? selectedProductIds.size : ""} selected to my
                  catalogue
                </button>
              </div>
            </>
          )}
        </>
      )}
      {onClose === undefined ? null : (
        <div className="row-actions">
          <button className="secondary" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
