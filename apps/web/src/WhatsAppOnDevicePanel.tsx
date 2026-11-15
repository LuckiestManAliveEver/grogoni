import { useEffect, useRef, useState } from "react";
import { fetchFreshJson } from "./api-helpers";
import { deviceMessagingAdapter } from "./device-messaging";
import { getUserFacingErrorMessage } from "./user-facing-error";

/**
 * "Run WhatsApp on this phone": the owner's linked WhatsApp session hosted by the Android app's
 * on-device worker (docs/architecture/whatsapp-linked-devices.md, "Android sidecar"). Shown only
 * inside the Android app. Every action goes through the native whatsappLocal* bridge methods in
 * WhatsAppSidecarBridge.kt; the page never sees the worker's port, token or keys. The Grogoni API
 * side (`.../device/status`) says whether this host accepts a phone-hosted session and how many
 * replies wait for the phone.
 */

interface LocalConnection {
  state: string;
  pairingCode?: string | null;
  scopes?: Array<{ chat: string; conversationId: string }>;
}

interface LocalStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  blockedReason: string | null;
  connection: LocalConnection | null;
}

interface ServerStatus {
  enabled: boolean;
  host: string | null;
  status: string;
  waiting: number;
  uncertain: number;
}

const blockedText: Record<string, string> = {
  sdk_unsupported: "WhatsApp on this phone needs Android 7.0 or newer.",
  abi_unsupported:
    "This phone's processor cannot run the WhatsApp worker. Use Grogoni on a 64-bit phone or a Grogoni server.",
  runtime_missing: "This version of the app does not include the WhatsApp worker. Update Grogoni.",
  signed_out: "Sign in to Grogoni first."
};

const stateText: Record<string, string> = {
  DISCONNECTED: "Not linked yet",
  PAIRING: "Waiting for you to approve the code in WhatsApp",
  CONNECTING: "Connecting",
  CONNECTED: "Connected on this phone",
  RECONNECTING: "Reconnecting",
  AUTH_REQUIRED: "WhatsApp asks you to link again",
  REVOKED: "Unlinked in WhatsApp. Link again to continue",
  SUSPENDED: "Paused",
  ERROR: "Needs attention. It retries in a few minutes"
};

function parseLocal(value: unknown): LocalStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.available !== "boolean") return null;
  const connection =
    raw.connection && typeof raw.connection === "object"
      ? (raw.connection as LocalConnection)
      : null;
  return {
    available: raw.available,
    enabled: raw.enabled === true,
    running: raw.running === true,
    blockedReason: typeof raw.blockedReason === "string" ? raw.blockedReason : null,
    connection: connection && typeof connection.state === "string" ? connection : null
  };
}

function parseServer(value: unknown): ServerStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== true || typeof raw.status !== "string") return null;
  return {
    enabled: true,
    host: typeof raw.host === "string" ? raw.host : null,
    status: raw.status,
    waiting: typeof raw.waiting === "number" ? raw.waiting : 0,
    uncertain: typeof raw.uncertain === "number" ? raw.uncertain : 0
  };
}

function toChat(value: string): string {
  const trimmed = value.trim().replace(/[ ()-]/g, "");
  return /^\+?[1-9][0-9]{6,14}$/.test(trimmed)
    ? `${trimmed.replace(/^\+/, "")}@s.whatsapp.net`
    : trimmed;
}

export default function WhatsAppOnDevicePanel({
  businessId,
  serverLinked = false
}: {
  businessId: string;
  /** A server-hosted session is live for this shop: two linked sessions would duplicate replies. */
  serverLinked?: boolean;
}) {
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [server, setServer] = useState<ServerStatus | null | "unsupported">(null);
  const [consent, setConsent] = useState(false);
  const [phone, setPhone] = useState("");
  const [chat, setChat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const base = `/businesses/${encodeURIComponent(businessId)}/channels/whatsapp-linked/device`;

  async function refreshLocal() {
    try {
      const status = parseLocal(
        await deviceMessagingAdapter.call<unknown>("whatsappLocalStatus", { businessId })
      );
      if (alive.current) setLocal(status);
    } catch (failure) {
      if (alive.current) setError(getUserFacingErrorMessage(failure));
    }
  }
  async function refreshServer() {
    try {
      const status = parseServer(await fetchFreshJson<unknown>(`${base}/status`));
      if (alive.current) setServer(status ?? "unsupported");
    } catch {
      // A host without the device routes (or with them switched off) answers 404.
      if (alive.current) setServer("unsupported");
    }
  }

  useEffect(() => {
    alive.current = true;
    setLocal(null);
    setServer(null);
    setError("");
    setNotice("");
    let ticks = 0;
    void refreshLocal();
    void refreshServer();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      ticks += 1;
      void refreshLocal();
      if (ticks % 3 === 0) void refreshServer();
    }, 3000);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [businessId]);

  async function act(
    method: string,
    params: Record<string, unknown>,
    success = "",
    timeoutMs = 45_000
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await deviceMessagingAdapter.call<unknown>(method, params, { timeoutMs });
      if (success) setNotice(success);
      await refreshLocal();
      void refreshServer();
    } catch (failure) {
      setError(getUserFacingErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  if (local === null || server === null) return null;
  if (server === "unsupported") return null;
  const state = local.connection?.state ?? (local.running ? "DISCONNECTED" : null);
  const live = state !== null && !["DISCONNECTED", "AUTH_REQUIRED", "REVOKED"].includes(state);
  return (
    <section aria-label="WhatsApp on this phone" className="record-form">
      <h4>WhatsApp on this phone</h4>
      {!local.available ? (
        <p role="note">
          {blockedText[local.blockedReason ?? "runtime_missing"] ??
            "WhatsApp on this phone is not available."}
        </p>
      ) : !local.enabled ? (
        <>
          <p>
            Keep your linked WhatsApp running on this phone. Your WhatsApp device keys stay
            encrypted on this phone and never reach Grogoni&apos;s servers. Approved chats arrive in
            your Grogoni inbox, and replies you send from Grogoni go out through this phone.
          </p>
          {serverLinked ? (
            <p role="note">
              WhatsApp is already linked on the Grogoni server for this shop. Disconnect it there
              first, so replies are not sent twice.
            </p>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I own this WhatsApp account. This unofficial connection can stop working or put my
                account at risk. It shows a notification while it runs, uses battery and mobile
                data, and starts again after the phone restarts until I stop it.
              </label>
              <button
                type="button"
                disabled={busy || !consent}
                onClick={() =>
                  void act(
                    "whatsappLocalEnable",
                    { enabled: true },
                    "Starting WhatsApp on this phone."
                  )
                }
              >
                Run WhatsApp on this phone
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <p role="status">
            {local.running
              ? (stateText[state ?? "DISCONNECTED"] ?? "Connection needs attention")
              : "Starting…"}
          </p>
          {local.running && !live ? (
            <>
              <label>
                WhatsApp number on this phone, including country code
                <input
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  placeholder="254…"
                />
              </label>
              <button
                type="button"
                disabled={
                  busy || !/^\+?[1-9][0-9]{6,14}$/.test(phone.trim().replace(/[ ()-]/g, ""))
                }
                onClick={() =>
                  void act(
                    "whatsappLocalConnect",
                    { businessId, phone: phone.trim().replace(/[ ()+-]/g, "") },
                    "",
                    100_000
                  )
                }
              >
                Get pairing code
              </button>
            </>
          ) : null}
          {local.connection?.pairingCode ? (
            <div role="status">
              <p>
                Pairing code: <strong>{local.connection.pairingCode}</strong>
              </p>
              <p>
                In WhatsApp, open Linked devices → Link a device → Link with phone number instead,
                and enter this code.
              </p>
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
            </div>
          ) : null}
          {state === "CONNECTED" ? (
            <div>
              <label>
                Approve a contact number or group identifier
                <input
                  value={chat}
                  onChange={(event) => setChat(event.target.value)}
                  placeholder="+254…"
                />
              </label>
              <button
                type="button"
                disabled={busy || !chat.trim()}
                onClick={() => {
                  const approved = toChat(chat);
                  void act(
                    "whatsappLocalApprove",
                    { businessId, chat: approved },
                    "Conversation approved. Its messages now arrive in Grogoni."
                  ).then(() => setChat(""));
                }}
              >
                Approve conversation
              </button>
              <ul>
                {(local.connection?.scopes ?? []).map((scope) => (
                  <li key={scope.chat}>
                    {scope.chat}{" "}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          "whatsappLocalRevoke",
                          { businessId, chat: scope.chat },
                          "Approval removed."
                        )
                      }
                    >
                      Remove approval
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {server.waiting > 0 ? (
            <p role="status">
              {server.waiting === 1
                ? "1 reply is waiting to be sent from this phone."
                : `${server.waiting} replies are waiting to be sent from this phone.`}
            </p>
          ) : null}
          {server.uncertain > 0 ? (
            <p role="alert">
              {server.uncertain === 1 ? "1 reply" : `${server.uncertain} replies`} may not have
              reached WhatsApp. Check the chat in WhatsApp before sending again.
            </p>
          ) : null}
          {local.running && state !== "DISCONNECTED" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(
                  "whatsappLocalDisconnect",
                  { businessId },
                  "WhatsApp unlinked and its keys erased from this phone."
                )
              }
            >
              Unlink WhatsApp from this phone
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                "whatsappLocalEnable",
                { enabled: false },
                "Stopped. Replies wait until you start it again."
              )
            }
          >
            Stop running on this phone
          </button>
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
