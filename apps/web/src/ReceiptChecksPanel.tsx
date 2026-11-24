import type { ReceiptChecksSummary } from "@grogoni/shared-types";

import { receiptDocumentTypeLabels } from "./receipt-checks";

/**
 * What confirmation will check (computed by the server, ReceiptChecksSummary): whether this kind
 * of document may be saved as a purchase, and any arithmetic on it that does not add up. Each
 * mismatch must be corrected, or ticked as checked against the paper, before confirming.
 */
export function ReceiptChecksPanel({
  checks,
  acknowledged,
  onAcknowledge
}: {
  checks: ReceiptChecksSummary | undefined;
  acknowledged: ReadonlySet<string>;
  onAcknowledge: (field: string, checked: boolean) => void;
}) {
  if (checks === undefined) return null;
  return (
    <div className="receipt-checks" aria-label="Receipt checks">
      <p>
        <strong>{receiptDocumentTypeLabels[checks.documentType]}</strong>
        {checks.recordPurchase ? null : <> · cannot be saved as a purchase</>}
      </p>
      {checks.refusal ? <p role="status">{checks.refusal}</p> : null}
      {checks.duplicateOf?.match === "same" ? (
        <p role="status">
          Already saved: this is the receipt from {checks.duplicateOf.supplierName} on{" "}
          {checks.duplicateOf.receiptDate.slice(0, 10)} ({checks.duplicateOf.total}). It cannot be
          saved twice.
        </p>
      ) : null}
      {checks.duplicateOf?.match === "possible" ? (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={acknowledged.has(duplicateKey(checks.duplicateOf.receiptId))}
            onChange={(event) =>
              onAcknowledge(duplicateKey(checks.duplicateOf!.receiptId), event.target.checked)
            }
          />
          <span>
            This looks like the receipt from {checks.duplicateOf.supplierName} on{" "}
            {checks.duplicateOf.receiptDate.slice(0, 10)} ({checks.duplicateOf.total}) already
            saved. It is a different receipt.
          </span>
        </label>
      ) : null}
      {checks.arithmeticIssues.length > 0 ? (
        <fieldset>
          <legend>These numbers do not add up</legend>
          {checks.arithmeticIssues.map((issue) => (
            <label key={issue.field} className="checkbox-row">
              <input
                type="checkbox"
                checked={acknowledged.has(issue.field)}
                onChange={(event) => onAcknowledge(issue.field, event.target.checked)}
              />
              <span>
                {issue.message} I checked: the paper says {issue.printed}.
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}

/** The acknowledgement key for "this is a different receipt than that one". */
export const duplicateKey = (receiptId: string) => `duplicate:${receiptId}`;

/** Whether confirmation would accept this draft with these acknowledgements. */
export function receiptReadyToConfirm(
  checks: ReceiptChecksSummary | undefined,
  acknowledged: ReadonlySet<string>
): boolean {
  if (checks === undefined) return true;
  if (checks.duplicateOf?.match === "same") return false;
  if (
    checks.duplicateOf?.match === "possible" &&
    !acknowledged.has(duplicateKey(checks.duplicateOf.receiptId))
  )
    return false;
  return (
    checks.recordPurchase && checks.arithmeticIssues.every((issue) => acknowledged.has(issue.field))
  );
}

/** The confirm request's acknowledgement fields from the ticked boxes. */
export function receiptConfirmAcknowledgements(acknowledged: ReadonlySet<string>): {
  acknowledgedDiscrepancies: string[];
  confirmedDifferentFrom?: string;
} {
  const different = [...acknowledged].find((key) => key.startsWith("duplicate:"));
  return {
    acknowledgedDiscrepancies: [...acknowledged].filter((key) => !key.startsWith("duplicate:")),
    ...(different ? { confirmedDifferentFrom: different.slice("duplicate:".length) } : {})
  };
}
