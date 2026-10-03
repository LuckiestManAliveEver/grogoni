import { useEffect, useState } from "react";
import type { InvoiceSummary, ProductSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import type { ConfirmInvoiceResponse } from "./grogoni-application-shared";

// Self-contained generated-surface card for the invoices domain (Phase 4d). Unlike
// products/suppliers/customers, invoices genuinely need interactive product+quantity+price
// composition - the free-text parser only reliably extracts a customer name (create_invoice's
// own validation has always required "product and price details" it can't parse from one
// message). Rather than a fragile multi-slot extractor, the chat trigger opens this card
// pre-filled with the extracted customer name, and the owner composes the one line item here,
// matching the permanent InvoiceSurface's own single-item-per-draft shape. See
// docs/frontend/frontend.md Phase 4d.
export default function InvoiceManagementCard(props: {
  businessId: string;
  customerName?: string;
}) {
  const productsPath = `/businesses/${props.businessId}/products`;
  const invoicesPath = `/businesses/${props.businessId}/invoices`;
  const mutationRevision = useApiMutationRevision(productsPath, invoicesPath);
  const { isPending, runAction } = useAsyncActions();
  const [products, setProducts] = useState<ProductSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [customerName, setCustomerName] = useState(props.customerName ?? "");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [draft, setDraft] = useState<InvoiceSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getJson<ProductSummary[]>(productsPath)
      .then((loaded) => {
        if (cancelled) return;
        setProducts(loaded);
        const first = loaded[0];
        if (first !== undefined) {
          setProductId(first.id);
          if (first.sellingPrice !== null) setUnitPrice(String(first.sellingPrice));
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [productsPath, mutationRevision]);

  async function saveDraft() {
    if (customerName.trim().length === 0) {
      setMessage("Enter a customer name.");
      return;
    }
    if (productId === "") {
      setMessage("Choose a product.");
      return;
    }
    const invoice = await postJson<InvoiceSummary>(`/businesses/${props.businessId}/invoices`, {
      customerId: null,
      customerName: customerName.trim(),
      taxRate: 0,
      items: [{ productId, quantity: Number(quantity), unitPrice: Number(unitPrice) }]
    });
    setDraft(invoice);
    setMessage(`Draft invoice ${invoice.invoiceNumber} saved`);
  }

  async function confirmDraft() {
    if (draft === null) return;
    const response = await postJson<ConfirmInvoiceResponse>(
      `/businesses/${props.businessId}/invoices/${draft.id}/confirm`,
      {}
    );
    setDraft(response.invoice);
    setMessage(`Invoice ${response.invoice.invoiceNumber} confirmed and stock moved`);
  }

  if (products === null) {
    return (
      <section className="record-form invoice-management-card" aria-label="Invoices">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading products…</p>}
      </section>
    );
  }

  return (
    <section className="record-form invoice-management-card" aria-label="Compose an invoice">
      <div className="section-heading">
        <p className="eyebrow">Invoices</p>
        <h3>Compose an invoice from chat</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {draft === null ? (
        <>
          <label>
            Customer
            <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
          </label>
          <label>
            Product
            <select value={productId} onChange={(event) => setProductId(event.target.value)}>
              {products.length === 0 ? <option value="">No products yet</option> : null}
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <label>
            Unit price
            <input
              inputMode="decimal"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
            />
          </label>
          <div className="row-actions">
            <button
              type="button"
              disabled={isPending("invoice-management-save") || products.length === 0}
              onClick={() =>
                void runAction("invoice-management-save", async () => {
                  try {
                    await saveDraft();
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            >
              Save draft
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>
              {draft.invoiceNumber} · {draft.customerName ?? "No customer"}
            </strong>
            <br />
            Total: {draft.total}
          </p>
          {draft.status === "draft" ? (
            <div className="row-actions">
              <button
                type="button"
                disabled={isPending("invoice-management-confirm")}
                onClick={() =>
                  void runAction("invoice-management-confirm", async () => {
                    try {
                      await confirmDraft();
                    } catch (error) {
                      setMessage(getUserFacingErrorMessage(error));
                    }
                  })
                }
              >
                Confirm invoice
              </button>
            </div>
          ) : (
            <p className="shell-note">Confirmed.</p>
          )}
        </>
      )}
    </section>
  );
}
