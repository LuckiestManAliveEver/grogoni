import { useState } from "react";
import type {
  DocumentImportJobSummary,
  ProductImportDraft,
  ProductSummary,
  UnifiedCommerceRecord
} from "@grogoni/shared-types";
import { getJson, postJson } from "./api-helpers";
import { inferImportContentType, isBinaryImportDocument } from "./ImportSurface";
import { dataUrlPayload, readFileAsDataUrl } from "./chat-message-plumbing";
import { getUserFacingErrorMessage } from "./user-facing-error";
export default function CommerceSourceReviewPanel({
  businessId,
  records,
  products,
  operation
}: {
  businessId: string;
  records: UnifiedCommerceRecord[];
  products: ProductSummary[];
  operation: (name: string, values: object) => Promise<void>;
}) {
  const [sourceId, setSourceId] = useState("");
  const [principal, setPrincipal] = useState("");
  const [territory, setTerritory] = useState("");
  const [currency, setCurrency] = useState("KES");
  const [expiry, setExpiry] = useState("");
  const [canonical, setCanonical] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [fulfillments, setFulfillments] = useState<
    { invoiceId: string; productId: string; quantity: number; fulfilledAt: string | null }[]
  >([]);
  const [agents, setAgents] = useState<
    {
      agentBusinessId: string;
      agentName: string;
      wholesalerName: string;
      territory: string | null;
    }[]
  >([]);
  async function importSheet(file: File) {
    setBusy(true);
    try {
      if (!sourceId || !expiry) throw new Error("Choose the source and price expiry first.");
      const contentType = file.type || inferImportContentType(file.name);
      const binary = isBinaryImportDocument(file.name, contentType);
      const job = await postJson<DocumentImportJobSummary>(
        `/businesses/${businessId}/imports/product-catalogue`,
        {
          fileName: file.name,
          contentType,
          sourceType: "upload",
          sourceLocator: `commerce-source:${sourceId}`,
          ...(binary
            ? { contentBase64: dataUrlPayload(await readFileAsDataUrl(file)) }
            : { content: await file.text() })
        }
      );
      const invalid = job.rows.filter((row) => row.errors.length);
      if (invalid.length)
        throw new Error(
          "This sheet needs corrections in the document import review before it can be used."
        );
      await operation("source.import", {
        sourceId,
        feed: {
          products: job.rows.map((row) => {
            const product = row.mapped as ProductImportDraft;
            return {
              externalId: product.sku ?? `document:${job.source.checksum}:${row.rowNumber}`,
              name: product.name,
              unit: product.unit,
              identity: {
                ...(product.sku ? { sku: product.sku, skuNamespace: sourceId } : {}),
                unit: product.unit
              },
              price: product.sellingPrice,
              currency,
              validUntil: new Date(expiry).toISOString(),
              availability: "unknown"
            };
          })
        }
      });
      setMessage(
        "Source candidates prepared. Supplier cost and sheet quantities were not copied into public offers or physical inventory."
      );
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function loadFulfillments() {
    try {
      setFulfillments(await getJson(`/businesses/${businessId}/commerce-sources/fulfillments`));
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    }
  }
  return (
    <details>
      <summary>Source review and wholesaler authorization</summary>
      <p role="status">{message}</p>
      <label>
        Source
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">Choose source</option>
          {records.map((r) =>
            r.kind === "source" ? (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ) : null
          )}
        </select>
      </label>
      {records.map((r) =>
        r.kind === "source" && r.id === sourceId ? (
          <div key={r.id}>
            <p>
              {r.authorization
                ? "Website control verified"
                : "Owner or agent maintained; website control unverified"}{" "}
              · Last refresh: {r.lastSuccessfulRefresh ?? "Never"}
            </p>
            {r.error ? <p>{r.error}</p> : null}
            {r.challenge ? (
              <>
                <p>
                  Place this exact text at your website&apos;s /.well-known/grogoni-commerce.txt:
                </p>
                <code>{r.challenge}</code>
                <button
                  disabled={busy}
                  onClick={() => void operation("source.verify", { sourceId: r.id })}
                >
                  Verify website control
                </button>
                <button
                  disabled={busy}
                  onClick={() => void operation("source.refresh", { sourceId: r.id })}
                >
                  Refresh authorized JSON feed
                </button>
              </>
            ) : null}
            {records.map((grant) =>
              grant.kind === "representation" &&
              grant.businessId === businessId &&
              grant.status === "authorized" ? (
                <button
                  key={grant.id}
                  disabled={busy}
                  onClick={() =>
                    void operation("source.representation", {
                      id: r.id,
                      representationId: grant.id
                    })
                  }
                >
                  Use wholesaler authorization {grant.principalBusinessId}
                </button>
              ) : null
            )}
          </div>
        ) : null
      )}
      <label>
        Sheet currency
        <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
      </label>
      <label>
        Sheet prices expire
        <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
      </label>
      <label>
        Approved document or price sheet
        <input
          type="file"
          disabled={busy || !sourceId}
          accept=".csv,.tsv,.json,.xlsx,.xls,.ods,.docx,.pdf,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importSheet(file);
          }}
        />
      </label>
      {records.map((r) =>
        r.kind === "candidate" && r.status === "review" ? (
          <div key={r.id}>
            <p>
              {r.product.name} · {r.product.price ?? "Price unknown"} {r.product.currency} ·{" "}
              {r.conflict ?? "Awaiting owner review"}
            </p>
            <label>
              Canonical product
              <select
                value={canonical[r.id] ?? ""}
                onChange={(e) => setCanonical((v) => ({ ...v, [r.id]: e.target.value }))}
              >
                <option value="">Create a stock-free product</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.unit}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void operation("candidate.confirm", {
                  id: r.id,
                  confirmed: true,
                  ...(canonical[r.id] ? { productId: canonical[r.id] } : {})
                })
              }
            >
              Confirm identity and draft offer
            </button>
            <button
              disabled={busy}
              onClick={() => void operation("candidate.reject", { id: r.id })}
            >
              Reject candidate
            </button>
          </div>
        ) : null
      )}
      <label>
        Wholesaler business ID
        <input value={principal} onChange={(e) => setPrincipal(e.target.value)} />
      </label>
      <label>
        Territory, if agreed
        <input value={territory} onChange={(e) => setTerritory(e.target.value)} />
      </label>
      <button
        disabled={busy}
        onClick={() =>
          void operation("representation.request", {
            principalBusinessId: principal,
            ...(territory.trim() ? { territory } : {})
          })
        }
      >
        Request wholesaler authorization
      </button>
      {records.map((r) =>
        r.kind === "representation" ? (
          <div key={r.id}>
            <p>
              {r.businessId} represents {r.principalBusinessId}: {r.status}
            </p>
            {r.principalBusinessId === businessId ? (
              <>
                {["authorized", "rejected", "revoked"].map((status) => (
                  <button
                    key={status}
                    disabled={busy}
                    onClick={() =>
                      void operation("representation.decide", { id: r.id, status, confirmed: true })
                    }
                  >
                    {status === "authorized"
                      ? "Authorize agent"
                      : status === "rejected"
                        ? "Reject"
                        : "Revoke authorization"}
                  </button>
                ))}
              </>
            ) : null}
          </div>
        ) : null
      )}
      <button
        onClick={() =>
          void getJson<typeof agents>(`/businesses/${businessId}/commerce-sources/distribution`)
            .then(setAgents)
            .catch((e) => setMessage(getUserFacingErrorMessage(e)))
        }
      >
        Discover authorized agents
      </button>
      {agents.map((agent) => (
        <div key={`${agent.agentBusinessId}:${agent.wholesalerName}`}>
          <p>
            {agent.agentName} · authorized by {agent.wholesalerName} ·{" "}
            {agent.territory ?? "Territory unspecified"}
          </p>
          <button
            onClick={() =>
              void operation("relationship.request", { targetBusinessId: agent.agentBusinessId })
            }
          >
            Request distribution connection
          </button>
        </div>
      ))}
      <button onClick={() => void loadFulfillments()}>Supplier fulfillment requests</button>
      {fulfillments.map((row) => (
        <div key={`${row.invoiceId}:${row.productId}`}>
          <p>
            {row.quantity} × {row.productId} ·{" "}
            {row.fulfilledAt ? "Fulfilled" : "Stock confirmation required"}
          </p>
          <button
            disabled={!!row.fulfilledAt}
            onClick={() =>
              void operation("fulfillment.confirm", {
                invoiceId: row.invoiceId,
                confirmed: true
              }).then(loadFulfillments)
            }
          >
            Confirm physical fulfillment
          </button>
        </div>
      ))}
    </details>
  );
}
