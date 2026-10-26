import { useState } from "react";
import type { DocumentImportJobSummary } from "@grogoni/shared-types";
import { postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
export default function ShopDescriptionPanel({ businessId }: { businessId: string }) {
  const [description, setDescription] = useState("");
  const [job, setJob] = useState<DocumentImportJobSummary | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details>
      <summary>Describe my shop</summary>
      <label>
        Products you sell, separated by commas
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="I sell maize flour, sugar, cooking oil, rice, and soap."
        />
      </label>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void postJson<DocumentImportJobSummary>(
            `/businesses/${businessId}/commerce-sources/describe`,
            { description }
          )
            .then(setJob)
            .catch((e) => setMessage(getUserFacingErrorMessage(e)))
            .finally(() => setBusy(false));
        }}
      >
        Prepare candidates
      </button>
      <p role="status">{message}</p>
      {job ? (
        <>
          <p>
            Review these product names. Prices and stock have not been inferred. Products use the
            generic unit until you enrich them.
          </p>
          {job.rows.map((r) => (
            <p key={r.rowNumber}>
              {"name" in r.mapped ? r.mapped.name : ""} {r.errors.join("; ")}
            </p>
          ))}
          <button
            disabled={busy || job.status === "confirmed"}
            onClick={() => {
              setBusy(true);
              void postJson(`/businesses/${businessId}/imports/${job.id}/confirm-products`, {})
                .then(() => {
                  setMessage(
                    "Catalogue candidates confirmed. Refresh your catalogue to enrich them."
                  );
                  setJob(null);
                })
                .catch((e) => setMessage(getUserFacingErrorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Confirm reviewed catalogue
          </button>
        </>
      ) : null}
    </details>
  );
}
