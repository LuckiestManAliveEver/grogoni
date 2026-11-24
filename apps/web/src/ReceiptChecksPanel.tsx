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

/** Whether confirmation would accept this draft with these acknowledgements. */
export function receiptReadyToConfirm(
  checks: ReceiptChecksSummary | undefined,
  acknowledged: ReadonlySet<string>
): boolean {
  if (checks === undefined) return true;
  return (
    checks.recordPurchase && checks.arithmeticIssues.every((issue) => acknowledged.has(issue.field))
  );
}
