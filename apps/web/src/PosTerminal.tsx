import { useMemo, useState } from "react";

import type { PaymentMethod } from "@grogoni/shared-types";

import { formatMoney } from "./formatters";
import { getUserFacingErrorMessage } from "./user-facing-error";
import {
  completePosSale,
  PosPaymentRecordingError,
  type PosSaleLine,
  type PosSaleResult
} from "./pos-sale";
import type { CustomerSummary, ProductSummary } from "./grogoni-application-shared";

const paymentMethods: Array<{ label: string; value: PaymentMethod }> = [
  { label: "Cash", value: "cash" },
  { label: "Mobile money", value: "mobile_money_manual" },
  { label: "Card", value: "card_manual" },
  { label: "Bank transfer", value: "bank_transfer" },
  { label: "Other", value: "other_manual" }
];

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function lineTotal(line: PosSaleLine): number {
  return roundMoney(line.quantity * line.unitPrice);
}

export interface PosTerminalProps {
  businessId: string;
  products: ProductSummary[];
  customers: CustomerSummary[];
  onOpenInvoices: () => void;
  onOpenPayments: () => void;
  onSaleCompleted: () => Promise<void>;
}

export function PosTerminal(props: PosTerminalProps) {
  const [cart, setCart] = useState<PosSaleLine[]>([]);
  const [query, setQuery] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [taxPercent, setTaxPercent] = useState("0");
  const [collectPayment, setCollectPayment] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<PosSaleResult | null>(null);

  const visibleProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return props.products;
    return props.products.filter((product) =>
      [product.name, product.sku ?? "", product.unit].some((value) =>
        value.toLowerCase().includes(normalized)
      )
    );
  }, [props.products, query]);

  const subtotal = roundMoney(cart.reduce((sum, line) => sum + lineTotal(line), 0));
  const parsedTaxPercent = Number(taxPercent);
  const taxRate = Number.isFinite(parsedTaxPercent) ? parsedTaxPercent / 100 : 0;
  const taxTotal = roundMoney(subtotal * taxRate);
  const total = roundMoney(subtotal + taxTotal);

  function availableQuantity(productId: string): number {
    return props.products.find((product) => product.id === productId)?.quantity ?? 0;
  }

  function addProduct(product: ProductSummary) {
    if (product.sellingPrice === null) {
      setMessage(`${product.name} needs a selling price before it can be sold.`);
      return;
    }
    if (product.quantity <= 0) {
      setMessage(`${product.name} is out of stock.`);
      return;
    }
    const existing = cart.find((line) => line.productId === product.id);
    if ((existing?.quantity ?? 0) + 1 > product.quantity) {
      setMessage(`Only ${product.quantity} ${product.unit} of ${product.name} is available.`);
      return;
    }
    setCart((current) =>
      existing === undefined
        ? [
            ...current,
            {
              productId: product.id,
              productName: product.name,
              quantity: 1,
              unitPrice: product.sellingPrice as number
            }
          ]
        : current.map((line) =>
            line.productId === product.id ? { ...line, quantity: line.quantity + 1 } : line
          )
    );
    setReceipt(null);
    setMessage("");
  }

  function updateQuantity(productId: string, nextQuantity: number) {
    const stock = availableQuantity(productId);
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) {
      setCart((current) => current.filter((line) => line.productId !== productId));
      return;
    }
    if (nextQuantity > stock) {
      setMessage(`Only ${stock} is available for this product.`);
      return;
    }
    setCart((current) =>
      current.map((line) =>
        line.productId === productId ? { ...line, quantity: nextQuantity } : line
      )
    );
    setMessage("");
  }

  function updateUnitPrice(productId: string, nextPrice: number) {
    if (!Number.isFinite(nextPrice) || nextPrice < 0) return;
    setCart((current) =>
      current.map((line) =>
        line.productId === productId ? { ...line, unitPrice: nextPrice } : line
      )
    );
  }

  function resetSale() {
    setCart([]);
    setCustomerId("");
    setCustomerName("");
    setTaxPercent("0");
    setPaymentReference("");
    setReceipt(null);
    setMessage("");
  }

  async function submitSale() {
    if (cart.length === 0) {
      setMessage("Add at least one product to the sale.");
      return;
    }
    if (!Number.isFinite(parsedTaxPercent) || parsedTaxPercent < 0 || parsedTaxPercent > 100) {
      setMessage("Tax must be between 0 and 100 percent.");
      return;
    }
    if (collectPayment && total <= 0) {
      setMessage("A zero-total sale cannot record a payment. Turn off payment collection first.");
      return;
    }

    setIsSubmitting(true);
    setMessage("Confirming invoice and moving stock…");
    try {
      const result = await completePosSale({
        businessId: props.businessId,
        customerId: customerId || null,
        customerName: customerId === "" && customerName.trim() !== "" ? customerName.trim() : null,
        taxRate,
        items: cart,
        payment: {
          collectNow: collectPayment,
          method: paymentMethod,
          reference: paymentReference.trim() || null
        }
      });
      setReceipt(result);
      setCart([]);
      setMessage(
        result.payment === null
          ? `${result.invoice.invoiceNumber} confirmed. Payment remains due.`
          : `${result.invoice.invoiceNumber} paid in full.`
      );
      await props.onSaleCompleted();
    } catch (error) {
      if (error instanceof PosPaymentRecordingError) {
        setReceipt({ invoice: error.invoice, payment: null });
        setCart([]);
        setMessage(
          `${error.invoice.invoiceNumber} was confirmed and stock moved, but payment was not recorded. Open Payments to collect it without ringing up the sale again. ${getUserFacingErrorMessage(error.originalError)}`
        );
        await props.onSaleCompleted();
      } else {
        setMessage(getUserFacingErrorMessage(error));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="pos-terminal" aria-label="Point of sale terminal">
      <section className="pos-catalogue" aria-label="Products for sale">
        <div className="section-heading">
          <p className="eyebrow">Point of sale</p>
          <h3>Ring up a sale</h3>
          <p>Choose products, confirm the sale, and optionally record payment in one flow.</p>
        </div>
        <label className="pos-search">
          <span>Find a product</span>
          <input
            type="search"
            value={query}
            placeholder="Name or SKU"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="pos-product-grid">
          {visibleProducts.length === 0 ? (
            <p className="shell-note">No products match this search.</p>
          ) : (
            visibleProducts.map((product) => {
              const unavailable = product.quantity <= 0 || product.sellingPrice === null;
              return (
                <button
                  key={product.id}
                  type="button"
                  className="pos-product-button"
                  disabled={unavailable || isSubmitting}
                  onClick={() => addProduct(product)}
                >
                  <span>
                    <strong>{product.name}</strong>
                    <small>{product.sku ?? product.unit}</small>
                  </span>
                  <span>
                    <strong>
                      {product.sellingPrice === null
                        ? "No price"
                        : formatMoney(product.sellingPrice)}
                    </strong>
                    <small>
                      {product.quantity > 0
                        ? `${product.quantity} ${product.unit} available`
                        : "Out of stock"}
                    </small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="pos-checkout" aria-label="Current sale">
        <div className="section-heading">
          <p className="eyebrow">Current sale</p>
          <h3>
            {cart.length} {cart.length === 1 ? "item" : "items"}
          </h3>
        </div>

        {message.length > 0 ? (
          <p className="pos-message" role="status">
            {message}
          </p>
        ) : null}

        {cart.length === 0 ? (
          <div className="empty-record pos-empty-cart">
            <h3>{receipt === null ? "Cart is empty" : "Sale complete"}</h3>
            <p>
              {receipt === null
                ? "Tap a product to add it."
                : `${receipt.invoice.invoiceNumber} · ${formatMoney(receipt.invoice.total)}`}
            </p>
          </div>
        ) : (
          <div className="pos-cart-lines">
            {cart.map((line) => (
              <article className="pos-cart-line" key={line.productId}>
                <div className="pos-cart-line-heading">
                  <strong>{line.productName}</strong>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Remove ${line.productName}`}
                    onClick={() =>
                      setCart((current) =>
                        current.filter((item) => item.productId !== line.productId)
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
                <div className="pos-line-fields">
                  <label>
                    Quantity
                    <input
                      type="number"
                      min="0"
                      max={availableQuantity(line.productId)}
                      step="any"
                      value={line.quantity}
                      onChange={(event) =>
                        updateQuantity(line.productId, Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Unit price
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(event) =>
                        updateUnitPrice(line.productId, Number(event.target.value))
                      }
                    />
                  </label>
                  <strong>{formatMoney(lineTotal(line))}</strong>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="pos-details">
          <label>
            Customer
            <select
              value={customerId}
              disabled={isSubmitting}
              onChange={(event) => {
                setCustomerId(event.target.value);
                if (event.target.value !== "") setCustomerName("");
              }}
            >
              <option value="">Walk-in customer</option>
              {props.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          {customerId === "" ? (
            <label>
              Customer name (optional)
              <input
                value={customerName}
                maxLength={120}
                disabled={isSubmitting}
                onChange={(event) => setCustomerName(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            Tax percent
            <input
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={taxPercent}
              disabled={isSubmitting}
              onChange={(event) => setTaxPercent(event.target.value)}
            />
          </label>
        </div>

        <label className="checkbox-row pos-payment-toggle">
          <input
            type="checkbox"
            checked={collectPayment}
            disabled={isSubmitting}
            onChange={(event) => setCollectPayment(event.target.checked)}
          />
          Collect full payment now
        </label>
        {collectPayment ? (
          <div className="pos-details">
            <label>
              Payment method
              <select
                value={paymentMethod}
                disabled={isSubmitting}
                onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
              >
                {paymentMethods.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reference (optional)
              <input
                value={paymentReference}
                disabled={isSubmitting}
                onChange={(event) => setPaymentReference(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        <dl className="pos-totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatMoney(subtotal)}</dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{formatMoney(taxTotal)}</dd>
          </div>
          <div className="pos-grand-total">
            <dt>Total</dt>
            <dd>{formatMoney(total)}</dd>
          </div>
        </dl>

        <div className="pos-actions">
          {receipt === null ? (
            <button
              type="button"
              disabled={cart.length === 0 || isSubmitting}
              onClick={() => void submitSale()}
            >
              {isSubmitting
                ? "Completing sale…"
                : collectPayment
                  ? "Complete and pay"
                  : "Confirm sale"}
            </button>
          ) : (
            <button type="button" onClick={resetSale}>
              New sale
            </button>
          )}
          <button type="button" className="secondary" onClick={props.onOpenInvoices}>
            View invoices
          </button>
          {receipt !== null && receipt.payment === null ? (
            <button type="button" className="secondary" onClick={props.onOpenPayments}>
              Open payments
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
