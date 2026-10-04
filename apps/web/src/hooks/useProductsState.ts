import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type {
  ProductFieldDefinition,
  ProductFieldSchemaSummary,
  SyncMutationPayload,
  SyncMutationType
} from "@grogoni/shared-types";

import type { ShellView, GrogoniMode } from "../app-shell";
import { getErrorMessage } from "../chat-message-plumbing";
import { deleteJson, getJson, patchJson, postJson } from "../api-helpers";
import {
  createDefaultProductFieldDefinitions,
  productFieldDefinitionsFromDrafts
} from "../owner-app-bootstrap";
import {
  emptyProductForm,
  type ProductFieldDraft,
  type ProductFormState,
  type ProductSummary,
  type StockAdjustmentResponse
} from "../grogoni-application-shared";

interface UseProductsStateDeps {
  businessId: string | null;
  setStatusMessage: (message: string) => void;
  queueMutationAfterNetworkFailure: (
    error: unknown,
    mutationType: SyncMutationType,
    payload: SyncMutationPayload
  ) => Promise<boolean>;
  // routedProductId/setRoutedProductId/navigateToView all live in Navigation's own hook (Phase 19),
  // called after Products (Navigation needs Products' populateProductForm as an eager dep) -
  // deferred behind a getter so deleteProduct reads Navigation's current values at click time
  // instead of at Products' own hook-call time, which would otherwise be a TDZ error.
  getNavigationHelpers: () => {
    routedProductId: string | null;
    setRoutedProductId: (productId: string | null) => void;
    navigateToView: (
      nextView: ShellView,
      options?: { replace?: boolean; mode?: GrogoniMode }
    ) => void;
  };
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useProductsState(deps: UseProductsStateDeps) {
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [productFields, setProductFields] = useState<ProductFieldDefinition[]>(() =>
    createDefaultProductFieldDefinitions()
  );
  const [productForm, setProductForm] = useState<ProductFormState>(emptyProductForm);
  const [stockProductId, setStockProductId] = useState("");
  const [stockQuantityAfter, setStockQuantityAfter] = useState("0");
  const [stockReason, setStockReason] = useState("Manual stock count");

  function populateProductForm(product: ProductSummary) {
    setProductForm({
      id: product.id,
      name: product.name,
      sku: product.sku ?? "",
      unit: product.unit,
      quantity: String(product.quantity),
      buyingPrice: product.buyingPrice === null ? "" : String(product.buyingPrice),
      sellingPrice: product.sellingPrice === null ? "" : String(product.sellingPrice),
      fieldValues: product.fieldValues ?? {}
    });
    setStockProductId(product.id);
    setStockQuantityAfter(String(product.quantity));
  }

  async function loadProducts(businessId: string) {
    try {
      const response = await getJson<ProductSummary[]>(
        `/businesses/${businessId}/products`,
        setProducts
      );
      setProducts(response);
      if (stockProductId.length === 0 && response[0] !== undefined) {
        setStockProductId(response[0].id);
        setStockQuantityAfter(String(response[0].quantity));
      }
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function loadProductFields(businessId: string) {
    try {
      const schema = await getJson<ProductFieldSchemaSummary>(
        `/businesses/${businessId}/products/fields`,
        (refreshed) => setProductFields(refreshed.fields)
      );
      setProductFields(schema.fields);
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function saveProduct(): Promise<boolean> {
    if (deps.businessId === null) {
      return false;
    }

    try {
      const payload = {
        name: productForm.name,
        sku: productForm.sku,
        unit: productForm.unit,
        quantity: Number(productForm.quantity),
        buyingPrice:
          productForm.buyingPrice.trim().length === 0 ? null : Number(productForm.buyingPrice),
        sellingPrice:
          productForm.sellingPrice.trim().length === 0 ? null : Number(productForm.sellingPrice),
        fieldValues: productForm.fieldValues
      };
      const product =
        productForm.id === null
          ? await postJson<ProductSummary>(`/businesses/${deps.businessId}/products`, payload)
          : await patchJson<ProductSummary>(
              `/businesses/${deps.businessId}/products/${productForm.id}`,
              payload
            );

      setProductForm(emptyProductForm);
      setStockProductId(product.id);
      setStockQuantityAfter(String(product.quantity));
      await loadProducts(deps.businessId);
      deps.setStatusMessage(productForm.id === null ? "Product created" : "Product updated");
      return true;
    } catch (error) {
      if (
        productForm.id === null &&
        (await deps.queueMutationAfterNetworkFailure(error, "product.create", {
          name: productForm.name,
          sku: productForm.sku,
          unit: productForm.unit,
          quantity: Number(productForm.quantity),
          buyingPrice:
            productForm.buyingPrice.trim().length === 0 ? null : Number(productForm.buyingPrice),
          sellingPrice:
            productForm.sellingPrice.trim().length === 0 ? null : Number(productForm.sellingPrice)
        }))
      ) {
        setProductForm(emptyProductForm);
        return true;
      }
      deps.setStatusMessage(getErrorMessage(error));
      return false;
    }
  }

  async function deleteProduct(productId: string) {
    if (deps.businessId === null) {
      return;
    }
    const productName =
      products.find((product) => product.id === productId)?.name ?? "this product";
    if (!window.confirm(`Delete ${productName}? This cannot be undone.`)) return;

    try {
      const product = await deleteJson<ProductSummary>(
        `/businesses/${deps.businessId}/products/${productId}`
      );

      if (productForm.id === product.id) {
        setProductForm(emptyProductForm);
      }

      if (stockProductId === product.id) {
        setStockProductId("");
        setStockQuantityAfter("");
      }

      await loadProducts(deps.businessId);
      const { routedProductId, setRoutedProductId, navigateToView } = deps.getNavigationHelpers();
      if (routedProductId === product.id) {
        setRoutedProductId(null);
        navigateToView("products", { replace: true, mode: "seller" });
      }
      deps.setStatusMessage("Product removed");
    } catch (error) {
      // The sync-queue protocol (SyncMutationType) has no delete mutation type, so a failed delete
      // cannot be queued for offline retry - surface the error instead of queuing an unrelated
      // mutation.
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function adjustStock() {
    if (deps.businessId === null || stockProductId.length === 0) {
      return;
    }

    try {
      const response = await postJson<StockAdjustmentResponse>(
        `/businesses/${deps.businessId}/products/${stockProductId}/stock-adjustments`,
        {
          quantityAfter: Number(stockQuantityAfter),
          reason: stockReason
        }
      );
      await loadProducts(deps.businessId);
      setStockQuantityAfter(String(response.product.quantity));
      deps.setStatusMessage("Stock adjusted");
    } catch (error) {
      if (
        await deps.queueMutationAfterNetworkFailure(error, "inventory.adjust", {
          productId: stockProductId,
          quantityAfter: Number(stockQuantityAfter),
          reason: stockReason
        })
      ) {
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function saveProductFieldStructure(fields: ProductFieldDraft[]) {
    if (deps.businessId === null) {
      return;
    }

    try {
      const schema = await postJson<ProductFieldSchemaSummary>(
        `/businesses/${deps.businessId}/products/fields`,
        {
          fields: productFieldDefinitionsFromDrafts(fields)
        }
      );
      setProductFields(schema.fields);
      deps.setStatusMessage("Product field structure saved");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("products", () => {
    setProducts([]);
    setProductFields(createDefaultProductFieldDefinitions());
    setProductForm(emptyProductForm);
    // stockProductId/stockQuantityAfter/stockReason were never included in resetClientToStartup's
    // reset sweep before this extraction - same class of pre-existing gap the backend domain-
    // modularization roadmap found and fixed for statusBroadcasts/buyOrders, and this frontend
    // effort already found once for purchaseReceipts (Phase 4). Fixed here rather than carried
    // forward.
    setStockProductId("");
    setStockQuantityAfter("0");
    setStockReason("Manual stock count");
  });
  deps.registerRefresh("products", ["products", "pos", "invoices", "imports"], loadProducts);
  deps.registerRefresh("product-fields", ["products"], loadProductFields);

  return {
    products,
    productFields,
    productForm,
    setProductForm,
    stockProductId,
    setStockProductId,
    stockQuantityAfter,
    setStockQuantityAfter,
    stockReason,
    setStockReason,
    populateProductForm,
    loadProducts,
    loadProductFields,
    saveProduct,
    deleteProduct,
    adjustStock,
    saveProductFieldStructure
  };
}
