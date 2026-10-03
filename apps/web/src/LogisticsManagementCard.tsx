import { useEffect, useState } from "react";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { getJson, patchJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import type { FulfillmentStatus, LogisticsSummary } from "./grogoni-application-shared";

const openStatuses: FulfillmentStatus[] = ["pending", "ready", "out_for_delivery"];
const nextStatuses: FulfillmentStatus[] = ["ready", "out_for_delivery", "completed", "cancelled"];

// Self-contained generated-surface card for the logistics domain (Phase 4h), same shape as
// PaymentManagementCard: logistics.update_status can never be fully specified from free text
// alone (which of possibly several open deliveries, and which status), so the chat trigger opens
// this card pre-filled with the extracted customer name; the owner picks the record and new status
// here. See docs/frontend/frontend.md Phase 4h.
export default function LogisticsManagementCard(props: {
  businessId: string;
  customerName?: string;
}) {
  const logisticsPath = `/businesses/${props.businessId}/logistics`;
  const invoicesPath = `/businesses/${props.businessId}/invoices`;
  const mutationRevision = useApiMutationRevision(logisticsPath, invoicesPath);
  const { isPending, runAction } = useAsyncActions();
  const [openDeliveries, setOpenDeliveries] = useState<LogisticsSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [logisticsId, setLogisticsId] = useState("");
  const [status, setStatus] = useState<FulfillmentStatus>("out_for_delivery");
  const [updated, setUpdated] = useState<LogisticsSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getJson<LogisticsSummary[]>(logisticsPath)
      .then((loaded) => {
        if (cancelled) return;
        const open = loaded.filter((item) => openStatuses.includes(item.status));
        setOpenDeliveries(open);
        const matched =
          props.customerName === undefined
            ? open[0]
            : (open.find(
                (item) => item.customerName?.toLowerCase() === props.customerName?.toLowerCase()
              ) ?? open[0]);
        if (matched !== undefined) {
          setLogisticsId(matched.id);
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [logisticsPath, mutationRevision, props.customerName]);

  async function record() {
    if (logisticsId === "") {
      setMessage("Choose a delivery.");
      return;
    }
    const result = await patchJson<LogisticsSummary>(
      `/businesses/${props.businessId}/logistics/${logisticsId}`,
      { status, note: "" }
    );
    setUpdated(result);
    setMessage(`${result.invoiceNumber} marked ${result.status.replace(/_/g, " ")}`);
  }

  if (openDeliveries === null) {
    return (
      <section className="record-form logistics-management-card" aria-label="Logistics">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading deliveries…</p>}
      </section>
    );
  }

  return (
    <section
      className="record-form logistics-management-card"
      aria-label="Update a delivery status"
    >
      <div className="section-heading">
        <p className="eyebrow">Logistics</p>
        <h3>Update a delivery from chat</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {updated === null ? (
        <>
          {openDeliveries.length === 0 ? (
            <p className="shell-note">No open deliveries.</p>
          ) : (
            <>
              <label>
                Delivery
                <select
                  value={logisticsId}
                  onChange={(event) => setLogisticsId(event.target.value)}
                >
                  {openDeliveries.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.invoiceNumber} · {item.customerName ?? "No customer"} ·{" "}
                      {item.status.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                New status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value as FulfillmentStatus)}
                >
                  {nextStatuses.map((option) => (
                    <option key={option} value={option}>
                      {option.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending("logistics-management-update")}
                  onClick={() =>
                    void runAction("logistics-management-update", async () => {
                      try {
                        await record();
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  Update status
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <p>
          <strong>Updated</strong>
          <br />
          {updated.invoiceNumber}: {updated.status.replace(/_/g, " ")}
        </p>
      )}
    </section>
  );
}
