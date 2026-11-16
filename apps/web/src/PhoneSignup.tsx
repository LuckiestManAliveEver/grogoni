import { useEffect, useState } from "react";
import { deviceSecurityAvailable, enrollDeviceRecovery } from "./passkey-recovery";
import { isNativeDeviceHost } from "./device-messaging";
import { browserSupportsWebAuthn } from "./browser-passkeys";
import { usePasskeyEnrollment } from "./usePasskeyEnrollment";
import type { AuthSessionView } from "@grogoni/shared-types";
import { normalizePhoneInput, phoneNormalizationErrorMessage } from "@grogoni/shared-types";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";
import { AppIcon } from "./AppIcon";
import { ApiRequestError, apiFetch } from "./lib/api";
import { authenticationPhoneCountries, PhoneNumberField } from "./PhoneNumberField";
import { getUserFacingErrorMessage } from "./user-facing-error";

type SignupStage = "phone" | "profile" | "device";

interface SignupTransaction {
  transactionId: string;
  expiresAt: string;
  verificationRequired: boolean;
}

interface Props {
  onAuthenticated: (session: AuthSessionView) => void;
  onLogIn: () => void;
  onCancel: () => void;
}

export default function PhoneSignup({ onAuthenticated, onLogIn, onCancel }: Props) {
  const nativeDevice = isNativeDeviceHost();
  const supportsPasskey = browserSupportsWebAuthn();
  const [deviceAvailable, setDeviceAvailable] = useState(false);
  useEffect(() => {
    if (!nativeDevice) return;
    let active = true;
    void deviceSecurityAvailable().then((available) => {
      if (active) setDeviceAvailable(available);
    });
    return () => {
      active = false;
    };
  }, [nativeDevice]);
  const [stage, setStage] = useState<SignupStage>("phone");
  const [country, setCountry] = useState<CountryCode>("KE");
  const [phone, setPhone] = useState("");
  const [normalizedPhone, setNormalizedPhone] = useState("");
  const [transaction, setTransaction] = useState<SignupTransaction | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [accountExists, setAccountExists] = useState(false);
  const [createdSession, setCreatedSession] = useState<AuthSessionView | null>(null);
  const profileRequirements = [
    ...(displayName.trim().length < 2 || displayName.trim().length > 100
      ? ["Enter a display name between 2 and 100 characters."]
      : []),
    ...(password.length < 10 || password.length > 256
      ? ["Use a password between 10 and 256 characters."]
      : []),
    ...(!passwordConfirmation || password !== passwordConfirmation
      ? ["Confirm your password with an exact match."]
      : []),
    ...(!termsAccepted ? ["Agree to the Terms of Service."] : []),
    ...(!privacyAccepted ? ["Acknowledge the Privacy Policy."] : [])
  ];
  const enrollment = usePasskeyEnrollment({
    onCreated: () => {
      if (createdSession !== null) onAuthenticated(createdSession);
    }
  });

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setAccountExists(error instanceof ApiRequestError && error.code === "account_exists");
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  // The guest's access cookie lasts 15 minutes. Signup must arrive with a live one, or it would
  // create a separate account instead of upgrading the guest's own.
  async function refreshGuestSession() {
    await apiFetch("/auth/bootstrap").catch(() => null);
  }

  async function startSignup() {
    await refreshGuestSession();
    const normalized = normalizePhoneInput({
      rawInput: phone,
      selectedCountry: country,
      selectedCallingCode: getCountryCallingCode(country)
    });
    if (!normalized.valid) {
      setMessage(phoneNormalizationErrorMessage(normalized.error));
      return;
    }

    const result = await apiFetch<SignupTransaction>("/auth/signup/start", {
      method: "POST",
      body: {
        type: "phone",
        identifier: normalized.e164,
        country: normalized.country
      },
      skipAuthRefresh: true
    });
    setAccountExists(false);
    setTransaction(result);
    setNormalizedPhone(normalized.e164);
    setCountry(normalized.country);
    setPhone(normalized.nationalNumber);
    setStage("profile");
  }

  async function completeSignup() {
    if (transaction === null) return;
    const trimmedName = displayName.trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      setMessage("Enter your display name.");
      return;
    }
    const trimmedEmail = email.trim().toLowerCase();
    if (trimmedEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(trimmedEmail)) {
      setMessage("Enter a valid email address or leave it blank.");
      return;
    }
    if (password.length < 10 || password.length > 256) {
      setMessage("Use a password between 10 and 256 characters.");
      return;
    }
    if (password !== passwordConfirmation) {
      setMessage("Passwords do not match.");
      return;
    }
    if (!termsAccepted || !privacyAccepted) {
      setMessage("Accept the Terms and Privacy Policy to continue.");
      return;
    }

    await refreshGuestSession();
    const session = await apiFetch<AuthSessionView>("/auth/signup/complete", {
      method: "POST",
      body: {
        transactionId: transaction.transactionId,
        displayName: trimmedName,
        ...(trimmedEmail ? { email: trimmedEmail } : {}),
        password,
        passwordConfirmation,
        termsAccepted,
        privacyAccepted
      },
      skipAuthRefresh: true
    });
    setCreatedSession(session);
    setStage("device");
    setMessage(
      nativeDevice
        ? "Your account is ready. Secure this device to recover your PIN or password."
        : "Your account is ready. Create a passkey for account access and recovery."
    );
  }

  async function createDevice() {
    if (createdSession === null) return;
    await enrollDeviceRecovery();
    onAuthenticated(createdSession);
  }

  function goBack() {
    if (stage === "device") {
      if (createdSession !== null) onAuthenticated(createdSession);
      return;
    }
    if (stage === "profile") {
      setStage("phone");
      setTransaction(null);
      setMessage("");
      return;
    }
    onCancel();
  }

  return (
    <main className="auth-onboarding" aria-busy={busy}>
      <section className="auth-onboarding-card" aria-labelledby="signup-title">
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
            className="auth-progress"
            aria-label={`Step ${stage === "phone" ? 1 : stage === "profile" ? 2 : 3} of 3`}
          >
            <span className="complete" />
            <span className={stage !== "phone" ? "complete" : ""} />
            <span className={stage === "device" ? "complete" : ""} />
          </div>

          <div className="auth-onboarding-heading">
            <p className="eyebrow">CREATE YOUR ACCOUNT</p>
            <h1 id="signup-title">
              {stage === "phone"
                ? "Connect with your market"
                : stage === "profile"
                  ? "Finish your profile"
                  : nativeDevice
                    ? "Secure your account"
                    : "Create your passkey"}
            </h1>
            <p>
              {stage === "phone"
                ? "Your phone number becomes your Grogoni account identity. No SMS code is required."
                : stage === "profile"
                  ? `Set up the account attached to ${normalizedPhone}.`
                  : nativeDevice
                    ? "Save a secure recovery key on this device in case you forget your PIN or password."
                    : "Save a passkey with your browser or password manager for account access and recovery."}
            </p>
          </div>

          {stage === "phone" ? (
            <div className="auth-fields">
              <PhoneNumberField
                country={country}
                value={phone}
                countries={authenticationPhoneCountries}
                onCountryChange={setCountry}
                onValueChange={setPhone}
                autoFocus
                disabled={busy}
                helpText="We normalize international numbers and do not send an SMS verification code."
              />
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy || !phone.trim()}
                aria-busy={busy}
                onClick={() => void run(startSignup)}
              >
                {busy ? "Checking number…" : "Continue"}
              </button>
              <div className="auth-intent-switch">
                <span>Already have an account?</span>
                <button className="auth-text-button" type="button" onClick={onLogIn}>
                  Log in
                </button>
              </div>
              <button className="auth-guest-button" type="button" onClick={onCancel}>
                Continue to marketplace as guest
              </button>
            </div>
          ) : stage === "profile" ? (
            <div className="auth-fields">
              <label>
                Display name
                <input
                  required
                  aria-describedby="signup-name-help"
                  autoFocus
                  type="text"
                  autoComplete="name"
                  minLength={2}
                  maxLength={100}
                  placeholder="How people will know you"
                  value={displayName}
                  disabled={busy}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <small id="signup-name-help">Required. Use between 2 and 100 characters.</small>
              </label>
              <label>
                Backup email <span className="auth-optional-label">Optional</span>
                <input
                  type="email"
                  aria-describedby="signup-email-help"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <small id="signup-email-help">
                  Leave blank or enter a valid email address. Verify it in account security to use
                  it for backup recovery and MFA.
                </small>
              </label>

              <label>
                Password
                <input
                  required
                  aria-describedby="signup-password-help"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <small id="signup-password-help">
                  Required. Use between 10 and 256 characters.
                </small>
              </label>
              <label>
                Confirm password
                <input
                  required
                  aria-describedby="signup-confirmation-help"
                  aria-invalid={
                    passwordConfirmation.length > 0 && password !== passwordConfirmation
                  }
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  value={passwordConfirmation}
                  disabled={busy}
                  onChange={(event) => setPasswordConfirmation(event.target.value)}
                />
                <small id="signup-confirmation-help" aria-live="polite">
                  {passwordConfirmation.length > 0
                    ? password === passwordConfirmation
                      ? "Passwords match."
                      : "Passwords do not match. Enter the same password in both fields."
                    : "Required. Enter the same password again."}
                </small>
              </label>

              <fieldset className="auth-consent-group">
                <legend>Account agreements — both required</legend>
                <label className="auth-option-row">
                  <input
                    type="checkbox"
                    required
                    checked={termsAccepted}
                    disabled={busy}
                    onChange={(event) => setTermsAccepted(event.target.checked)}
                  />
                  <span>
                    I agree to the <a href="/terms">Terms of Service</a>.
                  </span>
                </label>
                <label className="auth-option-row">
                  <input
                    type="checkbox"
                    required
                    checked={privacyAccepted}
                    disabled={busy}
                    onChange={(event) => setPrivacyAccepted(event.target.checked)}
                  />
                  <span>
                    I acknowledge the <a href="/privacy">Privacy Policy</a>.
                  </span>
                </label>
              </fieldset>

              <div id="signup-requirements" aria-live="polite">
                {profileRequirements.length > 0 ? (
                  <>
                    <small>To enable Create account:</small>
                    <ul>
                      {profileRequirements.map((requirement) => (
                        <li key={requirement}>{requirement}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <small>All required fields are complete. You can create your account.</small>
                )}
              </div>
              <button
                className="auth-primary-button"
                type="button"
                aria-describedby="signup-requirements"
                disabled={busy || profileRequirements.length > 0}
                aria-busy={busy}
                onClick={() => void run(completeSignup)}
              >
                {busy ? "Creating account…" : "Create account"}
              </button>
            </div>
          ) : (
            <div className="auth-fields auth-device-enrollment">
              <div className="auth-security-summary">
                <strong>
                  {nativeDevice ? "Secure this device for recovery" : "Add a passkey"}
                </strong>
                <p>
                  {nativeDevice
                    ? "Use your existing fingerprint, face unlock, or device screen lock to recover your PIN or password. Enable recovery on this phone before you need it."
                    : "Your browser will help you create a passkey and may ask for your fingerprint, face, or screen lock. Register it now so you can recover your account later."}
                </p>
              </div>
              <button
                className="auth-primary-button"
                type="button"
                disabled={
                  busy ||
                  enrollment.busy ||
                  (supportsPasskey ? false : nativeDevice ? !deviceAvailable : true)
                }
                aria-busy={busy || enrollment.busy}
                onClick={() => void (supportsPasskey ? enrollment.enroll() : run(createDevice))}
              >
                {busy || enrollment.busy
                  ? supportsPasskey
                    ? "Creating passkey…"
                    : "Securing device…"
                  : supportsPasskey
                    ? "Create passkey"
                    : !nativeDevice
                      ? "Passkeys unavailable in this browser"
                      : deviceAvailable
                        ? "Secure this device"
                        : "Device security unavailable"}
              </button>
              {nativeDevice && supportsPasskey ? (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || enrollment.busy || !deviceAvailable}
                  onClick={() => void run(createDevice)}
                >
                  Use Android screen-lock recovery instead
                </button>
              ) : null}
              {enrollment.stepUpForm}
              {createdSession !== null ? (
                <button
                  className="auth-guest-button"
                  type="button"
                  disabled={busy || enrollment.busy}
                  onClick={() => onAuthenticated(createdSession)}
                >
                  Do this later
                </button>
              ) : null}
            </div>
          )}

          {message || enrollment.message ? (
            <div className="auth-feedback" role="alert">
              <p>{enrollment.message || message}</p>
              {accountExists ? (
                <button className="auth-text-button" type="button" onClick={onLogIn}>
                  Log in to this account
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
