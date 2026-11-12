import { useState, type FormEvent } from "react";
import { createBrowserPasskey } from "./browser-passkeys";
import { ApiRequestError, apiFetch } from "./lib/api";
import { getUserFacingErrorMessage } from "./user-facing-error";

type StepUpMethod = "pin" | "password";

/**
 * Creates a passkey for the signed-in account. The server only allows this within 15 minutes of
 * proving a credential, so a stolen session cannot add its own passkey. An older session is asked
 * for its PIN or password here, then continues, instead of ending in a sign-in error.
 */
export function usePasskeyEnrollment(options: {
  label?: string;
  onCreated: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [methods, setMethods] = useState<StepUpMethod[]>([]);
  const [secret, setSecret] = useState("");
  const method = methods[0] ?? null;

  function credentialStatus() {
    return apiFetch<{ hasPin: boolean; hasPassword: boolean }>("/auth/credentials/status");
  }

  async function create() {
    try {
      await createBrowserPasskey(options.label);
      await options.onCreated();
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        (error.code === "recent_authentication_required" || error.code === "pin_required")
      ) {
        const status = await credentialStatus();
        const available: StepUpMethod[] = [
          ...(status.hasPin ? (["pin"] as const) : []),
          ...(status.hasPassword ? (["password"] as const) : [])
        ];
        setMethods(available);
        // Never send this account to sign out: with no credential it could not get back in.
        if (available.length === 0) {
          setMessage("You can add a passkey within 15 minutes of signing in.");
        }
        return;
      }
      throw error;
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      // A wrong answer must not refresh and resend, so refresh a lapsed session first.
      await credentialStatus();
      await apiFetch(method === "pin" ? "/auth/pin/verify" : "/auth/password/verify", {
        method: "POST",
        body: method === "pin" ? { pin: secret } : { password: secret }
      });
      setSecret("");
      setMethods([]);
      await create();
    });
  }

  const name = method === "pin" ? "PIN" : "password";
  const stepUpForm =
    method === null ? null : (
      <form className="auth-fields passkey-step-up" onSubmit={(event) => void confirm(event)}>
        <label>
          Enter your {name} to continue
          <input
            type="password"
            autoComplete="current-password"
            inputMode={method === "pin" ? "numeric" : "text"}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || secret.length === 0}>
          {busy ? "Checking…" : "Continue"}
        </button>
        {methods.length > 1 ? (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setSecret("");
              setMessage("");
              setMethods([...methods.slice(1), ...methods.slice(0, 1)]);
            }}
          >
            Use your {method === "pin" ? "password" : "PIN"} instead
          </button>
        ) : null}
      </form>
    );

  return { busy, message, stepUpForm, enroll: () => run(create) };
}
