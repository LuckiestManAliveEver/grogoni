import { useState, type FormEvent } from "react";
import { browserSupportsWebAuthn } from "./browser-passkeys";
import { apiFetch } from "./lib/api";
import { usePasskeyEnrollment } from "./usePasskeyEnrollment";
import { getUserFacingErrorMessage } from "./user-facing-error";
import "./secure-shop-prompt.css";

/**
 * A guest who owns a shop has no way back in if this browser's data is lost. Registering a shop is
 * something they started, so it is the one time a guest is asked to add a sign-in.
 */
export function SecureShopPrompt({
  shopName,
  onSecured
}: {
  shopName: string;
  onSecured: () => void | Promise<void>;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const enrollment = usePasskeyEnrollment({ onCreated: onSecured });
  if (dismissed) return null;

  async function createPin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await apiFetch("/auth/pin/setup", {
        method: "POST",
        body: { pin, pinConfirmation: pin }
      });
      await onSecured();
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const pending = busy || enrollment.busy;
  return (
    <section className="record-form secure-shop-prompt" aria-label="Secure your shop">
      <strong>Keep {shopName} safe</strong>
      <p>
        Add a way to log in. Without one, clearing this browser or losing this phone loses your
        shop.
      </p>
      {browserSupportsWebAuthn() ? (
        <button type="button" disabled={pending} onClick={() => void enrollment.enroll()}>
          {enrollment.busy ? "Creating passkey…" : "Create passkey"}
        </button>
      ) : null}
      <form className="auth-fields" onSubmit={(event) => void createPin(event)}>
        <label>
          Or create a 4-digit PIN
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={4}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/gu, ""))}
          />
        </label>
        <button type="submit" disabled={pending || pin.length !== 4}>
          {busy ? "Saving…" : "Create PIN"}
        </button>
      </form>
      <button
        type="button"
        className="secondary"
        disabled={pending}
        onClick={() => setDismissed(true)}
      >
        Not now
      </button>
      {enrollment.stepUpForm}
      {message || enrollment.message ? <p role="alert">{message || enrollment.message}</p> : null}
    </section>
  );
}
