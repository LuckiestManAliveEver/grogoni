import { useState } from "react";
import { getJson } from "./api-helpers";
interface Binding {
  sourceDocument: { fileName: string; sha256: string } | null;
  nodes: Array<{ id: string; kind: string; label: string; quantity?: number }>;
}
export function ReceiptBindingCard({
  businessId,
  receiptId
}: {
  businessId: string;
  receiptId: string;
}) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [error, setError] = useState("");
  return (
    <details
      onToggle={(event) => {
        if (!event.currentTarget.open || binding) return;
        void getJson<Binding>(`/businesses/${businessId}/purchase-receipts/${receiptId}/network`)
          .then(setBinding)
          .catch((error) =>
            setError(error instanceof Error ? error.message : "Could not load receipt links.")
          );
      }}
    >
      <summary>Records linked by this receipt</summary>
      {error && <p role="alert">{error}</p>}
      {binding ? (
        <>
          <p>{binding.sourceDocument?.fileName ?? "Delivery receipt"}</p>
          <ul>
            {binding.nodes
              .filter((n) => n.kind !== "document")
              .map((node, index) => (
                <li key={`${node.kind}:${node.id}:${index}`}>
                  {node.kind === "wholesaler"
                    ? "Wholesaler"
                    : node.kind === "sales_agent"
                      ? "Sales agent"
                      : "Delivered product"}
                  : {node.label}
                  {node.quantity === undefined ? "" : ` × ${node.quantity}`}
                </li>
              ))}
          </ul>
        </>
      ) : (
        !error && <p>Loading receipt links…</p>
      )}
    </details>
  );
}
