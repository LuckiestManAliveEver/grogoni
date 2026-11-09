import { useEffect, useState } from "react";
import { deviceSecurityCapability, recoverWithDeviceSecurity } from "./passkey-recovery";
import { isNativeDeviceHost } from "./device-messaging";
import {
  browserSupportsWebAuthn,
  recoverWithBrowserPasskey,
  loginWithBrowserPasskey
} from "./browser-passkeys";
import type { AuthSessionView } from "@grogoni/shared-types";
import { normalizePhoneInput, phoneNormalizationErrorMessage } from "@grogoni/shared-types";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";
import { ApiRequestError, apiFetch } from "./lib/api";
import { AppIcon } from "./AppIcon";
import { PhoneNumberField, authenticationPhoneCountries } from "./PhoneNumberField";
import { usePasskeyEnrollment } from "./usePasskeyEnrollment";
import { TrustedDeviceRecoveryWait } from "./TrustedDeviceRecoveryWait";
import { getUserFacingErrorMessage } from "./user-facing-error";

type Stage =
  | "entry"
  | "methods"
  | "pin"
  | "password"
  | "mfa"
  | "recovery-reset"
  | "offer-passkey"
  | "create-pin"
  | "recover-pin"
  | "approval-wait"
  | "approval-passkey";

type RecoveryMethod = "device" | "passkey" | "approval" | "email";

interface LoginMethods {
  preferred: "passkey" | "pin";
  passkeyAvailable?: boolean;
  deviceAvailable: boolean;
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
  const startsWithRemembered = remembered?.type === "phone";
  const [usingRemembered, setUsingRemembered] = useState(startsWithRemembered);
  const identifierType = "phone" as const;
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
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryEmailVerified, setRecoveryEmailVerified] = useState(false);
  const [deviceAvailable, setDeviceAvailable] = useState<boolean | null>(null);
  const [deviceSecurityReason, setDeviceSecurityReason] = useState("");
  const nativeDevice = isNativeDeviceHost();
  const [pendingSession, setPendingSession] = useState<AuthSessionView | null>(null);
  const [approvalPasskeyCreated, setApprovalPasskeyCreated] = useState(false);
  const [approvalIdentifier, setApprovalIdentifier] = useState("");
  const passkeyEnrollment = usePasskeyEnrollment({
    onCreated: async () => {
      if (stage === "approval-passkey") {
        setApprovalPasskeyCreated(true);
        await continueToCredentialReset();
        return;
      }
      if (pendingSession !== null) onAuthenticated(pendingSession);
    }
  });

  useEffect(() => {
    if (!nativeDevice) return;
    let active = true;
    void deviceSecurityCapability().then((capability) => {
      if (active) {
        setDeviceAvailable(capability.supported);
        setDeviceSecurityReason(capability.reason ?? "");
      }
    });
    return () => {
      active = false;
    };
  }, [nativeDevice]);
  // Without WebAuthn there is no registered passkey to use, so offer the other device first.
  const [recoveryMethod, setRecoveryMethod] = useState<RecoveryMethod>(
    browserSupportsWebAuthn() ? "passkey" : nativeDevice ? "device" : "approval"
  );
  const [recoveryCredential, setRecoveryCredential] = useState<"pin" | "password">("pin");
  const [availableMfaFactors, setAvailableMfaFactors] = useState<string[]>([]);
  const [mfaFactor, setMfaFactor] = useState<"totp" | "recovery_code" | "email">("totp");
  const [mfaReturnStage, setMfaReturnStage] = useState<"pin" | "password">("pin");
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
      ? { type: "phone" as const, identifier: remembered!.identifier }
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

  async function continueIdentifier(attemptPasskey = true) {
    const methods = await apiFetch<LoginMethods>("/auth/login/methods", {
      method: "POST",
      body: currentIdentifierBody(),
      skipAuthRefresh: true
    });
    setLoginMethods(methods);
    setStage("methods");
    setMessage("Choose how you'd like to sign in.");
    if (attemptPasskey && methods.preferred === "passkey") await signInPasskeyFirst();
  }

  async function signInPasskeyFirst() {
    const identifier = currentIdentifierBody().identifier;
    if (browserSupportsWebAuthn()) {
      try {
        onAuthenticated(await loginWithBrowserPasskey(identifier));
        return;
      } catch (error) {
        // No passkey here, or the prompt was dismissed: the other sign-in options are on screen.
        if (!passkeyWasDeclined(error)) setMessage(getUserFacingErrorMessage(error));
      }
    }
    if (nativeDevice) {
      const capability = await deviceSecurityCapability();
      if (capability.supported) {
        try {
          onAuthenticated(await recoverWithDeviceSecurity(identifier));
          return;
        } catch (error) {
          setMessage(getUserFacingErrorMessage(error));
        }
      }
    }
  }

  /** A person who signs in without a passkey is offered one here, and only here. */
  async function finishLogin(session: AuthSessionView) {
    if (browserSupportsWebAuthn()) {
      const list = await apiFetch<{ passkeys: unknown[] }>("/auth/passkeys").catch(() => null);
      if (list !== null && list.passkeys.length === 0) {
        setPendingSession(session);
        setMessage("");
        setStage("offer-passkey");
        return;
      }
    }
    onAuthenticated(session);
  }

  async function submitPin() {
    // A remembered identifier is already normalized (it came straight from the account's
    // primaryAuthDestination on a previous successful login), so it skips identifierBody()'s
    // phone parsing, which needs a country hint this screen no longer collects.
    const normalized = currentIdentifierBody();
    try {
      const result = await apiFetch<
        AuthSessionView | { mfaRequired: true; transactionId: string; factors: string[] }
      >("/auth/pin/login", {
        method: "POST",
        body: {
          method: "phone",
          contact: normalized.identifier,
          ...(!usingRemembered ? { country } : {}),
          pin
        }
      });
      if ("mfaRequired" in result) {
        setTransactionId(result.transactionId);
        setAvailableMfaFactors(result.factors);
        setMfaFactor(result.factors.includes("email") ? "email" : "totp");
        setMfaReturnStage("pin");
        setCode("");
        setStage("mfa");
        setMessage("Enter your second factor.");
      } else await finishLogin(result);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "auth_credentials_invalid") {
        setMessage(
          "We couldn't sign you in with that PIN. Check your account details and PIN, then try again."
        );
        return;
      }
      throw error;
    }
  }

  async function login() {
    const result = await apiFetch<
      AuthSessionView | { mfaRequired: true; transactionId: string; factors: string[] }
    >("/auth/login/password", {
      method: "POST",
      body: { ...currentIdentifierBody(), password }
    });
    if ("mfaRequired" in result && result.mfaRequired) {
      setTransactionId(result.transactionId);
      setAvailableMfaFactors(result.factors);
      setMfaFactor(result.factors.includes("email") ? "email" : "totp");
      setMfaReturnStage("password");
      setStage("mfa");
      setCode("");
      setMessage("Enter your second factor.");
    } else {
      await finishLogin(result as AuthSessionView);
    }
  }

  async function verifyMfa() {
    const session = await apiFetch<AuthSessionView>("/auth/mfa/verify", {
      method: "POST",
      body: { transactionId, factor: mfaFactor, code }
    });
    await finishLogin(session);
  }

  // Prove ownership with a user-verified registered passkey or verified backup email.
  async function startRecovery() {
    if (recoveryMethod === "approval") {
      setApprovalIdentifier(currentIdentifierBody().identifier);
      setApprovalPasskeyCreated(false);
      setStage("approval-wait");
      setMessage("Approve this browser from a phone or computer that is still logged in.");
      return;
    }
    if (recoveryMethod !== "email") {
      if (recoveryMethod === "device") {
        const capability = await deviceSecurityCapability();
        setDeviceAvailable(capability.supported);
        setDeviceSecurityReason(capability.reason ?? "");
        if (!capability.supported)
          throw new Error(
            capability.reason ??
              "Use the Android app for device screen-lock recovery, or use your verified backup email."
          );
      }
      const recoveredSession =
        recoveryMethod === "passkey"
          ? await recoverWithBrowserPasskey(currentIdentifierBody().identifier)
          : await recoverWithDeviceSecurity(currentIdentifierBody().identifier);
      if (recoveredSession.account.primaryAuthDestination !== currentIdentifierBody().identifier) {
        throw new Error(
          recoveryMethod === "passkey"
            ? "Use a passkey registered for this mobile phone account."
            : "Use the device previously secured for this mobile phone account."
        );
      }
      await continueToCredentialReset();
      return;
    }
    const result = await apiFetch<{
      transactionId: string;
      developmentCode?: string;
      message: string;
    }>("/auth/recovery/start", {
      method: "POST",
      body: { type: "email", identifier: recoveryEmail }
    });
    setTransactionId(result.transactionId);
    setCode(result.developmentCode ?? "");
    setPassword("");
    setPasswordConfirmation("");
    setRecoveryMfaCode("");
    setRecoveryEmailVerified(false);
    setStage("recovery-reset");
    setMessage(result.message);
  }

  /** Identity is proven and a recovery grant is held: choose the new PIN or password. */
  async function continueToCredentialReset() {
    const credentials = await apiFetch<{ hasPin: boolean; hasPassword: boolean }>(
      "/auth/credentials/status",
      { skipAuthRefresh: true }
    );
    setPassword("");
    setPasswordConfirmation("");
    setStage(
      recoveryCredential === "password"
        ? "recovery-reset"
        : devicePinRecoveryStage(credentials.hasPin)
    );
    setMessage(
      recoveryCredential === "password"
        ? "Identity verified. Choose a new password."
        : credentials.hasPin
          ? "Identity verified. Choose a new PIN."
          : "Identity verified. Create a 4-digit PIN."
    );
  }

  /** The other device approved this browser. Offer it a passkey before resetting the PIN. */
  async function approvalGranted(session: AuthSessionView) {
    setPendingSession(session);
    if (browserSupportsWebAuthn()) {
      setStage("approval-passkey");
      setMessage(
        "Approved. Create a passkey so next time you can log in with this device's fingerprint, face or screen lock."
      );
      return;
    }
    await continueToCredentialReset();
  }

  // Device proof and email verification both precede the credential reset (password, or PIN by email).
  async function verifyAndResetPassword() {
    if (recoveryMethod !== "email") {
      try {
        const session = await apiFetch<AuthSessionView>("/auth/password/recover/device", {
          method: "POST",
          body: { password, passwordConfirmation },
          skipAuthRefresh: true
        });
        onAuthenticated(session);
      } catch (error) {
        if (
          error instanceof ApiRequestError &&
          error.code === "device_credential_recovery_required"
        ) {
          setPassword("");
          setPasswordConfirmation("");
          setStage("methods");
          setMessage(
            recoveryMethod === "passkey"
              ? "Verify your passkey again before changing your password."
              : recoveryMethod === "approval"
                ? "Approve this browser again before changing your password."
                : "Verify this device again before changing your password."
          );
          return;
        }
        throw error;
      }
      return;
    }
    if (!recoveryEmailVerified) {
      await apiFetch("/auth/recovery/verify", {
        method: "POST",
        body: { transactionId, code },
        skipAuthRefresh: true
      });
      setRecoveryEmailVerified(true);
    }
    const mfa = recoveryMfaCode ? { mfaCode: recoveryMfaCode } : {};
    const session = await apiFetch<AuthSessionView>(
      emailPinReset ? "/auth/recovery/reset-pin" : "/auth/recovery/reset-password",
      {
        method: "POST",
        body: emailPinReset
          ? { transactionId, pin: password, pinConfirmation: passwordConfirmation, ...mfa }
          : { transactionId, password, passwordConfirmation, ...mfa }
      }
    );
    setPassword("");
    setPasswordConfirmation("");
    onAuthenticated(session);
  }

  // Step 2 of recovery for phone accounts: identity was already proven by WebAuthn in
  // startRecovery, so this only sets the new PIN.
  async function finishPinRecovery() {
    if (!/^\d{4}$/u.test(password) || password !== passwordConfirmation) {
      setMessage("Enter and confirm a new 4-digit PIN.");
      return;
    }
    if (stage !== "create-pin" && stage !== "recover-pin") {
      throw new Error("PIN recovery is not active.");
    }
    const endpoint = devicePinMutationEndpoint(stage);
    try {
      const session = await apiFetch<AuthSessionView>(endpoint, {
        method: "POST",
        body: { pin: password, pinConfirmation: passwordConfirmation },
        skipAuthRefresh: true
      });
      setPassword("");
      setPasswordConfirmation("");
      onAuthenticated(session);
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.code === "device_credential_recovery_required"
      ) {
        setPassword("");
        setPasswordConfirmation("");
        setStage("methods");
        setMessage(
          recoveryMethod === "passkey"
            ? "Verify your passkey again before changing your PIN."
            : recoveryMethod === "approval"
              ? "Approve this browser again before changing your PIN."
              : "Verify this device again before changing your PIN."
        );
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
    if (stage === "offer-passkey") {
      // Already logged in: the only way back is forward into the account.
      if (pendingSession !== null) onAuthenticated(pendingSession);
      return;
    }
    if (stage === "approval-passkey") {
      void run(continueToCredentialReset);
      return;
    }
    if (stage === "mfa") {
      setStage(mfaReturnStage);
      return;
    }
    if (stage === "methods") {
      setStage("entry");
      return;
    }
    setStage("methods");
  }

  const isCredentialEntry = stage === "entry" || stage === "password" || stage === "pin";
  const credentialSubmitBlocked =
    busy ||
    !identifier.trim() ||
    (stage === "password" && !password) ||
    (stage === "pin" && pin.length !== 4);
  const emailPinReset = recoveryMethod === "email" && recoveryCredential === "pin";
  const passwordResetBlocked =
    busy ||
    (recoveryMethod === "email" && !code.trim()) ||
    (emailPinReset ? !/^\d{4}$/u.test(password) : password.length < 10) ||
    password !== passwordConfirmation;
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
              : stage === "offer-passkey"
                ? "Add a passkey"
                : stage === "create-pin"
                  ? "Create a PIN"
                  : stage === "recover-pin"
                    ? "Choose a new PIN"
                    : stage === "approval-wait"
                      ? "Approve from another device"
                      : stage === "approval-passkey"
                        ? "Create a passkey"
                        : "Recover your account";

  return (
    <main className="auth-onboarding" aria-busy={busy}>
      <section className="auth-onboarding-card" aria-labelledby="auth-onboarding-title">
        <header className="auth-onboarding-header">
          <button
            className="auth-back-button"
            type="button"
            onClick={goBack}
            disabled={busy}
            aria-label="Back"
          >
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
                ? "Use your mobile phone number to get back to your conversations."
                : message}
            </p>
          </div>

          {isCredentialEntry ? (
            <form
              className="auth-fields"
              noValidate
              onSubmit={(event) => {
                // Enter in any field submits, the same as pressing the button.
                event.preventDefault();
                if (credentialSubmitBlocked) return;
                void run(
                  stage === "password" ? login : stage === "pin" ? submitPin : continueIdentifier
                );
              }}
            >
              {usingRemembered ? (
                <div className="auth-remembered-account">
                  <p>
                    Continuing as <strong>{remembered?.label}</strong>
                  </p>
                  <button className="auth-text-button" type="button" onClick={useDifferentAccount}>
                    Not you? Use a different account
                  </button>
                </div>
              ) : (
                <PhoneNumberField
                  country={country}
                  value={identifier}
                  countries={authenticationPhoneCountries}
                  onCountryChange={setCountry}
                  onValueChange={setIdentifier}
                  autoFocus={stage === "entry"}
                />
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
                  type="submit"
                  disabled={credentialSubmitBlocked}
                  aria-busy={busy}
                >
                  {busy
                    ? "Please wait…"
                    : stage === "password"
                      ? "Log in"
                      : stage === "pin"
                        ? "Log in"
                        : "Continue to log in"}
                </button>
                {!busy && (
                  <button
                    className="auth-text-button"
                    type="button"
                    disabled={!identifier.trim()}
                    onClick={() => void run(() => continueIdentifier(false))}
                  >
                    Trouble logging in?
                  </button>
                )}
              </div>
            </form>
          ) : null}

          {stage === "methods" ? (
            <div className="auth-fields auth-login-methods" aria-label="Available login methods">
              {loginMethods?.passkeyAvailable && browserSupportsWebAuthn() ? (
                <button
                  className="auth-primary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void run(signInPasskeyFirst)}
                >
                  Log in with passkey
                </button>
              ) : null}
              {nativeDevice ? (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      onAuthenticated(
                        await recoverWithDeviceSecurity(currentIdentifierBody().identifier)
                      );
                    })
                  }
                >
                  Log in with device security
                </button>
              ) : null}
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
                    setMessage("Enter the password for this account.");
                  }}
                >
                  Use a password
                </button>
              ) : null}
              {loginMethods?.recoveryAvailable ? (
                <>
                  <label>
                    Recover with
                    <select
                      value={recoveryMethod}
                      onChange={(event) => setRecoveryMethod(event.target.value as RecoveryMethod)}
                    >
                      <option value="passkey">Registered passkey</option>
                      <option value="approval">Approve from a logged-in device</option>
                      {nativeDevice ? <option value="device">Device security</option> : null}
                      <option value="email">Verified backup email</option>
                    </select>
                  </label>
                  {recoveryMethod === "email" ? (
                    <label>
                      Backup email
                      <input
                        type="email"
                        autoComplete="email"
                        value={recoveryEmail}
                        onChange={(event) => setRecoveryEmail(event.target.value)}
                      />
                    </label>
                  ) : (
                    <>
                      <div className="auth-security-summary">
                        <strong>
                          {recoveryMethod === "device"
                            ? "Recover using device security"
                            : recoveryMethod === "approval"
                              ? "Approve from a logged-in device"
                              : "Recover using a passkey"}
                        </strong>
                        <p>
                          {recoveryMethod === "device"
                            ? "Use your fingerprint, face unlock, or phone screen lock to securely recover your Grogoni account."
                            : recoveryMethod === "approval"
                              ? "No passkey yet? Get a code here, enter it on a phone or computer that is still logged in, and confirm with that device's screen lock. Then create a passkey on this browser."
                              : "Use a passkey you previously registered for this Grogoni account. Your browser or password manager will ask you to verify it."}
                        </p>
                        {recoveryMethod === "device" ? (
                          <>
                            <p>
                              {deviceAvailable === null
                                ? "Checking device security…"
                                : deviceAvailable
                                  ? "Use the screen lock already set on this phone. This device must have been secured for your Grogoni account."
                                  : deviceSecurityReason ||
                                    "Use the Android app for device screen-lock recovery, or use your verified backup email."}
                            </p>
                            <details>
                              <summary>Device recovery is not set up?</summary>
                              <p>
                                This device cannot recover your account yet. Use your verified
                                backup email. After signing in to the Android app, enable device
                                recovery to use this phone’s existing screen lock next time.
                              </p>
                            </details>
                          </>
                        ) : recoveryMethod === "passkey" ? (
                          <p>
                            No passkey yet? Choose Approve from a logged-in device, or use your
                            verified backup email.
                          </p>
                        ) : null}
                      </div>
                    </>
                  )}
                  <label>
                    Reset
                    <select
                      value={recoveryCredential}
                      onChange={(event) =>
                        setRecoveryCredential(event.target.value as "pin" | "password")
                      }
                    >
                      <option value="pin">Account PIN</option>
                      <option value="password">Account password</option>
                    </select>
                  </label>

                  <button
                    className={
                      recoveryMethod !== "email" ? "auth-primary-button" : "auth-text-button"
                    }
                    type="button"
                    disabled={
                      busy ||
                      (recoveryMethod === "email"
                        ? !recoveryEmail.trim()
                        : recoveryMethod === "passkey" && !browserSupportsWebAuthn())
                    }
                    onClick={() => void run(startRecovery)}
                  >
                    {busy
                      ? "Please wait…"
                      : recoveryMethod === "passkey"
                        ? browserSupportsWebAuthn()
                          ? "Recover with passkey"
                          : "Passkeys unavailable in this browser"
                        : recoveryMethod === "approval"
                          ? "Get an approval code"
                          : recoveryMethod === "device"
                            ? nativeDevice && deviceAvailable === false
                              ? "Try device security again"
                              : deviceAvailable === null
                                ? "Checking device security…"
                                : deviceAvailable
                                  ? "Unlock with device security"
                                  : "Device security unavailable"
                            : "Send email recovery code"}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          {stage === "recovery-reset" ? (
            <form
              className="auth-fields"
              onSubmit={(event) => {
                event.preventDefault();
                if (!passwordResetBlocked) void run(verifyAndResetPassword);
              }}
            >
              {recoveryMethod === "email" ? (
                <label>
                  Verification code
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    disabled={busy || recoveryEmailVerified}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </label>
              ) : null}
              {emailPinReset ? (
                <PinFields
                  pin={password}
                  confirmation={passwordConfirmation}
                  setPin={setPassword}
                  setConfirmation={setPasswordConfirmation}
                />
              ) : (
                <PasswordFields
                  password={password}
                  confirmation={passwordConfirmation}
                  setPassword={setPassword}
                  setConfirmation={setPasswordConfirmation}
                />
              )}
              {recoveryMethod === "email" ? (
                <label>
                  MFA code (if enabled)
                  <input
                    autoComplete="one-time-code"
                    value={recoveryMfaCode}
                    onChange={(event) => setRecoveryMfaCode(event.target.value)}
                  />
                </label>
              ) : null}
              <button
                className="auth-primary-button"
                type="submit"
                disabled={passwordResetBlocked}
                aria-busy={busy}
              >
                {busy ? "Working…" : emailPinReset ? "Reset PIN" : "Reset password"}
              </button>
            </form>
          ) : null}
          {stage === "approval-wait" ? (
            <TrustedDeviceRecoveryWait
              identifier={approvalIdentifier}
              onApproved={(session) => void run(() => approvalGranted(session))}
            />
          ) : null}
          {stage === "approval-passkey" ? (
            <div className="auth-fields">
              <button
                className="auth-primary-button"
                type="button"
                disabled={passkeyEnrollment.busy || busy}
                onClick={() => void passkeyEnrollment.enroll()}
              >
                {passkeyEnrollment.busy ? "Creating passkey…" : "Create passkey"}
              </button>
              {passkeyEnrollment.stepUpForm}
              <button
                className="auth-guest-button"
                type="button"
                disabled={passkeyEnrollment.busy || busy}
                onClick={() => void run(continueToCredentialReset)}
              >
                Not now
              </button>
              {passkeyEnrollment.message ? <p role="alert">{passkeyEnrollment.message}</p> : null}
            </div>
          ) : null}
          {stage === "offer-passkey" ? (
            <div className="auth-fields">
              <p>Next time, log in with your fingerprint, face or screen lock.</p>
              <button
                className="auth-primary-button"
                type="button"
                disabled={passkeyEnrollment.busy}
                onClick={() => void passkeyEnrollment.enroll()}
              >
                {passkeyEnrollment.busy ? "Creating passkey…" : "Create passkey"}
              </button>
              {passkeyEnrollment.stepUpForm}
              <button
                className="auth-guest-button"
                type="button"
                disabled={passkeyEnrollment.busy}
                onClick={() => {
                  if (pendingSession !== null) onAuthenticated(pendingSession);
                }}
              >
                Not now
              </button>
              {passkeyEnrollment.message ? <p role="alert">{passkeyEnrollment.message}</p> : null}
            </div>
          ) : null}
          {stage === "create-pin" || stage === "recover-pin" ? (
            <form
              className="auth-fields"
              onSubmit={(event) => {
                event.preventDefault();
                void run(finishPinRecovery);
              }}
            >
              <PinFields
                pin={password}
                confirmation={passwordConfirmation}
                setPin={setPassword}
                setConfirmation={setPasswordConfirmation}
              />
              <button
                className="auth-primary-button"
                type="submit"
                disabled={busy || !/^\d{4}$/u.test(password) || password !== passwordConfirmation}
                aria-busy={busy}
              >
                {busy ? "Working…" : stage === "create-pin" ? "Create PIN" : "Save new PIN"}
              </button>
              {approvalPasskeyCreated && pendingSession !== null ? (
                <button
                  className="auth-guest-button"
                  type="button"
                  disabled={busy}
                  onClick={() => onAuthenticated(pendingSession)}
                >
                  Skip, I will log in with my passkey
                </button>
              ) : null}
            </form>
          ) : null}
          {stage === "mfa" ? (
            <div className="auth-fields">
              <label>
                Second factor
                <select
                  value={mfaFactor}
                  onChange={(event) => setMfaFactor(event.target.value as typeof mfaFactor)}
                >
                  {availableMfaFactors.includes("email") ? (
                    <option value="email">Backup email</option>
                  ) : null}
                  {availableMfaFactors.includes("totp") ? (
                    <option value="totp">Authenticator app</option>
                  ) : null}
                  {availableMfaFactors.includes("recovery_code") ? (
                    <option value="recovery_code">Recovery code</option>
                  ) : null}
                </select>
              </label>
              {mfaFactor === "email" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await apiFetch<{ developmentCode?: string }>(
                        "/auth/mfa/email/challenge",
                        { method: "POST", body: { transactionId } }
                      );
                      setCode(result.developmentCode ?? "");
                      setMessage("A verification code was sent to your verified backup email.");
                    })
                  }
                >
                  Send email code
                </button>
              ) : null}
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
          <button className="auth-guest-button" type="button" disabled={busy} onClick={onCancel}>
            Continue as guest
          </button>
        </div>
      </section>
    </main>
  );
}

function passkeyWasDeclined(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "NotAllowedError") ||
    (error instanceof ApiRequestError &&
      (error.code === "passkey_unknown" || error.code === "passkey_account_mismatch"))
  );
}

export function devicePinRecoveryStage(hasPin: boolean): "create-pin" | "recover-pin" {
  return hasPin ? "recover-pin" : "create-pin";
}

export function devicePinMutationEndpoint(
  stage: "create-pin" | "recover-pin"
): "/auth/pin/setup" | "/auth/pin/recover/device" {
  return stage === "create-pin" ? "/auth/pin/setup" : "/auth/pin/recover/device";
}

function PinFields(props: {
  pin: string;
  confirmation: string;
  setPin: (value: string) => void;
  setConfirmation: (value: string) => void;
}) {
  return (
    <>
      <label>
        New 4-digit PIN
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          autoComplete="new-password"
          value={props.pin}
          onChange={(event) => props.setPin(event.target.value.replace(/\D/gu, ""))}
        />
      </label>
      <label>
        Confirm new PIN
        <input
          type="password"
          inputMode="numeric"
          maxLength={4}
          autoComplete="new-password"
          value={props.confirmation}
          onChange={(event) => props.setConfirmation(event.target.value.replace(/\D/gu, ""))}
        />
      </label>
    </>
  );
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
