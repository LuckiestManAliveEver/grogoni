import { useEffect, useState } from "react";
import { browserSupportsWebAuthn } from "./browser-passkeys";
import { isNativeDeviceHost } from "./device-messaging";
import { apiFetch } from "./lib/api";
import { usePasskeyEnrollment } from "./usePasskeyEnrollment";
import "./pwa-passkey-setup.css";

/** Existing accounts can enroll without creating a shop or entering business settings. */
export function PwaPasskeySetup({ accountId }: { accountId: string }) {
  const [needed, setNeeded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const enrollment = usePasskeyEnrollment({ onCreated: () => setNeeded(false) });
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
  return (
    <section className="record-form pwa-passkey-setup" aria-label="Set up account passkey">
      <strong>Create a passkey for your account</strong>
      <p>
        Save a passkey with your browser or password manager to recover your PIN or password later.
      </p>
      <div className="row-actions">
        <button type="button" disabled={enrollment.busy} onClick={() => void enrollment.enroll()}>
          {enrollment.busy ? "Creating passkey…" : "Create passkey"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={enrollment.busy}
          onClick={() => setDismissed(true)}
        >
          Not now
        </button>
      </div>
      {enrollment.stepUpForm}
      {enrollment.message ? <p role="alert">{enrollment.message}</p> : null}
    </section>
  );
}
