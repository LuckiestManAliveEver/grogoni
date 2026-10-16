import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, RefreshCw, Send, X } from "lucide-react";
import type {
  PurchaseOrderReview,
  PurchaseOrderSnapshot,
  PurchaseOrderView,
  SupplierSummary
} from "@grogoni/shared-types";
import type { RuntimeTurnResult } from "./grogoni-application-shared";
import { fetchFreshJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { isExplicitOfflineMode } from "./offline-runtime";
import "./purchase-order-panel.css";

const statuses = {
  SUBMITTED_IN_APP: "Submitted to supplier inbox",
  DISPATCHING: "Delivery pending verification",
  PROVIDER_ACCEPTED: "Provider accepted; supplier response pending",
  DELIVERY_UNKNOWN: "Delivery unknown; do not resend",
  ACCEPTED: "Supplier accepted",
  REJECTED: "Supplier rejected"
};
const money = (value: number, currency: string) =>
  new Intl.NumberFormat("en-KE", { style: "currency", currency }).format(value / 100);
type Mailbox = { id: string; address: string; status: string; canSend: boolean };
type Approval = {
  businessId: string;
  token: string;
  sessionId: string;
  tool: "procurement.submit" | "procurement.respond";
  input: Record<string, unknown>;
  snapshot: PurchaseOrderSnapshot;
};

export default function PurchaseOrderPanel({
  businessId,
  suppliers
}: {
  businessId: string;
  suppliers: Pick<SupplierSummary, "id" | "name" | "email" | "phone">[];
}) {
  const id = useId();
  const base = `/businesses/${encodeURIComponent(businessId)}`;
  const offline = isExplicitOfflineMode();
  const epoch = useRef(0);
  const [data, setData] = useState<PurchaseOrderReview | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [selection, setSelection] = useState({
    draftId: "",
    channel: "grogoni",
    recipient: "",
    mailboxId: "",
    consent: false
  });
  useEffect(() => {
    const request = ++epoch.current;
    setApproval(null);
    setData(null);
    setError("");
    setMailboxes([]);
    if (offline) {
      setBusy(false);
      return;
    }
    setBusy(true);
    void Promise.all([
      fetchFreshJson<PurchaseOrderReview>(`${base}/runtime/procurement/orders`),
      fetchFreshJson<{ mailboxes: Mailbox[] }>(`${base}/mailboxes`).catch(() => ({ mailboxes: [] }))
    ])
      .then(([orders, loaded]) => {
        if (epoch.current !== request) return;
        if (
          !Array.isArray(orders.drafts) ||
          !Array.isArray(orders.incoming) ||
          !Array.isArray(orders.outgoing)
        )
          throw new Error("Purchase orders could not be verified.");
        setData(orders);
        setMailboxes(
          loaded.mailboxes.filter(
            (mailbox) =>
              mailbox.status === "connected" &&
              mailbox.canSend &&
              orders.emailMailboxIds?.includes(mailbox.id)
          )
        );
      })
      .catch((cause) => {
        if (epoch.current === request) setError(getUserFacingErrorMessage(cause));
      })
      .finally(() => {
        if (epoch.current === request) setBusy(false);
      });
    return () => {
      ++epoch.current;
    };
  }, [base, offline, reload]);

  async function propose(
    tool: Approval["tool"],
    input: Record<string, unknown>,
    snapshot: PurchaseOrderSnapshot
  ) {
    if (busy || offline || approval) return;
    const request = epoch.current;
    setBusy(true);
    setError("");
    try {
      const result = await postJson<RuntimeTurnResult>(`${base}/runtime/turns`, {
        message: `#${tool} ${JSON.stringify(input)}`
      });
      if (epoch.current !== request) return;
      if (
        result.session.businessId !== businessId ||
        result.turn.status !== "needs_confirmation" ||
        result.turn.plan.toolName !== tool ||
        !result.turn.plan.confirmationToken ||
        Object.keys(result.turn.plan.input).length !== Object.keys(input).length ||
        !Object.entries(input).every(([key, value]) => result.turn.plan.input[key] === value)
      )
        throw new Error("The exact order approval could not be verified. Nothing was approved.");
      setApproval({
        businessId,
        token: result.turn.plan.confirmationToken,
        sessionId: result.session.id,
        tool,
        input,
        snapshot
      });
    } catch (cause) {
      if (epoch.current === request) setError(getUserFacingErrorMessage(cause));
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  }
  async function decide(accept: boolean) {
    if (!approval || busy || offline || approval.businessId !== businessId) return;
    const request = epoch.current;
    setBusy(true);
    setError("");
    try {
      if (!accept) {
        const response = await postJson<{ status: string }>(`${base}/runtime/approvals/reject`, {
          runtimeSessionId: approval.sessionId,
          confirmationToken: approval.token
        });
        if (response.status !== "REJECTED") throw new Error("Rejection was not acknowledged.");
      } else {
        const result = await postJson<RuntimeTurnResult>(`${base}/runtime/turns`, {
          runtimeSessionId: approval.sessionId,
          confirmationToken: approval.token,
          message: "confirm"
        });
        if (epoch.current !== request) return;
        if (result.turn.status !== "completed")
          throw new Error("Order execution is incomplete. Refresh before taking another action.");
        const committed = await fetchFreshJson<PurchaseOrderReview>(
          `${base}/runtime/procurement/orders`
        );
        if (epoch.current !== request) return;
        const found =
          approval.tool === "procurement.submit"
            ? committed.outgoing.some(
                (order) =>
                  order.draft_id === approval.input.draftId &&
                  order.channel === approval.input.channel &&
                  order.recipient === approval.input.recipient
              )
            : committed.incoming.some(
                (order) =>
                  order.order_id === approval.input.orderId &&
                  order.status === approval.input.decision &&
                  order.revision === Number(approval.input.revision) + 1
              );
        if (!found)
          throw new Error(
            "The committed order result could not be verified. Do not resend; refresh the order list."
          );
        setData(committed);
      }
      if (epoch.current === request) setApproval(null);
    } catch (cause) {
      if (epoch.current === request) {
        setApproval(null);
        setError(getUserFacingErrorMessage(cause));
      }
    } finally {
      if (epoch.current === request) setBusy(false);
    }
  }
  const draft = data?.drafts.find((item) => item.id === selection.draftId);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    void propose(
      "procurement.submit",
      {
        draftId: draft.id,
        draftDigest: draft.digest,
        channel: selection.channel,
        recipient: selection.recipient,
        ...(selection.channel === "email" ? { mailboxId: selection.mailboxId } : {}),
        ...(selection.channel !== "grogoni" ? { optInConfirmed: selection.consent } : {})
      },
      draft
    );
  }
  const lines = (snapshot: PurchaseOrderSnapshot) => (
    <>
      <ul>
        {snapshot.items.map((item) => (
          <li key={item.productId}>
            {item.productId}: {item.quantityMilli / 1000} {item.unit}{" "}
            <span>{money(item.totalMinor, snapshot.currency)}</span>
          </li>
        ))}
      </ul>
      <strong>{money(snapshot.totalMinor, snapshot.currency)}</strong>
    </>
  );
  function orderRow(order: PurchaseOrderView, incoming: boolean) {
    return (
      <li key={order.order_id} className="purchase-order-row">
        <div>
          <strong>Order {order.order_id.slice(0, 8)}</strong>
          <p>{statuses[order.status]}</p>
          <p>{incoming ? `Buyer ${order.business_id}` : `${order.channel}: ${order.recipient}`}</p>
          {lines(order.snapshot)}
        </div>
        {incoming && order.status === "SUBMITTED_IN_APP" && (
          <div className="row-actions">
            <button
              disabled={busy || !!approval}
              onClick={() =>
                void propose(
                  "procurement.respond",
                  { orderId: order.order_id, revision: order.revision, decision: "ACCEPTED" },
                  order.snapshot
                )
              }
            >
              <Check size={16} />
              Review acceptance
            </button>
            <button
              disabled={busy || !!approval}
              onClick={() =>
                void propose(
                  "procurement.respond",
                  { orderId: order.order_id, revision: order.revision, decision: "REJECTED" },
                  order.snapshot
                )
              }
            >
              <X size={16} />
              Review rejection
            </button>
          </div>
        )}
      </li>
    );
  }
  return (
    <section className="purchase-order-panel" aria-label="Purchase orders">
      <div className="section-heading">
        <h3>Purchase orders</h3>
        <button
          type="button"
          aria-label="Refresh purchase orders"
          title="Refresh purchase orders"
          disabled={busy || offline || !!approval}
          onClick={() => setReload((value) => value + 1)}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {offline ? (
        <p>Purchase orders are unavailable offline.</p>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Loading purchase orders...</p>}
          {approval ? (
            <div className="purchase-order-approval" aria-label="Review purchase order approval">
              <h4>
                {approval.tool === "procurement.submit"
                  ? "Submit purchase order"
                  : `${approval.input.decision === "ACCEPTED" ? "Accept" : "Reject"} purchase order`}
              </h4>
              {lines(approval.snapshot)}
              <p>
                {String(approval.input.channel ?? "Supplier response")}:{" "}
                {String(approval.input.recipient ?? approval.input.orderId)}
              </p>
              {typeof approval.input.mailboxId === "string" && (
                <p>
                  From:{" "}
                  {mailboxes.find((mailbox) => mailbox.id === approval.input.mailboxId)?.address ??
                    approval.input.mailboxId}
                </p>
              )}
              <div className="row-actions">
                <button disabled={busy} onClick={() => void decide(true)}>
                  <Check size={16} />
                  Approve
                </button>
                <button disabled={busy} onClick={() => void decide(false)}>
                  <X size={16} />
                  Reject approval
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label htmlFor={`${id}-draft`}>Prepared draft</label>
              <select
                id={`${id}-draft`}
                required
                disabled={busy}
                value={selection.draftId}
                onChange={(event) =>
                  setSelection({
                    ...selection,
                    draftId: event.target.value,
                    recipient: "",
                    consent: false
                  })
                }
              >
                <option value="">Choose draft</option>
                {data?.drafts
                  .filter((item) => !data.outgoing.some((order) => order.draft_id === item.id))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {suppliers.find((supplier) => supplier.id === item.supplierId)?.name ??
                        item.supplierId}{" "}
                      - {money(item.totalMinor, item.currency)}
                    </option>
                  ))}
              </select>
              {draft && <div className="purchase-order-lines">{lines(draft)}</div>}
              <label htmlFor={`${id}-channel`}>Delivery channel</label>
              <select
                id={`${id}-channel`}
                disabled={busy}
                value={selection.channel}
                onChange={(event) => {
                  const channel = event.target.value;
                  const supplier = suppliers.find((item) => item.id === draft?.supplierId);
                  setSelection({
                    ...selection,
                    channel,
                    recipient:
                      channel === "email"
                        ? (supplier?.email ?? "")
                        : channel === "whatsapp"
                          ? (supplier?.phone ?? "")
                          : "",
                    consent: false
                  });
                }}
              >
                <option value="grogoni">GroGoni supplier inbox</option>
                <option value="email" disabled={!mailboxes.length}>
                  Email{!mailboxes.length ? " (unavailable)" : ""}
                </option>
                <option value="whatsapp" disabled={!data?.whatsappAvailable}>
                  WhatsApp{!data?.whatsappAvailable ? " (unavailable)" : ""}
                </option>
              </select>
              <label htmlFor={`${id}-recipient`}>
                {selection.channel === "grogoni"
                  ? "Linked supplier business ID"
                  : selection.channel === "email"
                    ? "Supplier email"
                    : "Supplier WhatsApp number"}
              </label>
              {selection.channel === "grogoni" ? (
                <select
                  id={`${id}-recipient`}
                  required
                  disabled={busy}
                  value={selection.recipient}
                  onChange={(event) =>
                    setSelection({ ...selection, recipient: event.target.value })
                  }
                >
                  <option value="">Choose linked supplier business</option>
                  {data?.recipients
                    ?.filter((recipient) => recipient.supplierId === draft?.supplierId)
                    .map((recipient) => (
                      <option key={recipient.businessId} value={recipient.businessId}>
                        {recipient.name}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  id={`${id}-recipient`}
                  required
                  disabled={busy}
                  type={selection.channel === "email" ? "email" : "text"}
                  maxLength={254}
                  value={selection.recipient}
                  onChange={(event) =>
                    setSelection({ ...selection, recipient: event.target.value })
                  }
                />
              )}
              {selection.channel === "email" && (
                <>
                  <label htmlFor={`${id}-mailbox`}>Sending mailbox</label>
                  <select
                    id={`${id}-mailbox`}
                    required
                    disabled={busy}
                    value={selection.mailboxId}
                    onChange={(event) =>
                      setSelection({ ...selection, mailboxId: event.target.value })
                    }
                  >
                    <option value="">Choose mailbox</option>
                    {mailboxes.map((mailbox) => (
                      <option key={mailbox.id} value={mailbox.id}>
                        {mailbox.address}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {selection.channel !== "grogoni" && (
                <label className="purchase-order-consent">
                  <input
                    type="checkbox"
                    required
                    disabled={busy}
                    checked={selection.consent}
                    onChange={(event) =>
                      setSelection({ ...selection, consent: event.target.checked })
                    }
                  />
                  Supplier consent to this channel is confirmed
                </label>
              )}
              <button type="submit" disabled={busy || !draft}>
                <Send size={16} />
                Review submission
              </button>
            </form>
          )}
          <h4>Outgoing</h4>
          <ul className="purchase-order-list">
            {data?.outgoing.map((order) => orderRow(order, false))}
          </ul>
          {data && !data.outgoing.length && <p>No submitted orders.</p>}
          <h4>Supplier inbox</h4>
          <ul className="purchase-order-list">
            {data?.incoming.map((order) => orderRow(order, true))}
          </ul>
          {data && !data.incoming.length && <p>No incoming orders.</p>}
        </>
      )}
    </section>
  );
}
