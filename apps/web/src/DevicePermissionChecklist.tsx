import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceMessagingAdapter } from "./device-messaging";
import {
  checklistProgress,
  devicePermissionCopy,
  parseDevicePermissionChecklist,
  type DevicePermissionChecklist as Checklist,
  type DevicePermissionItem
} from "./device-permissions";

const statusText: Record<DevicePermissionItem["status"], string> = {
  granted: "Allowed",
  not_requested: "Not allowed yet",
  denied: "You declined this. Tap Allow to ask again, or turn it on in Settings.",
  blocked: "Android will not ask again. Turn it on in Settings.",
  unavailable: "Not supported on this phone"
};

const DIALOG_FLOW_TIMEOUT_MS = 15 * 60_000;

/** First-run checklist of the phone features a messenger needs. Every grant follows a user tap. */
export default function DevicePermissionChecklist({
  adapter,
  initial,
  onDone
}: {
  adapter: DeviceMessagingAdapter;
  initial: Checklist;
  onDone(checklist: Checklist): void;
}) {
  const [checklist, setChecklist] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const accept = useCallback((value: unknown) => {
    const parsed = parseDevicePermissionChecklist(value);
    if (parsed) setChecklist(parsed);
    return parsed;
  }, []);
  // Grants made in Android Settings arrive without a callback; re-read while the checklist is open.
  useEffect(() => {
    const reload = () => {
      if (document.visibilityState === "visible")
        void adapter.call("permissionChecklist").then(accept, () => undefined);
    };
    const interval = setInterval(reload, 2_000);
    document.addEventListener("visibilitychange", reload);
    window.addEventListener("focus", reload);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", reload);
      window.removeEventListener("focus", reload);
    };
  }, [adapter, accept]);

  // A second tap before React re-renders must not start (and then clear) a parallel request.
  const inFlight = useRef(false);
  async function run(method: string, params?: Record<string, unknown>) {
    if (inFlight.current && method !== "completePermissionChecklist") return null;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      // Request flows wait on Android dialogs the user reads one by one; give them time.
      const options = method.startsWith("request") ? { timeoutMs: DIALOG_FLOW_TIMEOUT_MS } : {};
      return accept(await adapter.call(method, params, options));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const progress = checklistProgress(checklist);
  return (
    <section className="device-permissions" aria-labelledby="device-permissions-title">
      <h2 id="device-permissions-title">Set up Grogoni on this phone</h2>
      <p>
        Grogoni is a messenger, so it needs a few phone features. Android asks you to confirm each
        one. You can change them any time in Settings.
      </p>
      <p className="device-permissions-progress" role="status">
        {progress.granted} of {progress.total} allowed
      </p>
      <button
        type="button"
        className="device-permissions-primary"
        disabled={busy || progress.askable === 0}
        onClick={() => void run("requestAllPermissions")}
      >
        Allow all
      </button>
      {notice && (
        <p className="device-messenger-notice" role="alert">
          {notice}
        </p>
      )}
      <ul className="device-permissions-list">
        {checklist.items.map((item) => {
          const copy = devicePermissionCopy[item.id]!;
          return (
            <li key={item.id} data-permission={item.id} data-status={item.status}>
              <span className="device-permissions-mark" aria-hidden="true">
                {item.status === "granted" ? "✓" : ""}
              </span>
              <div>
                <h3>{copy.title}</h3>
                <p className="device-permissions-tag">
                  {item.required ? "Needed for messages" : "Optional"}
                </p>
                <p>{copy.detail}</p>
                <p className="device-permissions-state">{statusText[item.status]}</p>
              </div>
              <div className="device-permissions-actions">
                {(item.status === "not_requested" || item.status === "denied") && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Allow ${copy.title}`}
                    onClick={() => void run("requestPermissionGroup", { id: item.id })}
                  >
                    Allow
                  </button>
                )}
                {/* Android can refuse without a dialog in ways the app cannot detect; Settings always works. */}
                {(item.status === "denied" || item.status === "blocked") && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Open settings for ${copy.title}`}
                    onClick={() => void run("openPermissionSettings", { id: item.id })}
                  >
                    {item.status === "blocked" ? "Open settings" : "Settings"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {progress.requiredMissing > 0 && (
        <p>
          Without Messages, Grogoni cannot read or send texts on this phone. You can still continue
          and allow it later from Settings.
        </p>
      )}
      <button
        type="button"
        className={progress.requiredMissing === 0 ? "device-permissions-primary" : undefined}
        onClick={() =>
          // Never trap the user: if Android cannot record completion, open the inbox anyway.
          void run("completePermissionChecklist").then((done) =>
            onDone(done ?? { ...checklist, completed: true })
          )
        }
      >
        {progress.requiredMissing === 0 ? "Continue" : "Continue with limited access"}
      </button>
    </section>
  );
}
