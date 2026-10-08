import { useState } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import type { AuthSessionView } from "@grogoni/shared-types";
import { normalizePhoneInput, phoneNormalizationErrorMessage } from "@grogoni/shared-types";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";
import { ApiRequestError, apiFetch } from "./lib/api";
import { AppIcon } from "./AppIcon";
import { PhoneNumberField, authenticationPhoneCountries } from "./PhoneNumberField";
import { getUserFacingErrorMessage } from "./user-facing-error";
import { isGrogoniId, normalizeGrogoniId } from "./grogoniid-and-storefront";

type Stage =
  | "entry"
  | "methods"
  | "pin"
  | "password"
  | "mfa"
  | "recovery-reset"
  | "create-pin"
  | "recover-pin";
type IdentifierType = "phone" | "email" | "store";

interface LoginMethods {
  preferred: "pin";
  passkeyAvailable: boolean;
  passwordFallback: boolean;
  recoveryAvailable: boolean;
  smsLogin: false;
}

export interface RememberedAccount {
  type: "phone" | "email";
  identifier: string;
  label: string;
}

interface Props {
  remembered: RememberedAccount | null;
  onAuthenticated: (session: AuthSessionView) => void;
  onSignUp: () => void;
  onForgetRemembered: () => void;
  onCancel: () => void;
}

export function PhoneFirstAuthentication({
  remembered,
  onAuthenticated,
  onSignUp,
  onForgetRemembered,
  onCancel
}: Props) {
  // A returning visit does not need the identifier again, but still goes through the backend's
  // enumeration-safe method discovery instead of assuming which credential the account uses.
  const startsWithRemembered = remembered !== null;
  const [usingRemembered, setUsingRemembered] = useState(startsWithRemembered);
  const [identifierType, setIdentifierType] = useState<IdentifierType>(remembered?.type ?? "phone");
  const [country, setCountry] = useState<CountryCode>("KE");
  const [identifier, setIdentifier] = useState(
    startsWithRemembered ? (remembered?.identifier ?? "") : ""
  );
  const [stage, setStage] = useState<Stage>("entry");
  const [loginMethods, setLoginMethods] = useState<LoginMethods | null>(null);
  const [transactionId, setTransactionId] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [recoveryMfaCode, setRecoveryMfaCode] = useState("");
  const [mfaFactor, setMfaFactor] = useState<"totp" | "recovery_code">("totp");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    startsWithRemembered ? "Choose a secure way to return to this account." : ""
  );

  function useDifferentAccount() {
    setUsingRemembered(false);
    setIdentifier("");
    setPin("");
    setLoginMethods(null);
    setStage("entry");
    setMessage("");
    onForgetRemembered();
  }

  const identifierBody = () => {
    if (identifierType === "email") {
      const trimmed = identifier.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(trimmed)) {
        throw new Error("Enter a valid email address.");
      }
      return { type: identifierType, identifier: trimmed };
    }
    if (identifierType === "store") {
      if (!isGrogoniId(identifier)) {
        throw new Error("Enter a valid Grogoni ID, e.g. grogoni.janes-shop.");
      }
      return { type: identifierType, identifier: normalizeGrogoniId(identifier) };
    }
    const normalized = normalizePhoneInput({
      rawInput: identifier,
      selectedCountry: country,
      selectedCallingCode: getCountryCallingCode(country)
    });
    if (!normalized.valid) throw new Error(phoneNormalizationErrorMessage(normalized.error));
    return { type: identifierType, identifier: normalized.e164, country: normalized.country };
  };

  function currentIdentifierBody() {
    return usingRemembered
      ? { type: remembered!.type, identifier: remembered!.identifier }
      : identifierBody();
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function continueIdentifier() {
    if (identifierType === "store") {
      identifierBody();
      setPin("");
      setStage("pin");
      setMessage("Enter the store owner's PIN to continue.");
      return;
    }
    const methods = await apiFetch<LoginMethods>("/auth/login/methods", {
      method: "POST",
      body: currentIdentifierBody(),
      skipAuthRefresh: true
    });
    setLoginMethods(methods);
    setStage("methods");
    setMessage("Choose how you'd like to sign in.");
  }

  async function submitPin() {
    // A remembered identifier is already normalized (it came straight from the account's
    // primaryAuthDestination on a previous successful login), so it skips identifierBody()'s
    // phone parsing, which needs a country hint this screen no longer collects.
    const normalized = currentIdentifierBody();
    try {
      const result = await apiFetch<AuthSessionView>(
        identifierType === "store" ? "/auth/pin/store-login" : "/auth/pin/login",
        {
          method: "POST",
          body:
            identifierType === "store"
              ? { grogoniId: normalized.identifier, pin }
              : {
                  method: identifierType,
                  contact: normalized.identifier,
                  ...(identifierType === "phone" && !usingRemembered ? { country } : {}),
                  pin
                }
        }
      );
      onAuthenticated(result);
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.code === "auth_credentials_invalid"
      ) {
        setMessage("We couldn't sign you in with that PIN. Check your account details and PIN, then try again.");
        return;
      }
      throw error;
    }
  }

  async function login() {
    const result = await apiFetch<AuthSessionView | { mfaRequired: true; transactionId: string }>(
      "/auth/login/password",
      {
        method: "POST",
        body: { ...currentIdentifierBody(), password }
      }
    );
    if ("mfaRequired" in result && result.mfaRequired) {
      setTransactionId(result.transactionId);
      setStage("mfa");
      setCode("");
      setMessage("Enter your second factor.");
    } else {
      onAuthenticated(result as AuthSessionView);
    }
  }

  async function verifyMfa() {
    const session = await apiFetch<AuthSessionView>("/auth/mfa/verify", {
      method: "POST",
      body: { transactionId, factor: mfaFactor, code }
    });
    onAuthenticated(session);
  }

  // Step 1 of recovery: prove identity. Phone accounts have no SMS channel, so identity is
  // proven with a passkey right here, before anything about a new credential is asked - the same
  // "authenticate first" order a phone's biometric unlock uses. Email/store accounts prove
  // identity with an emailed code instead, entered together with the new password in step 2.
  async function startRecovery() {
    if (identifierType === "phone") {
      if (!browserSupportsWebAuthn()) {
        setMessage(
          "Passkey recovery isn't available in this browser. Try Chrome, Safari, or Edge, or contact support."
        );
        return;
      }
      const challenge = await apiFetch<{
        ceremonyId: string;
        options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
      }>("/auth/passkeys/login/options", {
        method: "POST",
        body: { purpose: "pin_recovery" }
      });
      const response = await startAuthentication({ optionsJSON: challenge.options });
      await apiFetch<AuthSessionView>("/auth/passkeys/login/verify", {
        method: "POST",
        body: { ceremonyId: challenge.ceremonyId, response }
      });
      // The passkey response established a fresh, server-authoritative recovery session. Ask the
      // server which credential mutation is valid instead of guessing from client state. Do not
      // auto-refresh this status request: rotating the just-created session between proof and
      // mutation would change the session id to which the one-time recovery grant is bound.
      const credentials = await apiFetch<{ hasPin: boolean; hasPassword: boolean }>(
        "/auth/credentials/status",
        { skipAuthRefresh: true }
      );
      setPassword("");
      setPasswordConfirmation("");
      setStage(passkeyPinRecoveryStage(credentials.hasPin));
      setMessage(
        credentials.hasPin
          ? "Identity verified. Choose a new PIN."
          : "Identity verified. Create a 4-digit PIN."
      );
      return;
    }
    const result = await apiFetch<{
      transactionId: string;
      developmentCode?: string;
      message: string;
    }>("/auth/recovery/start", {
      method: "POST",
      body: currentIdentifierBody()
    });
    setTransactionId(result.transactionId);
    setCode(result.developmentCode ?? "");
    setPassword("");
    setPasswordConfirmation("");
    setRecoveryMfaCode("");
    setStage("recovery-reset");
    setMessage(result.message);
  }

  // Step 2 of recovery for email/store accounts: verify the emailed code and set the new
  // password in one action, instead of two separate screens.
  async function verifyAndResetPassword() {
    await apiFetch("/auth/recovery/verify", { method: "POST", body: { transactionId, code } });
    const session = await apiFetch<AuthSessionView>("/auth/recovery/reset-password", {
      method: "POST",
      body: {
        transactionId,
        password,
        passwordConfirmation,
        ...(recoveryMfaCode ? { mfaCode: recoveryMfaCode } : {})
      }
    });
    onAuthenticated(session);
  }

  // Step 2 of recovery for phone accounts: identity was already proven by the passkey in
  // startRecovery, so this only sets the new PIN.
  async function finishPinRecovery() {
    if (!/^\d{4}$/u.test(password) || password !== passwordConfirmation) {
      setMessage("Enter and confirm a new 4-digit PIN.");
      return;
    }
    if (stage !== "create-pin" && stage !== "recover-pin") {
      throw new Error("PIN recovery is not active.");
    }
    const endpoint = passkeyPinMutationEndpoint(stage);
    try {
      const session = await apiFetch<AuthSessionView>(endpoint, {
        method: "POST",
        body: { pin: password, pinConfirmation: passwordConfirmation }
      });
      setPassword("");
      setPasswordConfirmation("");
      onAuthenticated(session);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "passkey_pin_recovery_required") {
        setPassword("");
        setPasswordConfirmation("");
        setStage("methods");
        setMessage("Verify your passkey again before changing your PIN.");
        return;
      }
      throw error;
    }
  }

  function goBack() {
    setMessage("");
    if (stage === "entry") {
      onCancel();
      return;
    }
    if (stage === "mfa") {
      setStage("password");
      return;
    }
    if (stage === "methods" || identifierType === "store") {
      setStage("entry");
      return;
    }
    setStage("methods");
  }

  const isCredentialEntry = stage === "entry" || stage === "password" || stage === "pin";
  const stepNumber = stage === "entry" ? 1 : 2;
  const stepTotal = 2;
  const heading =
    stage === "entry"
      ? "Welcome back"
      : stage === "methods"
        ? "Choose how to log in"
        : stage === "pin"
          ? "Use your account PIN"
          : stage === "password"
            ? "Log in with password"
            : stage === "mfa"
              ? "Security check"
              : stage === "create-pin"
                ? "Create a PIN"
                : stage === "recover-pin"
                  ? "Choose a new PIN"
                  : "Recover your account";

  return (
    <main className="auth-onboarding" aria-busy={busy}>
      <section className="auth-onboarding-card" aria-labelledby="auth-onboarding-title">
        <header className="auth-onboarding-header">
          <button className="auth-back-button" type="button" onClick={goBack} aria-label="Back">
            <span aria-hidden="true">←</span>
          </button>
          <div className="auth-wordmark">
            <AppIcon className="auth-wordmark-icon" />
            <span>grogoni</span>
          </div>
          <span className="auth-header-spacer" aria-hidden="true" />
        </header>

        <div className="auth-onboarding-content">
          <div
            className="auth-progress auth-progress-two"
            aria-label={`Step ${stepNumber} of ${stepTotal}`}
          >
            {Array.from({ length: stepTotal }, (_, index) => (
              <span className={index < stepNumber ? "complete" : ""} key={index} />
            ))}
          </div>
          <div className="auth-onboarding-heading">
            <p className="eyebrow">LOG IN</p>
            <h1 id="auth-onboarding-title">{heading}</h1>
            <p>
              {stage === "entry"
                ? "Use your phone number, email, or Grogoni ID to get back to your conversations."
                : message}
            </p>
          </div>

          {stage === "entry" && !usingRemembered ? (
            <div className="auth-method-tabs" role="tablist" aria-label="Login method">
              {(["phone", "email", "store"] as const).map((method) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={identifierType === method}
                  className={identifierType === method ? "active" : ""}
                  key={method}
                  onClick={() => {
                    setIdentifierType(method);
                    setIdentifier("");
                    setLoginMethods(null);
                    setMessage("");
                  }}
                >
                  {method === "phone" ? "Phone" : method === "email" ? "Email" : "Grogoni ID"}
                </button>
              ))}
            </div>
          ) : null}

          {isCredentialEntry ? (
            <div className="auth-fields">
              {usingRemembered ? (
                <div className="auth-remembered-account">
                  <p>
                    Continuing as <strong>{remembered?.label}</strong>
                  </p>
                  <button className="auth-text-button" type="button" onClick={useDifferentAccount}>
                    Not you? Use a different account
                  </button>
                </div>
              ) : identifierType === "phone" ? (
                <PhoneNumberField
                  country={country}
                  value={identifier}
                  countries={authenticationPhoneCountries}
                  onCountryChange={setCountry}
                  onValueChange={setIdentifier}
                  autoFocus={stage === "entry"}
                />
              ) : identifierType === "email" ? (
                <label>
                  Email address
                  <input
                    autoFocus
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                  />
                </label>
              ) : (
                <label>
                  Grogoni ID
                  <input
                    autoFocus
                    type="text"
                    autoComplete="off"
                    autoCapitalize="characters"
                    placeholder="grogoni.janes-shop"
                    value={identifier}
                    onChange={(event) => setIdentifier(event.target.value)}
                  />
                </label>
              )}
              {stage === "password" ? (
                <label>
                  Password
                  <input
                    autoFocus
                    type="password"
                    maxLength={256}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              ) : null}
              {stage === "pin" ? (
                <label className="auth-pin-field">
                  4-digit PIN
                  <input
                    autoFocus={stage === "pin"}
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    pattern="[0-9]*"
                    autoComplete="current-password"
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/gu, ""))}
                  />
                  <span className="auth-pin-dots" aria-hidden="true">
                    {[0, 1, 2, 3].map((index) => (
                      <i className={index < pin.length ? "filled" : ""} key={index} />
                    ))}
                  </span>
                </label>
              ) : null}
              <div>
                <button
                  className="auth-primary-button"
                  type="button"
                  disabled={
                    busy ||
                    !identifier.trim() ||
                    (stage === "password" && !password) ||
                    (stage === "pin" && pin.length !== 4)
                  }
                  aria-busy={busy}
                  onClick={() =>
                    void run(
                      stage === "password"
                        ? login
                        : stage === "pin"
                          ? submitPin
                          : continueIdentifier
                    )
                  }
                >
                  {busy
                    ? "Please wait…"
                    : stage === "password"
                      ? "Log in"
                      : stage === "pin"
                        ? "Log in"
                        : "Continue to log in"}
                </button>
              </div>
            </div>
          ) : null}

          {stage === "methods" ? (
            <div className="auth-fields auth-login-methods" aria-label="Available login methods">
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  setPin("");
                  setStage("pin");
                  setMessage("Enter the 4-digit PIN previously set for this account.");
                }}
              >
                Use account PIN
              </button>
              {loginMethods?.passwordFallback ? (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPassword("");
                    setStage("password");
                    setMessage("Enter the recovery password for this account.");
                  }}
                >
                  Use a password
                </button>
              ) : null}
              {loginMethods?.recoveryAvailable ? (
                <button
                  className="auth-text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void run(startRecovery)}
                >
                  Trouble logging in?
                </button>
              ) : null}
            </div>
          ) : null}

          {stage === "recovery-reset" ? (
            <div className="auth-fields">
              <label>
                Verification code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <PasswordFields
                password={password}
                confirmation={passwordConfirmation}
                setPassword={setPassword}
                setConfirmation={setPasswordConfirmation}
              />
              <label>
                MFA code (if enabled)
                <input
                  autoComplete="one-time-code"
                  value={recoveryMfaCode}
                  onChange={(event) => setRecoveryMfaCode(event.target.value)}
                />
              </label>
              <button
                className="auth-primary-button"
                type="button"
                disabled={
                  busy || !code.trim() || password.length < 10 || password !== passwordConfirmation
                }
                aria-busy={busy}
                onClick={() => void run(verifyAndResetPassword)}
              >
                {busy ? "Working…" : "Reset password"}
              </button>
            </div>
          ) : null}
          {stage === "create-pin" || stage === "recover-pin" ? (
            <div className="auth-fields">
              <label>
                New 4-digit PIN
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value.replace(/\D/gu, ""))}
                />
              </label>
              <label>
                Confirm new PIN
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="new-password"
                  value={passwordConfirmation}
                  onChange={(event) =>
                    setPasswordConfirmation(event.target.value.replace(/\D/gu, ""))
                  }
                />
              </label>
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy || !/^\d{4}$/u.test(password) || password !== passwordConfirmation}
                aria-busy={busy}
                onClick={() => void run(finishPinRecovery)}
              >
                {busy ? "Working…" : stage === "create-pin" ? "Create PIN" : "Save new PIN"}
              </button>
            </div>
          ) : null}
          {stage === "mfa" ? (
            <div className="auth-fields">
              <label>
                Second factor
                <select
                  value={mfaFactor}
                  onChange={(event) => setMfaFactor(event.target.value as typeof mfaFactor)}
                >
                  <option value="totp">Authenticator app</option>
                  <option value="recovery_code">Recovery code</option>
                </select>
              </label>
              <label>
                Code
                <input
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy || !code}
                onClick={() => void run(verifyMfa)}
              >
                Verify and sign in
              </button>
            </div>
          ) : null}

          {message && stage === "entry" ? (
            <p className="auth-feedback" role="status" aria-live="polite">
              {message}
            </p>
          ) : null}
          <div className="auth-intent-switch">
            <span>New to Grogoni?</span>
            <button className="auth-text-button" type="button" disabled={busy} onClick={onSignUp}>
              Create an account
            </button>
          </div>
          <button className="auth-guest-button" type="button" onClick={onCancel}>
            Continue to marketplace as guest
          </button>
        </div>
      </section>
    </main>
  );
}

export function passkeyPinRecoveryStage(hasPin: boolean): "create-pin" | "recover-pin" {
  return hasPin ? "recover-pin" : "create-pin";
}

export function passkeyPinMutationEndpoint(
  stage: "create-pin" | "recover-pin"
): "/auth/pin/setup" | "/auth/pin/recover/passkey" {
  return stage === "create-pin" ? "/auth/pin/setup" : "/auth/pin/recover/passkey";
}

function PasswordFields(props: {
  optional?: boolean;
  password: string;
  confirmation: string;
  setPassword: (value: string) => void;
  setConfirmation: (value: string) => void;
}) {
  return (
    <>
      <label>
        Password{props.optional ? " fallback (optional)" : ""}
        <input
          type="password"
          minLength={10}
          maxLength={256}
          autoComplete="new-password"
          value={props.password}
          onChange={(event) => props.setPassword(event.target.value)}
        />
      </label>
      <label>
        Confirm password{props.optional ? " (optional)" : ""}
        <input
          type="password"
          minLength={10}
          maxLength={256}
          autoComplete="new-password"
          value={props.confirmation}
          onChange={(event) => props.setConfirmation(event.target.value)}
        />
      </label>
    </>
  );
}
