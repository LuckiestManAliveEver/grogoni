import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, createBrowserPasskey } from "./browser-passkeys";
import { isNativeDeviceHost } from "./device-messaging";
import { apiFetch } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";

/** Existing accounts can enroll without creating a shop or entering business settings. */
export function PwaPasskeySetup({ accountId }: { accountId: string }) {
  const [needed, setNeeded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (isNativeDeviceHost() || !browserSupportsWebAuthn()) return;
    let active = true;
    void apiFetch<{ passkeys: unknown[] }>("/auth/passkeys")
      .then(({ passkeys }) => {
        if (active) setNeeded(passkeys.length === 0);
      })
      .catch(() => {
        if (active) setNeeded(true);
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  if (!needed || dismissed) return null;
  async function create() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await createBrowserPasskey();
      setNeeded(false);
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="record-form" aria-label="Set up account passkey">
      <strong>Create a passkey for your account</strong>
      <p>
        Save a passkey with your browser or password manager to recover your PIN or password later.
      </p>
      <div className="row-actions">
        <button type="button" disabled={busy} onClick={() => void create()}>
          {busy ? "Creating passkey…" : "Create passkey"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setDismissed(true)}
        >
          Not now
        </button>
      </div>
      {message ? <p role="alert">{message}</p> : null}
    </section>
  );
}
