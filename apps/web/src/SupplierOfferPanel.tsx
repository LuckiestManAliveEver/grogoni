import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import type { ProductSummary, SupplierOfferReview, SupplierSummary } from "@grogoni/shared-types";
import type { RuntimeTurnResult } from "./grogoni-application-shared";
import { fetchFreshJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { parseOfferFixed, parseSupplierOfferResponse } from "./supplier-offer-values";
import { isExplicitOfflineMode } from "./offline-runtime";
import "./supplier-offer-panel.css";

type Offer = Omit<SupplierOfferReview, "productName" | "supplierName">;
const money = (value: number, currency: string) =>
  new Intl.NumberFormat("en-KE", { style: "currency", currency }).format(value / 100);
const quantity = (value: number) =>
  new Intl.NumberFormat("en-KE", { maximumFractionDigits: 3 }).format(value / 1000);

export default function SupplierOfferPanel({
  businessId,
  suppliers
}: {
  businessId: string;
  suppliers: Pick<SupplierSummary, "id" | "name">[];
}) {
  const id = useId();
  const offline = isExplicitOfflineMode();
  const base = `/businesses/${encodeURIComponent(businessId)}`;
  const epoch = useRef(0);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [offers, setOffers] = useState<SupplierOfferReview[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [approval, setApproval] = useState<{
    token: string;
    runtimeSessionId: string;
    quote: Offer;
  } | null>(null);
  const [draft, setDraft] = useState({
    productId: "",
    supplierId: "",
    price: "",
    minimum: "1",
    increment: "1",
    available: "",
    lead: "",
    expires: "",
    charges: false
  });

  useEffect(() => {
    const request = ++epoch.current;
    if (offline) {
      setProducts([]);
      setOffers([]);
      setApproval(null);
      setPending(false);
      return;
    }
    setPending(true);
    setError("");
    setApproval(null);
    setNotice("");
    void Promise.all([
      fetchFreshJson<ProductSummary[]>(`${base}/products`),
      fetchFreshJson<{ offers: SupplierOfferReview[]; truncated: boolean }>(
        `${base}/runtime/procurement/offers`
      )
    ])
      .then(([loadedProducts, loadedOffers]) => {
        if (epoch.current !== request) return;
        const verifiedOffers = parseSupplierOfferResponse(loadedOffers);
        if (!Array.isArray(loadedProducts)) throw new Error("Products could not be loaded.");
        setProducts(loadedProducts);
        setOffers(verifiedOffers.offers);
        setTruncated(verifiedOffers.truncated);
      })
      .catch((cause) => {
        if (epoch.current !== request) return;
        setProducts([]);
        setOffers([]);
        setError(getUserFacingErrorMessage(cause));
      })
      .finally(() => {
        if (epoch.current === request) setPending(false);
      });
    return () => {
      ++epoch.current;
    };
  }, [base, reload, offline]);

  const product = products.find((item) => item.id === draft.productId);
  const supplier = suppliers.find((item) => item.id === draft.supplierId);
  async function propose(event: FormEvent) {
    event.preventDefault();
    if (pending || offline) return;
    const request = epoch.current;
    setError("");
    setNotice("");
    try {
      if (!product || !supplier) throw new Error("Choose a product and supplier.");
      if (!draft.charges) throw new Error("Confirm that the price includes all charges.");
      const lead = Number(draft.lead);
      const expires = new Date(draft.expires);
      const quote: Offer = {
        id: crypto.randomUUID(),
        productId: product.id,
        supplierId: supplier.id,
        unit: product.unit,
        currency: "KES",
        unitPriceMinor: parseOfferFixed(draft.price, 2, "Unit price"),
        minQuantityMilli: parseOfferFixed(draft.minimum, 3, "Minimum quantity"),
        incrementMilli: parseOfferFixed(draft.increment, 3, "Order increment"),
        availableQuantityMilli: parseOfferFixed(draft.available, 3, "Available quantity"),
        leadTimeDays: lead,
        expiresAt: Number.isFinite(expires.getTime()) ? expires.toISOString() : "",
        priceIncludesCharges: true
      };
      if (
        !/^\d+$/u.test(draft.lead) ||
        !Number.isInteger(lead) ||
        lead > 365 ||
        !quote.unitPriceMinor ||
        !quote.minQuantityMilli ||
        !quote.incrementMilli ||
        expires.getTime() <= Date.now() ||
        !quote.expiresAt
      )
        throw new Error(
          "Enter positive price, minimum and increment, a lead time of 0 to 365 days, and a future expiry."
        );
      setPending(true);
      const result = await postJson<RuntimeTurnResult>(`${base}/runtime/turns`, {
        message: `#procurement.quote.record ${JSON.stringify(quote)}`
      });
      if (epoch.current !== request) return;
      if (
        result.session.businessId !== businessId ||
        result.turn.status !== "needs_confirmation" ||
        result.turn.plan.toolName !== "procurement.quote.record" ||
        !result.turn.plan.confirmationToken ||
        !Object.entries(quote).every(([key, value]) => result.turn.plan.input[key] === value)
      )
        throw new Error(
          "The exact supplier offer could not be prepared for approval. No approval was given."
        );
      setApproval({
        token: result.turn.plan.confirmationToken,
        runtimeSessionId: result.session.id,
        quote
      });
    } catch (cause) {
      if (epoch.current === request) setError(getUserFacingErrorMessage(cause));
    } finally {
      if (epoch.current === request) setPending(false);
    }
  }

  async function decide(accept: boolean) {
    if (!approval || pending || offline) return;
    const request = epoch.current;
    setPending(true);
    setError("");
    try {
      if (!accept) {
        const rejected = await postJson<{ status: string }>(`${base}/runtime/approvals/reject`, {
          runtimeSessionId: approval.runtimeSessionId,
          confirmationToken: approval.token
        });
        if (rejected.status !== "REJECTED") throw new Error("Rejection was not acknowledged.");
        if (epoch.current === request) {
          setApproval(null);
          setNotice("Offer rejected. Nothing was recorded.");
        }
        return;
      }
      const result = await postJson<RuntimeTurnResult>(`${base}/runtime/turns`, {
        runtimeSessionId: approval.runtimeSessionId,
        confirmationToken: approval.token,
        message: "confirm"
      });
      if (epoch.current !== request) return;
      setApproval(null);
      if (result.turn.status !== "completed")
        throw new Error("Offer recording is incomplete. Refresh offers before trying again.");
      const committed = parseSupplierOfferResponse(
        await fetchFreshJson<unknown>(`${base}/runtime/procurement/offers`)
      );
      if (epoch.current !== request) return;
      setOffers(committed.offers);
      setTruncated(committed.truncated);
      if (
        !committed.offers.some((offer) =>
          Object.entries(approval.quote).every(
            ([key, value]) => offer[key as keyof SupplierOfferReview] === value
          )
        )
      )
        throw new Error(
          "The recorded offer could not be verified. Refresh offers before trying again."
        );
      setNotice("Supplier offer recorded. No purchase order was submitted.");
    } catch (cause) {
      if (epoch.current !== request) return;
      if (accept) setApproval(null);
      setError(getUserFacingErrorMessage(cause));
    } finally {
      if (epoch.current === request) setPending(false);
    }
  }

  if (offline)
    return (
      <section aria-label="Supplier offers">
        <h3>Supplier offers</h3>
        <p>Supplier offers are unavailable offline.</p>
      </section>
    );
  return (
    <section className="supplier-offer-panel" aria-label="Supplier offers" aria-busy={pending}>
      <header>
        <h3>Supplier offers</h3>
        <button
          type="button"
          aria-label="Refresh supplier offers"
          title="Refresh supplier offers"
          disabled={pending || approval !== null}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={(event) => void propose(event)}>
        <fieldset disabled={pending || approval !== null}>
          <legend>New offer</legend>
          <label htmlFor={`${id}-product`}>
            Product
            <select
              id={`${id}-product`}
              required
              value={draft.productId}
              onChange={(event) => setDraft({ ...draft, productId: event.target.value })}
            >
              <option value="">Choose product</option>
              {products.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.unit})
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-supplier`}>
            Supplier
            <select
              id={`${id}-supplier`}
              required
              value={draft.supplierId}
              onChange={(event) => setDraft({ ...draft, supplierId: event.target.value })}
            >
              <option value="">Choose supplier</option>
              {suppliers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ["price", `Unit price (KES per ${product?.unit ?? "unit"})`],
              ["minimum", "Minimum quantity"],
              ["increment", "Order increment"],
              ["available", "Available quantity"],
              ["lead", "Lead time (days)"]
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                required
                inputMode={key === "lead" ? "numeric" : "decimal"}
                value={draft[key]}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
            </label>
          ))}
          <label>
            Offer expires
            <input
              type="datetime-local"
              required
              value={draft.expires}
              onChange={(event) => setDraft({ ...draft, expires: event.target.value })}
            />
          </label>
          <label className="supplier-offer-charges">
            <input
              type="checkbox"
              required
              checked={draft.charges}
              onChange={(event) => setDraft({ ...draft, charges: event.target.checked })}
            />
            Price includes tax, delivery and all other charges
          </label>
          <button type="submit" disabled={pending || !product || !supplier}>
            Review offer
          </button>
        </fieldset>
      </form>
      {approval && (
        <div className="supplier-offer-review" aria-label="Review supplier offer">
          <h4>Confirm supplier offer</h4>
          <p>
            <strong>{product?.name}</strong> from <strong>{supplier?.name}</strong>
          </p>
          <dl>
            <dt>All-in unit price</dt>
            <dd>
              {money(approval.quote.unitPriceMinor, approval.quote.currency)} per{" "}
              {approval.quote.unit}
            </dd>
            <dt>Minimum / increment / available</dt>
            <dd>
              {quantity(approval.quote.minQuantityMilli)} /{" "}
              {quantity(approval.quote.incrementMilli)} /{" "}
              {quantity(approval.quote.availableQuantityMilli)} {approval.quote.unit}
            </dd>
            <dt>Lead time</dt>
            <dd>{approval.quote.leadTimeDays} days</dd>
            <dt>Expires</dt>
            <dd>{new Date(approval.quote.expiresAt).toLocaleString()}</dd>
          </dl>
          <p>Owner-entered offer. Not supplier acknowledgement or a purchase order.</p>
          <div className="row-actions">
            <button type="button" disabled={pending} onClick={() => void decide(true)}>
              Confirm offer
            </button>
            <button type="button" disabled={pending} onClick={() => void decide(false)}>
              Reject
            </button>
          </div>
        </div>
      )}
      <h4>Recorded offers</h4>
      {offers.length === 0 && <p>{pending ? "Loading offers..." : "No recorded offers."}</p>}
      {truncated && <p>Showing the latest 200 offers.</p>}
      <ul className="supplier-offer-list">
        {offers.map((offer) => (
          <li key={offer.id}>
            <strong>{offer.productName}</strong>
            <span>{offer.supplierName}</span>
            <span>
              {money(offer.unitPriceMinor, offer.currency)} per {offer.unit} · {offer.leadTimeDays}{" "}
              days
            </span>
            <span>
              {Date.parse(offer.expiresAt) <= Date.now()
                ? "Expired"
                : `Expires ${new Date(offer.expiresAt).toLocaleString()}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
