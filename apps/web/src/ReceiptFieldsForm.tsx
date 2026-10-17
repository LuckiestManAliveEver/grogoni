import { useState } from "react";
import type {
  ReceiptOCRJobSummary,
  ReceiptStructuredExtractionSummary
} from "@grogoni/shared-types";

/** A document is evidence for these proposed fields; the owner reviews it before committing records. */
export function ReceiptFieldsForm({
  job,
  onSave,
  onReviewStateChange
}: {
  job: ReceiptOCRJobSummary;
  onSave: (fields: ReceiptStructuredExtractionSummary) => Promise<void>;
  onReviewStateChange?: (ready: boolean) => void;
}) {
  const [fields, setFields] = useState(() => structuredClone(job.structuredExtraction));
  const updateFields: typeof setFields = (next) => {
    setFields(next);
    onReviewStateChange?.(false);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editable = ![
    "COMPLETED",
    "CONFIRMED",
    "PURCHASE_RECORDED",
    "CANCELLED",
    "confirmed"
  ].includes(job.status);
  return (
    <form
      aria-label={`Receipt fields for ${job.sourceFileName}`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        onReviewStateChange?.(false);
        setError("");
        try {
          await onSave(fields);
          onReviewStateChange?.(true);
        } catch (error) {
          setError(error instanceof Error ? error.message : "Could not save receipt fields.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && <p role="alert">{error}</p>}
      <p>
        The receipt connects the wholesaler, sales agent and delivered products. Review the fields,
        save corrections, then confirm the delivery.
      </p>
      {(["supplier", "salesAgent", "receipt"] as const).map((section) => (
        <fieldset key={section} disabled={!editable || busy}>
          <legend>
            {section === "supplier"
              ? "Wholesaler / supplier"
              : section === "salesAgent"
                ? "Sales agent"
                : "Receipt details"}
          </legend>
          {Object.entries(fields[section]).map(([key, value]) => (
            <label key={key}>
              {key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}
              <input
                aria-label={`${section} ${key}`}
                value={value ?? ""}
                type={
                  typeof value === "number" ||
                  ["subtotal", "discount", "tax", "total", "amountPaid", "balance"].includes(key)
                    ? "number"
                    : "text"
                }
                step="any"
                min="0"
                onChange={(event) => {
                  const raw = event.target.value;
                  const next =
                    event.target.type === "number"
                      ? raw === ""
                        ? null
                        : Number(raw)
                      : raw || null;
                  updateFields((current) => ({
                    ...current,
                    [section]: { ...current[section], [key]: next }
                  }));
                }}
              />
            </label>
          ))}
        </fieldset>
      ))}
      <fieldset disabled={!editable || busy}>
        <legend>Products delivered</legend>
        {fields.products.map((product, index) => (
          <fieldset key={index}>
            <legend>Product {index + 1}</legend>
            {Object.entries(product).map(([key, value]) => (
              <label key={key}>
                {key.replace(/([A-Z])/g, " $1")}
                <input
                  aria-label={`Product ${index + 1} ${key}`}
                  value={value ?? ""}
                  type={["quantity", "unitPrice", "lineTotal"].includes(key) ? "number" : "text"}
                  step="any"
                  min={key === "quantity" ? "0.000001" : "0"}
                  required={["itemName", "quantity", "unitPrice", "lineTotal"].includes(key)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const next = event.target.type === "number" ? Number(raw) : raw || null;
                    updateFields((current) => ({
                      ...current,
                      products: current.products.map((p, i) =>
                        i === index ? { ...p, [key]: next } : p
                      )
                    }));
                  }}
                />
              </label>
            ))}
            <button
              type="button"
              onClick={() =>
                updateFields((current) => ({
                  ...current,
                  products: current.products.filter((_, i) => i !== index)
                }))
              }
            >
              Remove product
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            updateFields((current) => ({
              ...current,
              products: [
                ...current.products,
                {
                  itemName: "",
                  itemCode: null,
                  sku: null,
                  quantity: 1,
                  unit: null,
                  unitPrice: 0,
                  lineTotal: 0,
                  batchNumber: null,
                  expiryDate: null
                }
              ]
            }))
          }
        >
          Add delivered product
        </button>
      </fieldset>
      {editable && (
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save receipt fields"}
        </button>
      )}
    </form>
  );
}
