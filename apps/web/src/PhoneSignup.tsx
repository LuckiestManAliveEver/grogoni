import { useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import type { AuthSessionView } from "@grogoni/shared-types";
import { normalizePhoneInput, phoneNormalizationErrorMessage } from "@grogoni/shared-types";
import { getCountryCallingCode, type CountryCode } from "libphonenumber-js";
import { AppIcon } from "./AppIcon";
import { ApiRequestError, apiFetch } from "./lib/api";
import { authenticationPhoneCountries, PhoneNumberField } from "./PhoneNumberField";
import { getUserFacingErrorMessage } from "./user-facing-error";

type SignupStage = "phone" | "profile" | "passkey";

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
  const passkeyAvailable = browserSupportsWebAuthn();
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

  async function startSignup() {
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
    setStage("passkey");
    setMessage("Your account is ready. You can also add a passkey as a backup way in.");
  }

  async function createPasskey() {
    if (createdSession === null) return;
    if (!browserSupportsWebAuthn()) {
      setMessage("Passkeys are unavailable in this browser. Your password still works.");
      return;
    }
    const challenge = await apiFetch<{
      ceremonyId: string;
      options: Parameters<typeof startRegistration>[0]["optionsJSON"];
    }>("/auth/passkeys/register/options", { method: "POST", body: {} });
    const response = await startRegistration({ optionsJSON: challenge.options });
    await apiFetch("/auth/passkeys/register/verify", {
      method: "POST",
      body: { ceremonyId: challenge.ceremonyId, label: "Signup device", response }
    });
    onAuthenticated(createdSession);
  }

  function goBack() {
    if (stage === "passkey") {
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
            <span className={stage === "passkey" ? "complete" : ""} />
          </div>

          <div className="auth-onboarding-heading">
            <p className="eyebrow">CREATE YOUR ACCOUNT</p>
            <h1 id="signup-title">
              {stage === "phone"
                ? "Connect with your market"
                : stage === "profile"
                  ? "Finish your profile"
                  : "Secure your account"}
            </h1>
            <p>
              {stage === "phone"
                ? "Your phone number becomes your Grogoni account identity. No SMS code is required."
                : stage === "profile"
                  ? `Set up the account attached to ${normalizedPhone}.`
                  : "Optionally add a passkey as a backup way in if you ever lose access to your password."}
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
              </label>
              <label>
                Email address <span className="auth-optional-label">Optional</span>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <label>
                Password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label>
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={256}
                  value={passwordConfirmation}
                  disabled={busy}
                  onChange={(event) => setPasswordConfirmation(event.target.value)}
                />
              </label>

              <fieldset className="auth-consent-group">
                <legend>Account agreements</legend>
                <label className="auth-option-row">
                  <input
                    type="checkbox"
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
                    checked={privacyAccepted}
                    disabled={busy}
                    onChange={(event) => setPrivacyAccepted(event.target.checked)}
                  />
                  <span>
                    I acknowledge the <a href="/privacy">Privacy Policy</a>.
                  </span>
                </label>
              </fieldset>

              <button
                className="auth-primary-button"
                type="button"
                disabled={
                  busy ||
                  displayName.trim().length < 2 ||
                  !termsAccepted ||
                  !privacyAccepted ||
                  password.length < 10 ||
                  password !== passwordConfirmation
                }
                aria-busy={busy}
                onClick={() => void run(completeSignup)}
              >
                {busy ? "Creating account…" : "Create account"}
              </button>
            </div>
          ) : (
            <div className="auth-fields auth-passkey-enrollment">
              <div className="auth-security-summary">
                <strong>Optional: add a passkey as a backup</strong>
                <p>
                  Your password already gets you back in. A passkey uses your device unlock and can
                  serve as a backup way in if you ever lose access to your password.
                </p>
              </div>
              <button
                className="auth-primary-button"
                type="button"
                disabled={busy || !passkeyAvailable}
                aria-busy={busy}
                onClick={() => void run(createPasskey)}
              >
                {busy
                  ? "Creating passkey…"
                  : passkeyAvailable
                    ? "Create a passkey"
                    : "Passkeys unavailable"}
              </button>
              {createdSession !== null ? (
                <button
                  className="auth-guest-button"
                  type="button"
                  disabled={busy}
                  onClick={() => onAuthenticated(createdSession)}
                >
                  Do this later
                </button>
              ) : null}
            </div>
          )}

          {message ? (
            <div className="auth-feedback" role="alert">
              <p>{message}</p>
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
