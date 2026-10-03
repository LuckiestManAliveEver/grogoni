import {
  type FulfillmentStatus,
  type InvoiceSummary,
  type LogisticsFormState,
  type LogisticsSummary
} from "./grogoni-application-shared";
import CorridorDispatchCard from "./CorridorDispatchCard";
import DeliveryRoutesCard from "./DeliveryRoutesCard";
import FulfillmentSetupCard from "./FulfillmentSetupCard";
import DriverManifestsCard from "./DriverManifestsCard";
import { fulfillmentCopy } from "./fulfillment-copy";

export interface LogisticsSurfaceProps {
  businessId: string;
  /**
   * The viewer's permissions (display only: which cards to show); the server authorizes. Empty
   * while unknown, in which case every card is shown as before.
   */
  viewerPermissions: readonly string[];
  invoices: InvoiceSummary[];
  logistics: LogisticsSummary[];
  form: LogisticsFormState;
  onFormChange: (form: LogisticsFormState) => void;
  onCreate: () => void;
  onStatusChange: (logisticsId: string, status: FulfillmentStatus) => void;
  onRefresh: () => void;
}

export function LogisticsSurface(props: LogisticsSurfaceProps) {
  const linkedInvoiceIds = new Set(props.logistics.map((item) => item.invoiceId));
  const availableInvoices = props.invoices.filter(
    (invoice) => invoice.status === "confirmed" && !linkedInvoiceIds.has(invoice.id)
  );
  const activeCount = props.logistics.filter(
    (item) => item.status !== "completed" && item.status !== "cancelled"
  ).length;

  const known = props.viewerPermissions.length > 0;
  const can = (permission: string) => !known || props.viewerPermissions.includes(permission);
  // A driver records deliveries but does not dispatch: their Logistics is "My deliveries" only.
  const deliversOnly =
    known &&
    props.viewerPermissions.includes("delivery:record") &&
    !props.viewerPermissions.includes("fulfillment:dispatch");

  // Nothing here for this role (for example view only): say so instead of an empty page.
  const noAccess =
    known &&
    !props.viewerPermissions.includes("logistics:read") &&
    !props.viewerPermissions.includes("delivery:record") &&
    !props.viewerPermissions.includes("fulfillment:read");

  return (
    <div className="records-surface">
      {noAccess ? <p className="shell-note">{fulfillmentCopy().noLogisticsAccess}</p> : null}
      <DriverManifestsCard businessId={props.businessId} showEmptyState={deliversOnly} />
      <FulfillmentSetupCard businessId={props.businessId} />
      <CorridorDispatchCard businessId={props.businessId} />
      {can("logistics:read") ? <DeliveryRoutesCard businessId={props.businessId} /> : null}
      {can("logistics:read") ? (
        <>
          {can("logistics:write") ? (
            <section className="record-form" aria-label="Logistics form">
              <div className="section-heading">
                <p className="eyebrow">Logistics</p>
                <h3>Create fulfillment</h3>
              </div>
              <label>
                Confirmed invoice
                <select
                  value={props.form.invoiceId}
                  onChange={(event) =>
                    props.onFormChange({ ...props.form, invoiceId: event.target.value })
                  }
                >
                  <option value="">Select invoice</option>
                  {availableInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoiceNumber} - {invoice.customerName ?? "Walk-in customer"}
                    </option>
                  ))}
                </select>
              </label>
              <div className="segmented" aria-label="Fulfillment method">
                <button
                  className={props.form.method === "delivery" ? "active" : ""}
                  type="button"
                  onClick={() => props.onFormChange({ ...props.form, method: "delivery" })}
                >
                  Delivery
                </button>
                <button
                  className={props.form.method === "pickup" ? "active" : ""}
                  type="button"
                  onClick={() => props.onFormChange({ ...props.form, method: "pickup" })}
                >
                  Pickup
                </button>
              </div>
              <label>
                Destination
                <input
                  value={props.form.destination}
                  onChange={(event) =>
                    props.onFormChange({ ...props.form, destination: event.target.value })
                  }
                />
              </label>
              <label>
                Note
                <input
                  value={props.form.note}
                  onChange={(event) =>
                    props.onFormChange({ ...props.form, note: event.target.value })
                  }
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  onClick={props.onCreate}
                  disabled={props.form.invoiceId === ""}
                >
                  Create
                </button>
                <button className="secondary" type="button" onClick={props.onRefresh}>
                  Refresh
                </button>
              </div>
            </section>
          ) : null}

          <section className="record-list" aria-label="Logistics records">
            <div className="section-heading">
              <p className="eyebrow">{activeCount} active</p>
              <h3>Fulfillment work</h3>
            </div>
            {props.logistics.length === 0 ? (
              <div className="empty-record">
                <h3>No logistics yet</h3>
                <p>Create fulfillment work from a confirmed invoice.</p>
              </div>
            ) : (
              props.logistics.map((item) => (
                <article className="record-row logistics-row" key={item.id}>
                  <div>
                    <strong>
                      {item.invoiceNumber} - {item.status.replaceAll("_", " ")}
                    </strong>
                    <span>
                      {item.method} - {item.customerName ?? "Walk-in customer"}
                      {item.destination === null ? "" : ` - ${item.destination}`}
                    </span>
                  </div>
                  <div className="compact-actions">
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => props.onStatusChange(item.id, "ready")}
                      disabled={item.status !== "pending"}
                    >
                      Ready
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => props.onStatusChange(item.id, "out_for_delivery")}
                      disabled={item.method !== "delivery" || item.status !== "ready"}
                    >
                      Dispatch
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onStatusChange(item.id, "completed")}
                      disabled={
                        item.status === "completed" ||
                        item.status === "cancelled" ||
                        (item.method === "delivery" && item.status !== "out_for_delivery") ||
                        (item.method === "pickup" && item.status !== "ready")
                      }
                    >
                      Complete
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => props.onStatusChange(item.id, "cancelled")}
                      disabled={item.status === "completed" || item.status === "cancelled"}
                    >
                      Back
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
