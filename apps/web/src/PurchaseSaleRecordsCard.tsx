import { useEffect, useState } from "react";
import type { CustomerSummary, ProductSummary } from "@grogoni/shared-types";
import type { PurchaseRecordSummary, SaleRecordSummary } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import type { SupplierBusinessCardSummary } from "./grogoni-application-shared";

interface PurchaseDraft {
  supplierId: string;
  productId: string;
  quantity: string;
  unit: string;
  buyingPrice: string;
  currency: string;
  notes: string;
}

interface SaleDraft {
  customerId: string;
  customerName: string;
  productId: string;
  quantity: string;
  unitPrice: string;
  currency: string;
}

const emptyPurchaseDraft: PurchaseDraft = {
  supplierId: "",
  productId: "",
  quantity: "1",
  unit: "",
  buyingPrice: "",
  currency: "KES",
  notes: ""
};

const emptySaleDraft: SaleDraft = {
  customerId: "",
  customerName: "",
  productId: "",
  quantity: "1",
  unitPrice: "",
  currency: "KES"
};

// Self-contained management card for the commercial-records domain's purchase and sale records
// (full transaction history - distinct from ProductManagementCard's per-product purchase-price
// endpoint). Mounted permanently inside SupplierSurface, not chat-invoked - see this session's
// scoping notes in docs/frontend/frontend.md's Phase 4b/4d precedent for why a full purchase/sale
// ledger stays a permanent surface rather than gaining new chat/NLU wiring. Fetches its own data
// from businessId alone, same shape as ProductManagementCard/InvoiceManagementCard.
export default function PurchaseSaleRecordsCard(props: { businessId: string }) {
  const suppliersPath = `/businesses/${props.businessId}/suppliers`;
  const productsPath = `/businesses/${props.businessId}/products`;
  const customersPath = `/businesses/${props.businessId}/customers`;
  const purchasesPath = `/businesses/${props.businessId}/purchases`;
  const salesPath = `/businesses/${props.businessId}/sales`;
  const mutationRevision = useApiMutationRevision(purchasesPath, salesPath);
  const { isPending, runAction } = useAsyncActions();

  const [suppliers, setSuppliers] = useState<SupplierBusinessCardSummary[]>([]);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [purchases, setPurchases] = useState<PurchaseRecordSummary[] | null>(null);
  const [sales, setSales] = useState<SaleRecordSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft>(emptyPurchaseDraft);
  const [saleDraft, setSaleDraft] = useState<SaleDraft>(emptySaleDraft);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<SupplierBusinessCardSummary[]>(suppliersPath),
      getJson<ProductSummary[]>(productsPath),
      getJson<CustomerSummary[]>(customersPath)
    ])
      .then(([loadedSuppliers, loadedProducts, loadedCustomers]) => {
        if (cancelled) return;
        setSuppliers(loadedSuppliers);
        setProducts(loadedProducts);
        setCustomers(loadedCustomers);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
    // Reference lists only need to load once - they aren't invalidated by purchase/sale mutations.
  }, [suppliersPath, productsPath, customersPath]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<PurchaseRecordSummary[]>(`${purchasesPath}/history`),
      getJson<SaleRecordSummary[]>(`${salesPath}/history`)
    ])
      .then(([loadedPurchases, loadedSales]) => {
        if (cancelled) return;
        setPurchases(loadedPurchases);
        setSales(loadedSales);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [purchasesPath, salesPath, mutationRevision]);

  async function recordPurchase() {
    if (purchaseDraft.supplierId === "") {
      setMessage("Choose a supplier.");
      return;
    }
    if (purchaseDraft.productId === "") {
      setMessage("Choose a product.");
      return;
    }
    const quantity = Number(purchaseDraft.quantity);
    const buyingPrice = Number(purchaseDraft.buyingPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMessage("Enter a valid quantity.");
      return;
    }
    if (!Number.isFinite(buyingPrice) || buyingPrice < 0) {
      setMessage("Enter a valid buying price.");
      return;
    }
    const created = await postJson<PurchaseRecordSummary>(purchasesPath, {
      supplierId: purchaseDraft.supplierId,
      productId: purchaseDraft.productId,
      quantity,
      unit: purchaseDraft.unit.trim() || undefined,
      buyingPrice,
      currency: purchaseDraft.currency.trim() || undefined,
      notes: purchaseDraft.notes.trim() || null
    });
    setPurchases((current) => [created, ...(current ?? [])]);
    setPurchaseDraft((current) => ({ ...emptyPurchaseDraft, currency: current.currency }));
    setMessage(`Purchase of ${created.productNameSnapshot} recorded`);
  }

  async function recordSale() {
    if (saleDraft.productId === "") {
      setMessage("Choose a product.");
      return;
    }
    const quantity = Number(saleDraft.quantity);
    const unitPrice = Number(saleDraft.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setMessage("Enter a valid quantity.");
      return;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setMessage("Enter a valid unit price.");
      return;
    }
    const created = await postJson<SaleRecordSummary>(salesPath, {
      customerId: saleDraft.customerId.trim() || null,
      customerName: saleDraft.customerId.trim() ? null : saleDraft.customerName.trim() || null,
      items: [{ productId: saleDraft.productId, quantity, unitPrice }],
      currency: saleDraft.currency.trim() || undefined
    });
    setSales((current) => [created, ...(current ?? [])]);
    setSaleDraft((current) => ({ ...emptySaleDraft, currency: current.currency }));
    setMessage(`Sale of ${formatItemsSummary(created)} recorded`);
  }

  return (
    <section
      className="record-form purchase-sale-records-card"
      aria-label="Purchase and sale records"
    >
      <div className="section-heading">
        <p className="eyebrow">Purchase &amp; sale records</p>
        <h3>Record a purchase or sale</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}

      <div className="records-form-grid">
        <div className="purchase-sale-form-column">
          <h4>Record a purchase</h4>
          <label>
            Supplier
            <select
              value={purchaseDraft.supplierId}
              onChange={(event) =>
                setPurchaseDraft((current) => ({ ...current, supplierId: event.target.value }))
              }
            >
              <option value="">Choose supplier</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Product
            <select
              value={purchaseDraft.productId}
              onChange={(event) =>
                setPurchaseDraft((current) => ({ ...current, productId: event.target.value }))
              }
            >
              <option value="">Choose product</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-row">
            <label>
              Quantity
              <input
                inputMode="decimal"
                value={purchaseDraft.quantity}
                onChange={(event) =>
                  setPurchaseDraft((current) => ({ ...current, quantity: event.target.value }))
                }
              />
            </label>
            <label>
              Unit
              <input
                value={purchaseDraft.unit}
                placeholder="Defaults to product unit"
                onChange={(event) =>
                  setPurchaseDraft((current) => ({ ...current, unit: event.target.value }))
                }
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Buying price
              <input
                inputMode="decimal"
                value={purchaseDraft.buyingPrice}
                onChange={(event) =>
                  setPurchaseDraft((current) => ({ ...current, buyingPrice: event.target.value }))
                }
              />
            </label>
            <label>
              Currency
              <input
                value={purchaseDraft.currency}
                onChange={(event) =>
                  setPurchaseDraft((current) => ({ ...current, currency: event.target.value }))
                }
              />
            </label>
          </div>
          <label>
            Notes
            <textarea
              value={purchaseDraft.notes}
              rows={2}
              onChange={(event) =>
                setPurchaseDraft((current) => ({ ...current, notes: event.target.value }))
              }
            />
          </label>
          <div className="row-actions">
            <button
              type="button"
              disabled={isPending("purchase-record-save")}
              onClick={() =>
                void runAction("purchase-record-save", async () => {
                  try {
                    await recordPurchase();
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            >
              Save purchase
            </button>
          </div>
        </div>

        <div className="purchase-sale-form-column">
          <h4>Record a sale</h4>
          <label>
            Customer
            <select
              value={saleDraft.customerId}
              onChange={(event) =>
                setSaleDraft((current) => ({ ...current, customerId: event.target.value }))
              }
            >
              <option value="">Walk-in customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          {saleDraft.customerId === "" ? (
            <label>
              Customer name
              <input
                value={saleDraft.customerName}
                placeholder="Optional"
                onChange={(event) =>
                  setSaleDraft((current) => ({ ...current, customerName: event.target.value }))
                }
              />
            </label>
          ) : null}
          <label>
            Product
            <select
              value={saleDraft.productId}
              onChange={(event) =>
                setSaleDraft((current) => ({ ...current, productId: event.target.value }))
              }
            >
              <option value="">Choose product</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-row">
            <label>
              Quantity
              <input
                inputMode="decimal"
                value={saleDraft.quantity}
                onChange={(event) =>
                  setSaleDraft((current) => ({ ...current, quantity: event.target.value }))
                }
              />
            </label>
            <label>
              Unit price
              <input
                inputMode="decimal"
                value={saleDraft.unitPrice}
                onChange={(event) =>
                  setSaleDraft((current) => ({ ...current, unitPrice: event.target.value }))
                }
              />
            </label>
          </div>
          <label>
            Currency
            <input
              value={saleDraft.currency}
              onChange={(event) =>
                setSaleDraft((current) => ({ ...current, currency: event.target.value }))
              }
            />
          </label>
          <div className="row-actions">
            <button
              type="button"
              disabled={isPending("sale-record-save")}
              onClick={() =>
                void runAction("sale-record-save", async () => {
                  try {
                    await recordSale();
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            >
              Save sale
            </button>
          </div>
        </div>
      </div>

      <div className="section-heading">
        <p className="eyebrow">History</p>
        <h4>Recent purchases</h4>
      </div>
      {purchases === null ? (
        <p>Loading purchase history…</p>
      ) : purchases.length === 0 ? (
        <p className="shell-note">No purchases recorded yet.</p>
      ) : (
        purchases.map((record) => (
          <article className="mini-card" key={record.id}>
            <strong>{record.productNameSnapshot}</strong>
            <span>
              {record.quantity} {record.unit} from {record.supplierNameSnapshot}
            </span>
            <span>
              {record.currency} {record.buyingPrice} · total {record.currency} {record.totalCost}
            </span>
            <small>{new Date(record.effectiveAt).toLocaleDateString()}</small>
            {record.notes !== null && record.notes.length > 0 ? (
              <small>{record.notes}</small>
            ) : null}
          </article>
        ))
      )}

      <div className="section-heading">
        <h4>Recent sales</h4>
      </div>
      {sales === null ? (
        <p>Loading sale history…</p>
      ) : sales.length === 0 ? (
        <p className="shell-note">No sales recorded yet.</p>
      ) : (
        sales.map((record) => (
          <article className="mini-card" key={record.id}>
            <strong>{record.customerNameSnapshot ?? "Walk-in customer"}</strong>
            <span>{formatItemsSummary(record)}</span>
            <span>
              {record.currency} {record.total}
            </span>
            <small>{new Date(record.soldAt).toLocaleDateString()}</small>
          </article>
        ))
      )}
    </section>
  );
}

function formatItemsSummary(sale: SaleRecordSummary): string {
  return sale.items.map((item) => `${item.quantity} × ${item.productName}`).join(", ");
}
