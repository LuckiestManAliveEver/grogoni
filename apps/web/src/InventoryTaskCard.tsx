import { useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw, X } from "lucide-react";
import type { BusinessExecutionTaskView } from "@grogoni/shared-types";
import { fetchFreshJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import "./inventory-task-card.css";

const labels: Record<BusinessExecutionTaskView["status"], string> = {
  CREATED: "Queued",
  READY: "Ready",
  RUNNING: "Preparing",
  AWAITING_APPROVAL: "Awaiting approval",
  VERIFYING: "Checking drafts",
  COMPLETED: "Drafts verified",
  FAILED: "Failed",
  SUSPENDED: "Paused",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  INCOMPLETE: "Incomplete"
};
const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
const money = (minor: number, currency: string) =>
  new Intl.NumberFormat("en-KE", { style: "currency", currency }).format(minor / 100);

export default function InventoryTaskCard({
  businessId,
  taskId
}: {
  businessId: string;
  taskId: string;
}) {
  const path = `/businesses/${encodeURIComponent(businessId)}/runtime/tasks/${encodeURIComponent(taskId)}`;
  const [task, setTask] = useState<BusinessExecutionTaskView | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setPending(true);
    setError("");
    void fetchFreshJson<BusinessExecutionTaskView>(`${path}/view`)
      .then((value) => {
        if (generation.current !== request) return;
        if (value.taskId !== taskId || value.businessId !== businessId)
          throw new Error("Task scope mismatch.");
        setTask(value);
      })
      .catch((cause) => {
        if (generation.current !== request) return;
        setTask(null);
        setError(getUserFacingErrorMessage(cause));
      })
      .finally(() => {
        if (generation.current === request) setPending(false);
      });
    return () => {
      ++generation.current;
    };
  }, [path, taskId, businessId, reload]);

  async function control(command: "SUSPEND" | "RESUME" | "CANCEL") {
    if (!task || pending) return;
    if (
      command === "CANCEL" &&
      !window.confirm("Cancel this task? Existing drafts will remain unsubmitted.")
    )
      return;
    const request = ++generation.current;
    setPending(true);
    setError("");
    try {
      const value = await postJson<BusinessExecutionTaskView>(`${path}/control`, {
        command,
        revision: task.revision
      });
      if (generation.current !== request) return;
      if (value.taskId !== taskId || value.businessId !== businessId)
        throw new Error("Task scope mismatch.");
      setTask(value);
    } catch (cause) {
      if (generation.current !== request) return;
      setTask(null);
      setError(getUserFacingErrorMessage(cause));
    } finally {
      if (generation.current === request) setPending(false);
    }
  }

  return (
    <section
      className="inventory-task-card"
      aria-label="Inventory replenishment task"
      aria-busy={pending}
    >
      <header>
        <h3>Inventory replenishment</h3>
        <button
          type="button"
          className="inventory-task-icon"
          title="Refresh task"
          aria-label="Refresh task"
          disabled={pending}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={18} />
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!task && pending && <p role="status">Loading task...</p>}
      {task && (
        <>
          <p role="status" className="inventory-task-state">
            {labels[task.status]}
          </p>
          <p className="inventory-task-objective">{task.objective}</p>
          <dl className="inventory-task-facts">
            <div>
              <dt>Budget</dt>
              <dd>
                {task.budgetMinor === null
                  ? "Not specified"
                  : money(task.budgetMinor, task.currency ?? "KES")}
              </dd>
            </div>
            <div>
              <dt>Stock horizon</dt>
              <dd>{task.horizonDays === null ? "Not specified" : `${task.horizonDays} days`}</dd>
            </div>
            <div>
              <dt>Verification</dt>
              <dd>
                {
                  {
                    PASSED: "Passed",
                    FAILED: "Failed",
                    INCONCLUSIVE: "Inconclusive",
                    NOT_VERIFIED: "Not verified"
                  }[task.verificationStatus]
                }
              </dd>
            </div>
          </dl>
          {task.reason && <p>{task.reason}</p>}
          {task.issues.length > 0 && (
            <ul className="inventory-task-issues">
              {task.issues.map((issue, index) => (
                <li key={index}>
                  {issue.productName && <strong>{issue.productName}: </strong>}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
          {task.orders.length > 0 && (
            <div className="inventory-task-orders">
              <h4>Purchase drafts</h4>
              <p>
                Not submitted. Supplier submission requires separate approval and is not connected.
              </p>
              {task.orders.map((order) => (
                <details key={order.id} open>
                  <summary>
                    <span>{order.supplierName}</span>
                    <strong>{money(order.totalMinor, order.currency)}</strong>
                  </summary>
                  <ul>
                    {order.items.map((item, index) => (
                      <li key={index}>
                        <span>
                          {item.productName}
                          <small>
                            {new Intl.NumberFormat("en-KE", { maximumFractionDigits: 3 }).format(
                              item.quantityMilli / 1000
                            )}{" "}
                            {item.unit}
                          </small>
                        </span>
                        <span>{money(item.totalMinor, order.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          )}
          {task.evaluation && (
            <p className="inventory-task-outcome">
              {task.evaluation.outcomeStatus === "PENDING"
                ? "Business outcome pending. Stockout reduction and forecast accuracy are not yet measured."
                : task.evaluation.outcomeStatus === "FAILED"
                  ? "Outcome evaluation failed."
                  : task.evaluation.outcomeStatus === "INCONCLUSIVE"
                    ? "Outcome evaluation inconclusive."
                    : "Execution outcome verified."}
            </p>
          )}
          {!terminal.has(task.status) && (
            <footer>
              {task.status === "SUSPENDED" || task.status === "INCOMPLETE" ? (
                <button type="button" disabled={pending} onClick={() => void control("RESUME")}>
                  <Play size={16} />
                  Resume
                </button>
              ) : (
                <button type="button" disabled={pending} onClick={() => void control("SUSPEND")}>
                  <Pause size={16} />
                  Pause
                </button>
              )}
              <button type="button" disabled={pending} onClick={() => void control("CANCEL")}>
                <X size={16} />
                Cancel task
              </button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
