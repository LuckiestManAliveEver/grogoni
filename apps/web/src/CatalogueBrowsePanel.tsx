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
  const [copyProgress, setCopyProgress] = useState<{ done: number; total: number } | null>(null);

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
      `/businesses/${businessId}/catalogue-marketplace/shops/${encodeURIComponent(shop.businessId)}/products`
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
      } else if (next.size < 50) {
        next.add(productId);
      }
      return next;
    });
  }

  async function duplicateSelected() {
    if (activeShop === null || selectedProductIds.size === 0) return;
    const created = await postJson<ProductSummary[]>(
      `/businesses/${businessId}/catalogue-marketplace/shops/${encodeURIComponent(activeShop.businessId)}/duplicate`,
      { productIds: [...selectedProductIds] }
    );
    onDuplicated?.(created);
    setMessage(
      activeShop.sourceKind === "seed"
        ? `${created.length} selected starter items are ready in your catalogue. Review units and set stock and prices. Previously imported items were kept.`
        : `${created.length} ${created.length === 1 ? "product" : "products"} added to your catalogue from ${activeShop.businessName}.`
    );
    setSelectedProductIds(new Set());
  }

  /**
   * Copies every product of a pinned shop (Jane's Shop) in batches of 50, the server's per-request
   * limit. The server matches copies to the marketplace catalogue, so a retry after a failed batch
   * reuses what already landed instead of duplicating it.
   */
  async function copyWholeCatalogue() {
    if (activeShop === null || shopProducts === null || shopProducts.length === 0) return;
    const ids = shopProducts.map((product) => product.id);
    const created: ProductSummary[] = [];
    setCopyProgress({ done: 0, total: ids.length });
    try {
      for (let index = 0; index < ids.length; index += 50) {
        const batch = await postJson<ProductSummary[]>(
          `/businesses/${businessId}/catalogue-marketplace/shops/${encodeURIComponent(activeShop.businessId)}/duplicate`,
          { productIds: ids.slice(index, index + 50) }
        );
        created.push(...batch);
        setCopyProgress({ done: Math.min(index + 50, ids.length), total: ids.length });
      }
    } finally {
      setCopyProgress(null);
    }
    onDuplicated?.(created);
    setMessage(
      `All ${created.length} products from ${activeShop.businessName} are in your catalogue. They start with zero stock and no prices; products you already had were kept.`
    );
    setSelectedProductIds(new Set());
  }

  return (
    <div className="record-form catalogue-browse-panel" aria-label="Browse shared catalogues">
      <div className="section-heading">
        <p className="eyebrow">Shared catalogues</p>
        <h3>
          {activeShop === null ? "Browse starter and shared catalogues" : activeShop.businessName}
        </h3>
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
              Search catalogues
              <input
                value={searchDraft}
                placeholder="Dataset, product, shop name or Grogoni ID"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </label>
            <button type="submit">Search</button>
          </form>
          {shops === null ? (
            <p className="shell-note">Loading shared catalogues…</p>
          ) : shops.length === 0 ? (
            <p className="shell-note">No matching catalogues are available.</p>
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
                  {shop.pinned ? <span className="pinned-shop-label">Pinned</span> : null}
                  <strong>{shop.businessName}</strong>
                  {shop.operatedBy === "marketplace_agent" ? (
                    <small className="pinned-shop-note">
                      Run by the Marketplace Agent · every marketplace product, free to copy
                    </small>
                  ) : null}
                  <small>
                    {shop.sourceKind === "seed"
                      ? `Starter dataset · v${shop.datasetVersion}`
                      : commerceAddressFromGrogoniId(shop.grogoniId)}
                  </small>
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
              Back to catalogues
            </button>
          </div>
          {shopProducts === null ? (
            <p className="shell-note">Loading products…</p>
          ) : shopProducts.length === 0 ? (
            <p className="shell-note">This shop hasn&apos;t added any products yet.</p>
          ) : (
            <>
              <p className="shell-note" id="catalogue-selection-help" aria-live="polite">
                Select up to 50 products per import. {selectedProductIds.size} of 50 selected.
                {activeShop.sourceKind === "seed"
                  ? " Starter items have zero stock and no prices. Review units and set stock and prices after importing."
                  : activeShop.pinned
                    ? " Copied items have zero stock and no prices (the shop's demo prices are not copied). Set stock and prices after importing."
                    : " Imported items start with zero stock. Review prices after importing."}
              </p>
              {activeShop.pinned ? (
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={isPending("catalogue-browse-copy-all")}
                    onClick={() =>
                      void runAction("catalogue-browse-copy-all", async () => {
                        try {
                          await copyWholeCatalogue();
                        } catch (error) {
                          setMessage(getUserFacingErrorMessage(error));
                        }
                      })
                    }
                  >
                    {copyProgress === null
                      ? `Copy whole catalogue (${shopProducts.length} products)`
                      : `Copying ${copyProgress.done} of ${copyProgress.total}…`}
                  </button>
                </div>
              ) : null}
              {shopProducts.map((product) => (
                <label className="product-management-item catalogue-browse-item" key={product.id}>
                  <input
                    type="checkbox"
                    checked={selectedProductIds.has(product.id)}
                    aria-describedby="catalogue-selection-help"
                    disabled={
                      isPending("catalogue-browse-duplicate") ||
                      (selectedProductIds.size >= 50 && !selectedProductIds.has(product.id))
                    }
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
