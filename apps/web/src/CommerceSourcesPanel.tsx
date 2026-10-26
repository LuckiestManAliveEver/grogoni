import { useEffect, useState } from "react";
import type {
  UnifiedCommerceRecord,
  PublishedCommerceOffer,
  ProductSummary
} from "@grogoni/shared-types";
import { commerceSourceTypes } from "@grogoni/shared-types";
import { getJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import CommerceSourceReviewPanel from "./CommerceSourceReviewPanel";
import ShopDescriptionPanel from "./ShopDescriptionPanel";
import GalleryBatchPanel from "./GalleryBatchPanel";
export default function CommerceSourcesPanel({
  businessId,
  products
}: {
  businessId: string;
  products: ProductSummary[];
}) {
  const [records, setRecords] = useState<UnifiedCommerceRecord[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState("DEVICE_GALLERY");
  const [reference, setReference] = useState("");
  const [label, setLabel] = useState("");
  const [productId, setProductId] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("KES");
  const [expiry, setExpiry] = useState("");
  const [query, setQuery] = useState("");
  const [offers, setOffers] = useState<PublishedCommerceOffer[]>([]);
  const [target, setTarget] = useState("");
  useEffect(() => {
    let cancelled = false;
    setRecords([]);
    void getJson<UnifiedCommerceRecord[]>(`/businesses/${businessId}/commerce-sources`)
      .then((v) => {
        if (!cancelled) setRecords(v);
      })
      .catch((e) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);
  async function operation(operation: string, values: object) {
    setBusy(true);
    try {
      await postJson(`/businesses/${businessId}/commerce-sources/operations`, {
        operation,
        values
      });
      setRecords(
        await getJson<UnifiedCommerceRecord[]>(`/businesses/${businessId}/commerce-sources`)
      );
      setMessage("Saved.");
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function offerValues() {
    if (!expiry || !price.trim()) throw new Error("Enter your selling price and its expiry.");
    return { price: Number(price), currency, validUntil: new Date(expiry).toISOString() };
  }
  async function createOffer(extra: object) {
    try {
      await operation("offer.create", { ...offerValues(), ...extra });
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    }
  }
  return (
    <section className="record-form" aria-label="Commerce sources">
      <h3>Where are your products?</h3>
      <p>
        Connect your phone gallery, purchase receipts, sales agent, another Grogoni catalogue,
        spreadsheet or document, shop description, or existing website. Review before publishing.
      </p>
      <p role="status">{message}</p>
      <CommerceSourceReviewPanel
        businessId={businessId}
        records={records}
        products={products}
        operation={operation}
      />
      <GalleryBatchPanel key={businessId} businessId={businessId} />
      <ShopDescriptionPanel key={`description:${businessId}`} businessId={businessId} />
      <details>
        <summary>Connect a source</summary>
        <label>
          Source
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {commerceSourceTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>
          Document, catalogue reference or HTTPS website
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <button
          disabled={busy}
          onClick={() => void operation("source.connect", { type, reference, label })}
        >
          Connect privately
        </button>
        <p>
          Website registration records your source. Imports use the existing document importer;
          website interactions use the existing browser runtime. Registration does not verify
          website ownership or live inventory.
        </p>
      </details>
      {records
        .filter((r) => r.kind === "source")
        .map(
          (r) =>
            r.kind === "source" && (
              <div key={r.id}>
                <strong>{r.label}</strong> · {r.status} · {r.authority}
                <button
                  disabled={busy || r.status === "disconnected"}
                  onClick={() => void operation("source.disconnect", { id: r.id })}
                >
                  Disconnect
                </button>
              </div>
            )
        )}
      <details>
        <summary>Offers and reselling</summary>
        <label>
          Product
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose a product</option>
            {products.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Your selling price
          <input type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label>
          Currency
          <input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </label>
        <label>
          Price valid until
          <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </label>
        <button disabled={busy || !productId} onClick={() => void createOffer({ productId })}>
          Create draft offer
        </button>
        {records
          .filter((r) => r.kind === "offer")
          .map(
            (r) =>
              r.kind === "offer" && (
                <div key={r.id}>
                  <p>
                    {r.price} {r.currency} · {r.status} · availability {r.availability}
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => void operation("offer.publish", { id: r.id, confirmed: true })}
                  >
                    Publish offer
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void operation("offer.publish", {
                        id: r.id,
                        confirmed: true,
                        allowResell: true
                      })
                    }
                  >
                    Publish and permit linked resale
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void operation("offer.withdraw", { id: r.id })}
                  >
                    Withdraw
                  </button>
                </div>
              )
          )}
        <label>
          Discover published offers
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button
          disabled={busy}
          onClick={() => {
            void getJson<PublishedCommerceOffer[]>(
              `/public/commerce-offers?query=${encodeURIComponent(query)}`
            )
              .then(setOffers)
              .catch((e) => setMessage(getUserFacingErrorMessage(e)));
          }}
        >
          Search
        </button>
        {offers.map((o) => (
          <div key={o.id}>
            <p>
              {o.name} · {o.seller} · {o.price} {o.currency} · availability {o.availability}
            </p>
            <button disabled={busy} onClick={() => void createOffer({ upstreamOfferId: o.id })}>
              Resell with my price
            </button>
          </div>
        ))}
        <p>
          Reselling requires the supplier&apos;s permission. Draft offers hold no inventory. Your
          selling price remains independent.
        </p>
      </details>
      <details>
        <summary>Distribution connections</summary>
        <label>
          Participating business ID
          <input value={target} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <button
          disabled={busy}
          onClick={() => void operation("relationship.request", { targetBusinessId: target })}
        >
          Request connection
        </button>
        {records
          .filter((r) => r.kind === "relationship")
          .map(
            (r) =>
              r.kind === "relationship" && (
                <div key={r.id}>
                  <p>
                    {r.businessId} → {r.targetBusinessId} · {r.status}
                  </p>
                  {r.targetBusinessId === businessId && r.status === "requested" ? (
                    <>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void operation("relationship.respond", { id: r.id, accept: true })
                        }
                      >
                        Accept
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void operation("relationship.respond", { id: r.id, accept: false })
                        }
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  <button
                    disabled={busy}
                    onClick={() => void operation("relationship.revoke", { id: r.id })}
                  >
                    Revoke
                  </button>
                </div>
              )
          )}
        <p>
          A connection shares no purchase history and does not verify wholesaler representation.
        </p>
      </details>
    </section>
  );
}
