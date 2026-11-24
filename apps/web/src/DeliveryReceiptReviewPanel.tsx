import { useEffect, useState } from "react";
import type { PurchaseReceiptSummary, ReceiptOCRJobSummary } from "@grogoni/shared-types";
import { fetchFreshJson, patchJson, postJson } from "./api-helpers";
import { ReceiptFieldsForm } from "./ReceiptFieldsForm";
import { ReceiptBindingCard } from "./ReceiptBindingCard";
import {
  ReceiptChecksPanel,
  receiptConfirmAcknowledgements,
  receiptReadyToConfirm
} from "./ReceiptChecksPanel";

/** Durable chat cards read the same receipt drafts as the Suppliers workspace. */
export function DeliveryReceiptReviewPanel({ businessId }: { businessId: string }) {
  const path = `/businesses/${businessId}/receipt-ocr/jobs`;
  const [jobs, setJobs] = useState<ReceiptOCRJobSummary[]>([]);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Arithmetic mismatches ticked as checked against the paper, per draft.
  const [acknowledged, setAcknowledged] = useState<Record<string, ReadonlySet<string>>>({});
  useEffect(() => {
    let cancelled = false;
    void fetchFreshJson<ReceiptOCRJobSummary[]>(path).then(
      (value) => {
        if (!cancelled) setJobs(value);
      },
      (error) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : "Could not load receipt drafts.");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path]);
  return (
    <section aria-label="Delivery receipt review">
      {error && <p role="alert">{error}</p>}
      {jobs.map((job) => {
        const binding = job.structuredExtraction.deliveryBinding;
        const completed =
          binding ||
          ["COMPLETED", "CONFIRMED", "PURCHASE_RECORDED", "confirmed", "CANCELLED"].includes(
            job.status
          );
        return (
          <article className="receipt-ocr-card" key={job.id}>
            <h4>{job.sourceFileName}</h4>
            <ReceiptFieldsForm
              key={`${job.id}:${job.updatedAt}`}
              job={job}
              onReviewStateChange={(value) =>
                setReady((current) =>
                  current[job.id] === value ? current : { ...current, [job.id]: value }
                )
              }
              onSave={async (fields) => {
                const corrected = await patchJson<ReceiptOCRJobSummary>(`${path}/${job.id}`, {
                  extractedText: job.fullText,
                  structuredExtraction: fields
                });
                setJobs((current) =>
                  current.map((item) => (item.id === job.id ? corrected : item))
                );
              }}
            />
            {!completed ? (
              <ReceiptChecksPanel
                checks={job.structuredExtraction.checks}
                acknowledged={acknowledged[job.id] ?? new Set()}
                onAcknowledge={(field, checked) =>
                  setAcknowledged((current) => {
                    const next = new Set(current[job.id] ?? []);
                    if (checked) next.add(field);
                    else next.delete(field);
                    return { ...current, [job.id]: next };
                  })
                }
              />
            ) : null}
            <details>
              <summary>Extracted receipt text</summary>
              <pre>{job.fullText}</pre>
            </details>
            {binding ? (
              <>
                <p>Delivery received and linked to its records.</p>
                <ReceiptBindingCard businessId={businessId} receiptId={binding.purchaseReceiptId} />
              </>
            ) : (
              !completed && (
                <button
                  type="button"
                  disabled={
                    busy !== null ||
                    ready[job.id] === false ||
                    !receiptReadyToConfirm(
                      job.structuredExtraction.checks,
                      acknowledged[job.id] ?? new Set()
                    )
                  }
                  onClick={async () => {
                    setBusy(job.id);
                    setError("");
                    try {
                      const receipt = await postJson<PurchaseReceiptSummary>(
                        `${path}/${job.id}/confirm`,
                        {
                          supplierId: job.matchedSupplierId,
                          salesAgentId: job.matchedSalesAgentId,
                          receiveInventory: true,
                          ...receiptConfirmAcknowledgements(acknowledged[job.id] ?? new Set()),
                          createSupplier: job.matchedSupplierId === null,
                          createSalesAgent:
                            job.matchedSalesAgentId === null && job.salesAgentName !== null
                        }
                      );
                      // Retain the confirmed link immediately; a refresh loads its durable stock bindings.
                      setJobs((current) =>
                        current.map((item) =>
                          item.id === job.id
                            ? {
                                ...item,
                                status: "COMPLETED",
                                structuredExtraction: {
                                  ...item.structuredExtraction,
                                  deliveryBinding: {
                                    purchaseReceiptId: receipt.id,
                                    receivedAt: receipt.createdAt,
                                    products: []
                                  }
                                }
                              }
                            : item
                        )
                      );
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : "Could not confirm the delivery."
                      );
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === job.id ? "Receiving delivery…" : "Confirm and save"}
                </button>
              )
            )}
          </article>
        );
      })}
    </section>
  );
}
