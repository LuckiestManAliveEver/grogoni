import { useEffect, useState } from "react";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { fetchFreshJson, patchJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import type {
  DocumentImportConfirmResult,
  DocumentImportJobSummary
} from "./grogoni-application-shared";

function draftName(draft: DocumentImportJobSummary["rows"][number]["mapped"]): string {
  return draft.name;
}

// Self-contained generated-surface card for the imports domain (Phase 4f). Uploading a document is
// unavoidably a file action (createDocumentImport still happens on the permanent Purchase receipts
// page) - but confirming an already-previewed import already works from chat today
// (document_import.confirm resolves "confirm the import" to the latest previewed job with no
// changes needed here). This card fills the one real gap: reviewing and adjusting row selection
// inline instead of requiring a trip to the permanent page first. See
// docs/frontend/frontend.md Phase 4f.
export default function ImportManagementCard(props: { businessId: string; importJobId?: string }) {
  const importsPath = `/businesses/${props.businessId}/imports`;
  const mutationRevision = useApiMutationRevision(importsPath);
  const { isPending, runAction } = useAsyncActions();
  const [job, setJob] = useState<DocumentImportJobSummary | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetchFreshJson<DocumentImportJobSummary[]>(importsPath)
      .then((jobs) => {
        if (cancelled) return;
        const matched =
          props.importJobId === undefined
            ? jobs.find((item) => item.status === "previewed")
            : jobs.find((item) => item.id === props.importJobId);
        if (matched === undefined) {
          setMessage("No document import is waiting for review.");
          return;
        }
        setJob(matched);
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [importsPath, mutationRevision, props.importJobId]);

  async function toggleRow(rowNumber: number, selected: boolean) {
    if (job === null) return;
    const row = job.rows.find((item) => item.rowNumber === rowNumber);
    if (row === undefined) return;
    const rowEndpoint = job.target === "product" ? "product-rows" : "rows";
    const updated = await patchJson<DocumentImportJobSummary>(
      `/businesses/${props.businessId}/imports/${job.id}/${rowEndpoint}/${rowNumber}`,
      { mapped: row.mapped, selected }
    );
    setJob(updated);
  }

  async function confirm() {
    if (job === null) return;
    const confirmEndpoint = job.target === "product" ? "confirm-products" : "confirm";
    const response = await postJson<DocumentImportConfirmResult>(
      `/businesses/${props.businessId}/imports/${job.id}/${confirmEndpoint}`,
      { selectedRowNumbers: job.rows.filter((row) => row.selected).map((row) => row.rowNumber) }
    );
    setJob(response.job);
    setMessage(
      `${response.job.confirmedCount} ${job.target} row${response.job.confirmedCount === 1 ? "" : "s"} imported`
    );
  }

  if (job === null) {
    return (
      <section className="record-form import-management-card" aria-label="Imports">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading import…</p>}
      </section>
    );
  }

  return (
    <section className="record-form import-management-card" aria-label="Review a document import">
      <div className="section-heading">
        <p className="eyebrow">Imports</p>
        <h3>Review {job.source.fileName}</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {job.rows.map((row) => (
        <div className="import-management-row" key={row.rowNumber}>
          <label>
            <input
              type="checkbox"
              checked={row.selected}
              disabled={row.errors.length > 0 || job.status !== "previewed"}
              onChange={(event) =>
                void runAction(`import-row-${row.rowNumber}`, async () => {
                  try {
                    await toggleRow(row.rowNumber, event.target.checked);
                  } catch (error) {
                    setMessage(getUserFacingErrorMessage(error));
                  }
                })
              }
            />
            {draftName(row.mapped)}
          </label>
          {row.errors.length > 0 ? (
            <small className="shell-note">{row.errors.join(", ")}</small>
          ) : null}
        </div>
      ))}
      {job.status === "previewed" ? (
        <div className="row-actions">
          <button
            type="button"
            onClick={() =>
              void runAction("import-confirm", async () => {
                try {
                  await confirm();
                } catch (error) {
                  setMessage(getUserFacingErrorMessage(error));
                }
              })
            }
            disabled={isPending("import-confirm") || job.rows.every((row) => !row.selected)}
          >
            Confirm import
          </button>
        </div>
      ) : (
        <p className="shell-note">
          {job.status === "confirmed"
            ? `Confirmed: ${job.confirmedCount} rows imported.`
            : "Import failed."}
        </p>
      )}
    </section>
  );
}
