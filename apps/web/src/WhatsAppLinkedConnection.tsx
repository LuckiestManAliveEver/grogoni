import { useEffect, useRef, useState } from "react";
import { isWhatsAppLinkInProgress, type WhatsAppLinkedState } from "@grogoni/shared-types";
import { fetchFreshJson, postJson, deleteJson } from "./api-helpers";
import { deviceMessagingAdapter, isNativeDeviceHost } from "./device-messaging";
import { getUserFacingErrorMessage } from "./user-facing-error";

interface Connection {
  enabled: boolean;
  /** STATUS_UNAVAILABLE is the client's own: the last poll failed, so the state is unknown. */
  state: WhatsAppLinkedState | "STATUS_UNAVAILABLE";
  pairingCode: string | null;
  expiresAt: string | null;
  scopes: { chat: string; conversationId: string; automation?: boolean }[];
  automationAvailable?: boolean;
}
const toolLabels: Record<string, string> = {
  "products.list": "Search catalogue and stock",
  "product.create": "Prepare new catalogue records",
  "product.update": "Prepare catalogue changes",
  "product.stock_adjust": "Prepare stock adjustments",
  "invoice.draft": "Prepare quotations and invoices",
  "invoices.list": "Read business invoices",
  "logistics.update_status": "Prepare delivery updates",
  "procurement.quote.record": "Prepare supplier quotations",
  "procurement.prepare": "Prepare procurement requests",
  "procurement.submit": "Prepare procurement submissions",
  "procurement.respond": "Prepare procurement responses",
  "sale.record": "Prepare sales records",
  "sales.history": "Read sales history",
  "purchase.record": "Prepare purchase records",
  "purchase.history": "Read purchase history"
};
// Read capabilities run without a per-request owner approval, so granting one hands the data to the
// WhatsApp side. Each entry names exactly what becomes visible to them.
const readToolExposure: Record<string, string> = {
  "products.list": "your catalogue, prices and stock levels",
  "invoices.list": "your invoices, including customer names and amounts",
  "sales.history": "your sales history",
  "purchase.history": "your purchase history, including suppliers and costs"
};
const labels: Record<Connection["state"], string> = {
  DISCONNECTED: "Disconnected",
  PAIRING: "Waiting for WhatsApp approval",
  CONNECTING: "Connecting",
  CONNECTED: "Connected",
  RECONNECTING: "Reconnecting",
  AUTH_REQUIRED: "Authorization required",
  REVOKED: "Authorization required",
  SUSPENDED: "Paused",
  ERROR: "Connection needs attention",
  STATUS_UNAVAILABLE: "Connection status unavailable"
};
export default function WhatsAppLinkedConnection({
  businessId,
  startup = false
}: {
  businessId: string;
  startup?: boolean;
}) {
  const previousState = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installed, setInstalled] = useState(false);
  const [chat, setChat] = useState("");
  const [permissions, setPermissions] = useState<{
    chat: string;
    choices: string[];
    selected: string[];
    granted: string[];
  } | null>(null);
  const [grantConsent, setGrantConsent] = useState(false);
  const [notice, setNotice] = useState("");
  const [groups, setGroups] = useState<Array<{ chat: string; name: string }>>([]);
  const base = `/businesses/${encodeURIComponent(businessId)}/channels/whatsapp-linked`;
  useEffect(() => {
    let current = true;
    let poll = false;
    let timer: number | undefined;
    previousState.current = null;
    setConnection(null);
    setExpanded(false);
    setDismissed(false);
    setPhone("");
    setConsent(false);
    setError("");
    setChat("");
    setGroups([]);
    setPermissions(null);
    setGrantConsent(false);
    setNotice("");
    setInstalled(false);
    async function refresh() {
      try {
        const result = await fetchFreshJson<Connection>(base);
        poll = result.enabled;
        if (current) {
          setConnection(result);
          if (
            startup &&
            result.state === "CONNECTED" &&
            isWhatsAppLinkInProgress(previousState.current ?? "")
          )
            setExpanded(false);
          previousState.current = result.state;
        }
      } catch {
        if (current && poll)
          setConnection((previous) =>
            previous
              ? { ...previous, state: "STATUS_UNAVAILABLE", pairingCode: null, expiresAt: null }
              : null
          );
      } finally {
        if (current && poll)
          timer = window.setTimeout(() => {
            if (document.visibilityState === "visible") void refresh();
            else timer = window.setTimeout(() => void refresh(), 10_000);
          }, 5000);
      }
    }
    void refresh();
    if (isNativeDeviceHost())
      void deviceMessagingAdapter
        .call<{ available: boolean }>("whatsappAvailability")
        .then((result) => {
          if (current) setInstalled(result.available);
        })
        .catch(() => undefined);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [base, startup]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      setConnection(
        await postJson<Connection>(
          `${base}/connect`,
          {
            consent,
            phone: phone.replace(/^\+/, "") || undefined
          },
          { timeoutMs: 45_000 }
        )
      );
    } catch (failure) {
      setError(getUserFacingErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function scope(value: string, approved: boolean, automation = false) {
    setBusy(true);
    setError("");
    try {
      setConnection(
        await postJson<Connection>(`${base}/scopes`, {
          chat: /^\+?[1-9][0-9]{6,14}$/.test(value.trim())
            ? `${value.trim().replace(/^\+/, "")}@s.whatsapp.net`
            : value.trim(),
          approved,
          automation
        })
      );
      setChat("");
    } catch (failure) {
      setError(getUserFacingErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      const result = await deleteJson<Connection>(base);
      setConnection(result);
      setPhone("");
      setConsent(false);
    } catch (failure) {
      setError(getUserFacingErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const group = permissions?.chat.endsWith("@g.us") ?? false;
  const audience = group ? "everyone in this WhatsApp group" : "this WhatsApp contact";
  const exposed = (permissions?.selected ?? []).flatMap((tool) =>
    readToolExposure[tool] ? [readToolExposure[tool]] : []
  );
  function saveTools(tools: string[], success: string) {
    if (!permissions) return;
    setBusy(true);
    setError("");
    setNotice("");
    // Revoking narrows access, so it needs no fresh approval; the server still requires the flag.
    void postJson(`${base}/tools`, { chat: permissions.chat, tools, consent: true })
      .then(() => {
        setPermissions(null);
        setGrantConsent(false);
        setNotice(success);
      })
      .catch((failure) => setError(getUserFacingErrorMessage(failure)))
      .finally(() => setBusy(false));
  }
  if (!connection?.enabled || (startup && (!installed || dismissed))) return null;
  if (startup && !expanded && !isWhatsAppLinkInProgress(connection.state))
    return (
      <aside aria-label="WhatsApp connection" className="record-form">
        <span>
          {connection.state === "DISCONNECTED"
            ? "WhatsApp is available on this phone."
            : `WhatsApp · ${labels[connection.state] ?? "Connection needs attention"}`}
        </span>{" "}
        <button type="button" onClick={() => setExpanded(true)}>
          {connection.state === "DISCONNECTED" ? "Connect WhatsApp" : "Manage WhatsApp"}
        </button>{" "}
        {connection.state === "DISCONNECTED" ? (
          <button type="button" onClick={() => setDismissed(true)}>
            Not now
          </button>
        ) : null}
      </aside>
    );
  const pairing = isWhatsAppLinkInProgress(connection.state);
  return (
    <section aria-label="WhatsApp Linked Devices" className="record-form">
      {startup ? (
        <button type="button" onClick={() => setExpanded(false)}>
          Back to conversation
        </button>
      ) : null}
      <h4>WhatsApp · {labels[connection.state] ?? "Disconnected"}</h4>
      {installed ? <p>WhatsApp is available on this phone.</p> : null}
      {connection.state !== "CONNECTED" && !pairing ? (
        <>
          <label>
            WhatsApp number, including country code
            <input
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="254…"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I own this WhatsApp account and approve linking. This unofficial connection can stop
            working or put my account at risk. Encrypted device credentials are stored on this
            Grogoni host. Only conversations I approve will be imported; automatic replies stay off.
          </label>
          <button type="button" disabled={busy || !consent} onClick={() => void connect()}>
            Connect WhatsApp
          </button>
        </>
      ) : null}
      {connection.pairingCode ? (
        <div role="status">
          <p>
            Pairing code: <strong>{connection.pairingCode}</strong>
          </p>
          <p>
            In WhatsApp, open Linked devices → Link a device → Link with phone number. Approve this
            code before it expires.
          </p>
          {installed ? (
            <button
              type="button"
              onClick={() =>
                void deviceMessagingAdapter
                  .call("openWhatsApp")
                  .catch((failure) => setError(getUserFacingErrorMessage(failure)))
              }
            >
              Open WhatsApp
            </button>
          ) : null}
        </div>
      ) : null}
      {connection.state === "CONNECTED" ? (
        <details>
          <summary>Advanced conversation approvals</summary>
          <p>
            Only approved conversations enter your inbox. Assistant replies require separate
            approval and stay off until enabled. Approved attachments may be read by your selected
            AI. Business records and tools require separate permissions below. In groups, mention
            the linked account, start with “Grogoni”, or reply to an assistant message.
          </p>
          {installed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void deviceMessagingAdapter
                  .call<{ phone?: string; cancelled?: boolean }>("pickWhatsAppContact")
                  .then((result) => {
                    if (result.phone) setChat(result.phone.replace(/[ ()-]/g, ""));
                  })
                  .catch((failure) => setError(getUserFacingErrorMessage(failure)))
              }
            >
              Choose a contact
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void fetchFreshJson<{ groups: Array<{ chat: string; name: string }> }>(
                `${base}/groups`
              )
                .then((result) => setGroups(result.groups))
                .catch((failure) => setError(getUserFacingErrorMessage(failure)))
                .finally(() => setBusy(false));
            }}
          >
            Choose a WhatsApp group
          </button>
          {groups.length ? (
            <label>
              Group
              <select
                value={groups.some((group) => group.chat === chat) ? chat : ""}
                onChange={(event) => setChat(event.target.value)}
              >
                <option value="">Choose a group</option>
                {groups.map((group) => (
                  <option key={group.chat} value={group.chat}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Contact number including country code, or group identifier
            <input
              value={chat}
              onChange={(event) => setChat(event.target.value)}
              placeholder="+254…"
            />
          </label>
          <button type="button" disabled={busy || !chat} onClick={() => void scope(chat, true)}>
            Approve conversation
          </button>
          <ul>
            {connection.scopes.map((item) => (
              <li key={item.chat}>
                {item.chat}{" "}
                {connection.automationAvailable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void scope(item.chat, true, !item.automation)}
                  >
                    {item.automation ? "Pause assistant replies" : "Enable assistant replies"}
                  </button>
                ) : null}
                {item.automation ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      setError("");
                      setNotice("");
                      void fetchFreshJson<{
                        choices: string[];
                        grants: Array<{ chat: string; grant: { tools: string[] } | null }>;
                      }>(`${base}/tools`)
                        .then((result) => {
                          const granted =
                            result.grants.find((grant) => grant.chat === item.chat)?.grant?.tools ??
                            [];
                          setGrantConsent(false);
                          setPermissions({
                            chat: item.chat,
                            choices: result.choices,
                            selected: granted,
                            granted
                          });
                        })
                        .catch((failure) => setError(getUserFacingErrorMessage(failure)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Business permissions
                  </button>
                ) : null}
                <button type="button" disabled={busy} onClick={() => void scope(item.chat, false)}>
                  Remove approval
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {permissions ? (
        <fieldset disabled={busy}>
          <legend>Business permissions for this conversation</legend>
          <p>
            These capabilities may reveal business records to the approved contact
            {group ? " and every participant in this group" : ""}. Only select what they need.
            Changes they request wait for your confirmation in Grogoni; reading records does not.
            Removing a capability also cancels its pending approval.
          </p>
          {permissions.choices.map((tool) => (
            <label key={tool}>
              <input
                type="checkbox"
                checked={permissions.selected.includes(tool)}
                onChange={(event) => {
                  setGrantConsent(false);
                  setPermissions((current) =>
                    current
                      ? {
                          ...current,
                          selected: event.target.checked
                            ? [...current.selected, tool]
                            : current.selected.filter((value) => value !== tool)
                        }
                      : null
                  );
                }}
              />
              {toolLabels[tool] ?? "Business capability"}
              {readToolExposure[tool] ? (
                <small>
                  {" "}
                  Read access: {audience} can see {readToolExposure[tool]}.
                </small>
              ) : null}
            </label>
          ))}
          {exposed.length ? (
            <p className="whatsapp-read-warning" aria-live="polite">
              <strong>Warning:</strong> {audience} will be able to see {exposed.join("; ")} whenever
              they ask on WhatsApp, without asking you first.
            </p>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={grantConsent}
              onChange={(event) => setGrantConsent(event.target.checked)}
            />
            I approve giving {audience} the selected capabilities.
          </label>
          <button
            type="button"
            disabled={!grantConsent || !permissions.selected.length}
            onClick={() => saveTools(permissions.selected, "Business permissions saved.")}
          >
            Allow selected capabilities
          </button>
          {permissions.granted.length ? (
            <button type="button" onClick={() => saveTools([], "Business permissions removed.")}>
              Remove all capabilities
            </button>
          ) : null}
          <button type="button" onClick={() => setPermissions(null)}>
            Cancel
          </button>
        </fieldset>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {connection.state !== "DISCONNECTED" ? (
        <button type="button" disabled={busy} onClick={() => void disconnect()}>
          Disconnect and delete credentials
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
