import { Suspense, useEffect, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";

import type {
  ConnectedMailboxOAuthStartSummary,
  ConnectedMailboxProvider,
  ConnectedMailboxProviderSummary,
  ConnectedMailboxSummary,
  ConnectedMailboxSyncSummary,
  PasskeySummary
} from "@grogoni/shared-types";

import { prepareDeviceRecoveryCredential, commitDeviceRecoveryCredential } from "./device-recovery";
import { ConnectedSourcesPanel } from "./ConnectedSourcesPanel";
import { normalizeOwnerPhoneInput } from "./phone-identity";
import { formatDate } from "./formatters";
import { PhoneNumberField } from "./PhoneNumberField";
import { deleteJson, getJson, patchJson, postJson, putJson } from "./api-helpers";
import { ApiRequestError } from "./lib/api";
import { recordOnboardingEvent } from "./performance";
import { AuthenticationActionMessage } from "./AuthenticationActionMessage";
import { routes } from "./routes";
import {
  getCountryDialCode,
  getCountryDialCodeByCountry,
  inferCountryCode
} from "./country-dial-codes";
import { getErrorMessage } from "./chat-message-plumbing";
import {
  AccountBackendControls,
  type ActiveBusiness,
  type ConnectedSocialAccountSummary,
  type ConnectedSocialAccountsResponse,
  type CountryDialCode,
  type OAuthProviderSummary,
  type OAuthStartResponse,
  type PasskeyListResponse,
  type PasskeyRegistrationOptionsResponse,
  type SessionResponse,
  type SocialSignupProvider,
  pendingOAuthStorageKey,
  phoneCountryOptions
} from "./grogoni-application-shared";

export function passkeyDeviceLabel(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "This device";
  return `${platform} passkey`;
}

export interface IdentitySecurityPanelProps {
  accountId: string;
  identityLevel: SessionResponse["account"]["identityLevel"];
  business: ActiveBusiness;
  oauthProviders: OAuthProviderSummary[];
  ownerUser: SessionResponse["user"] | null;
  registeredEmail: string | null;
  onAccountMerged: (session: SessionResponse) => void;
  onOwnerUserChange: (user: SessionResponse["user"]) => void;
  onIdentityLevelChange: (identityLevel: SessionResponse["account"]["identityLevel"]) => void;
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  profileMessage: string;
  setProfileMessage: (message: string) => void;
}

export function IdentitySecurityPanel({
  accountId,
  identityLevel,
  business,
  oauthProviders,
  ownerUser,
  registeredEmail,
  onAccountMerged,
  onOwnerUserChange,
  onIdentityLevelChange,
  pendingProfileAction,
  runProfileAction,
  profileMessage,
  setProfileMessage
}: IdentitySecurityPanelProps) {
  const [connectedSocialAccounts, setConnectedSocialAccounts] = useState<
    ConnectedSocialAccountSummary[]
  >([]);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeyLabels, setPasskeyLabels] = useState<Record<string, string>>({});
  const [mfaFactors, setMfaFactors] = useState<
    Array<{ id: string; type: "totp"; createdAt: string }>
  >([]);
  const [pendingTotp, setPendingTotp] = useState<{
    factorId: string;
    secret: string;
    otpauthUri: string;
  } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[]>([]);
  const [credentialStatus, setCredentialStatus] = useState<{
    hasPin: boolean;
    hasPassword: boolean;
  } | null>(null);
  const [accountPinCurrent, setAccountPinCurrent] = useState("");
  const [accountPinNew, setAccountPinNew] = useState("");
  const [accountPinConfirm, setAccountPinConfirm] = useState("");
  const [accountPinMfaCode, setAccountPinMfaCode] = useState("");
  const [accountPinVisible, setAccountPinVisible] = useState(false);
  const [accountPinMessage, setAccountPinMessage] = useState("");
  const [changePasswordCurrent, setChangePasswordCurrent] = useState("");
  const [createPasswordCurrentPin, setCreatePasswordCurrentPin] = useState("");
  const [changePasswordNew, setChangePasswordNew] = useState("");
  const [changePasswordConfirm, setChangePasswordConfirm] = useState("");
  const [changePasswordMfaCode, setChangePasswordMfaCode] = useState("");
  const [businessSocialAccounts, setBusinessSocialAccounts] = useState<
    ConnectedSocialAccountSummary[]
  >([]);
  const [connectedMailboxProviders, setConnectedMailboxProviders] = useState<
    ConnectedMailboxProviderSummary[]
  >([]);
  const [connectedMailboxes, setConnectedMailboxes] = useState<ConnectedMailboxSummary[]>([]);
  const [ownerPhoneCountryCode, setOwnerPhoneCountryCode] = useState<CountryDialCode>(
    inferCountryCode(ownerUser?.phoneNumberE164 ?? "") ?? "+254"
  );
  const [ownerPhoneNumber, setOwnerPhoneNumber] = useState(ownerUser?.phoneNumberE164 ?? "");
  const [ownerPhoneError, setOwnerPhoneError] = useState("");
  const [ownerPhoneMergeRequired, setOwnerPhoneMergeRequired] = useState(false);
  const [ownerPhoneMergePin, setOwnerPhoneMergePin] = useState("");
  const [ownerEmail, setOwnerEmail] = useState(ownerUser?.emailAddress ?? "");
  const [emailChallengeId, setEmailChallengeId] = useState("");
  const [emailVerificationCode, setEmailVerificationCode] = useState("");
  const [emailMergeRequired, setEmailMergeRequired] = useState(false);

  async function loadConnectedSocialAccounts() {
    try {
      const response = await getJson<ConnectedSocialAccountsResponse>("/auth/accounts");
      setConnectedSocialAccounts(response.accounts);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  // Same account identities as loadConnectedSocialAccounts, gated by business:read on this shop
  // instead of plain session ownership - useful for a staff member with shop access who needs to
  // confirm which login methods are attached to the account without leaving the shop context.
  async function loadBusinessSocialAccounts() {
    try {
      const response = await getJson<ConnectedSocialAccountsResponse>(
        `/businesses/${business.id}/social-accounts`
      );
      setBusinessSocialAccounts(response.accounts);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function loadConnectedMailboxes() {
    try {
      const [providerResponse, mailboxResponse] = await Promise.all([
        getJson<{ providers: ConnectedMailboxProviderSummary[] }>(
          `/businesses/${business.id}/mailboxes/providers`
        ),
        getJson<{ mailboxes: ConnectedMailboxSummary[] }>(`/businesses/${business.id}/mailboxes`)
      ]);
      setConnectedMailboxProviders(providerResponse.providers);
      setConnectedMailboxes(mailboxResponse.mailboxes);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function connectMailbox(provider: ConnectedMailboxProvider) {
    const started = await postJson<ConnectedMailboxOAuthStartSummary>(
      `/businesses/${business.id}/mailboxes/oauth/${provider}/start`,
      {}
    );
    window.location.assign(started.authorizationUrl);
  }

  async function updateMailbox(
    mailboxId: string,
    patch: {
      isDefault?: boolean;
      ingestUnknownSenders?: boolean;
      automaticReplyEnabled?: boolean;
      automaticReplyText?: string | null;
    }
  ) {
    await patchJson<ConnectedMailboxSummary>(
      `/businesses/${business.id}/mailboxes/${encodeURIComponent(mailboxId)}`,
      patch
    );
    await loadConnectedMailboxes();
    setProfileMessage("Connected mailbox settings saved.");
  }

  async function syncMailbox(mailboxId: string, historyDays?: number) {
    const result = await postJson<ConnectedMailboxSyncSummary>(
      `/businesses/${business.id}/mailboxes/${encodeURIComponent(mailboxId)}/sync`,
      historyDays === undefined ? {} : { historyDays }
    );
    await loadConnectedMailboxes();
    setProfileMessage(
      `Mailbox synced: ${result.ingested} received, ${result.deduplicated} already known, ${result.filtered} filtered.`
    );
  }

  async function disconnectMailbox(mailboxId: string) {
    await deleteJson<ConnectedMailboxSummary>(
      `/businesses/${business.id}/mailboxes/${encodeURIComponent(mailboxId)}`
    );
    await loadConnectedMailboxes();
    setProfileMessage("Connected mailbox disconnected. Your Grogoni account email was unchanged.");
  }

  async function disconnectBusinessSocialAccount(identityId: string) {
    try {
      await deleteJson<{ disconnected: true; identityId: string }>(
        `/businesses/${business.id}/social-accounts/${encodeURIComponent(identityId)}`
      );
      await loadBusinessSocialAccounts();
      setProfileMessage("Social account disconnected.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function loadPasskeys() {
    if (!browserSupportsWebAuthn()) {
      setPasskeys([]);
      return;
    }

    try {
      const response = await getJson<PasskeyListResponse>("/auth/passkeys");
      setPasskeys(response.passkeys);
      setPasskeyLabels(
        Object.fromEntries(response.passkeys.map((passkey) => [passkey.id, passkey.label]))
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function loadMfaFactors() {
    try {
      const response = await getJson<{
        factors: Array<{ id: string; type: "totp"; createdAt: string }>;
      }>("/auth/mfa/factors");
      setMfaFactors(response.factors);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function loadCredentialStatus() {
    try {
      setCredentialStatus(
        await getJson<{ hasPin: boolean; hasPassword: boolean }>("/auth/credentials/status")
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function beginTotpSetup() {
    try {
      const setup = await postJson<{ factorId: string; secret: string; otpauthUri: string }>(
        "/auth/mfa/totp/setup",
        {}
      );
      setPendingTotp(setup);
      setMfaRecoveryCodes([]);
      setProfileMessage("Add this secret to your authenticator app, then enter its code.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function confirmTotpSetup() {
    if (pendingTotp === null) return;
    try {
      const result = await postJson<{ recoveryCodes: string[] }>("/auth/mfa/totp/confirm", {
        factorId: pendingTotp.factorId,
        code: mfaCode
      });
      setMfaRecoveryCodes(result.recoveryCodes);
      setPendingTotp(null);
      setMfaCode("");
      await loadMfaFactors();
      setProfileMessage("MFA enabled. Save the recovery codes; they are shown once.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function disableTotpFactor(factorId: string) {
    try {
      await deleteJson<{ disabled: true }>(`/auth/mfa/factors/${encodeURIComponent(factorId)}`, {
        code: mfaCode
      });
      setMfaCode("");
      await loadMfaFactors();
      setProfileMessage("MFA disabled.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function regenerateMfaRecoveryCodes() {
    try {
      const result = await postJson<{ recoveryCodes: string[] }>(
        "/auth/mfa/recovery-codes/regenerate",
        {}
      );
      setMfaRecoveryCodes(result.recoveryCodes);
      setProfileMessage("New recovery codes generated. Save them - the old codes no longer work.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function updateOwnerPhone() {
    const selectedCountry = getCountryDialCode(ownerPhoneCountryCode);

    try {
      const normalizedPhone = normalizeOwnerPhoneInput(
        ownerPhoneNumber,
        selectedCountry.countryCode
      );
      const response = await putJson<{ user: SessionResponse["user"] }>("/account/phone", {
        phoneNumber: normalizedPhone,
        country: selectedCountry.countryCode
      });
      onOwnerUserChange(response.user);
      setOwnerPhoneNumber(response.user.phoneNumberE164 ?? normalizedPhone);
      setOwnerPhoneError("");
      setOwnerPhoneMergeRequired(false);
      setOwnerPhoneMergePin("");
      setProfileMessage("Private owner phone number updated. Verification status: unverified.");
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "PHONE_ALREADY_IN_USE") {
        setOwnerPhoneMergeRequired(true);
        setOwnerPhoneError("");
        setProfileMessage(
          "That number belongs to your existing Grogoni account. Enter its PIN to verify ownership and join both accounts without losing data."
        );
        return;
      }
      const message = getErrorMessage(error);
      setOwnerPhoneError(message);
      setProfileMessage(message);
    }
  }

  async function mergeOwnerPhoneAccount() {
    const selectedCountry = getCountryDialCode(ownerPhoneCountryCode);
    const normalizedPhone = normalizeOwnerPhoneInput(ownerPhoneNumber, selectedCountry.countryCode);
    const response = await postJson<SessionResponse>("/auth/identity/merge/pin", {
      method: "phone",
      contact: normalizedPhone,
      pin: ownerPhoneMergePin
    });
    setOwnerPhoneMergeRequired(false);
    setOwnerPhoneMergePin("");
    onAccountMerged(response);
    setProfileMessage("Identity verified. Both accounts and their Grogoni data are now joined.");
  }

  async function startEmailIdentityUpgrade() {
    recordOnboardingEvent("identity_upgrade_started");
    const response = await postJson<{
      challengeId: string;
      developmentCode?: string;
      mergeRequired: boolean;
    }>("/auth/identity/email/start", { email: ownerEmail });
    setEmailChallengeId(response.challengeId);
    setEmailVerificationCode(response.developmentCode ?? "");
    setEmailMergeRequired(response.mergeRequired);
    setProfileMessage(
      response.mergeRequired
        ? "That email belongs to your existing Grogoni account. Enter the emailed code to verify ownership and join both accounts."
        : "Check your email for the verification code."
    );
  }

  async function verifyEmailIdentityUpgrade() {
    if (emailMergeRequired) {
      const merged = await postJson<SessionResponse>("/auth/identity/email/merge/verify", {
        challengeId: emailChallengeId,
        code: emailVerificationCode
      });
      onAccountMerged(merged);
      setEmailChallengeId("");
      setEmailVerificationCode("");
      setEmailMergeRequired(false);
      setProfileMessage("Email verified. Both accounts and their Grogoni data are now joined.");
      return;
    }
    const result = await postJson<{
      verified: true;
      accountId: string;
      identityLevel: "verified_contact" | "strong";
    }>("/auth/identity/email/verify", {
      challengeId: emailChallengeId,
      code: emailVerificationCode
    });
    onIdentityLevelChange(result.identityLevel);
    if (ownerUser !== null) {
      onOwnerUserChange({
        ...ownerUser,
        emailAddress: ownerEmail.trim(),
        emailVerificationStatus: "verified"
      });
    }
    setEmailChallengeId("");
    setEmailVerificationCode("");
    setEmailMergeRequired(false);
    setProfileMessage(
      "Backup email verified. You can now use it for recovery and multi-factor authentication."
    );
  }

  async function registerPasskey() {
    if (!browserSupportsWebAuthn()) {
      setProfileMessage("Passkeys are not supported in this browser.");
      return;
    }

    try {
      const challenge = await postJson<PasskeyRegistrationOptionsResponse>(
        "/auth/passkeys/register/options",
        {}
      );
      const credential = await startRegistration({
        optionsJSON: challenge.options
      });
      await postJson<PasskeySummary>("/auth/passkeys/register/verify", {
        ceremonyId: challenge.ceremonyId,
        label: passkeyDeviceLabel(),
        response: credential
      });
      await loadPasskeys();
      setProfileMessage("Passkey added.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function revokePasskey(credentialId: string) {
    try {
      await deleteJson<{ revoked: true }>(`/auth/passkeys/${encodeURIComponent(credentialId)}`);
      await loadPasskeys();
      setProfileMessage("Passkey revoked.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function renamePasskey(credentialId: string, currentLabel: string, nextLabel: string) {
    const label = nextLabel.trim();
    if (!label || label === currentLabel) return;
    try {
      await patchJson<PasskeySummary>(`/auth/passkeys/${encodeURIComponent(credentialId)}`, {
        label
      });
      await loadPasskeys();
      setProfileMessage("Passkey renamed.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function disconnectSocialAccount(identityId: string) {
    try {
      await deleteJson<{ disconnected: true; identityId: string }>(
        `/auth/accounts/${encodeURIComponent(identityId)}/disconnect`
      );
      await loadConnectedSocialAccounts();
      setProfileMessage("Social account disconnected.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function saveAccountPin() {
    if (credentialStatus === null) return;
    setAccountPinMessage("");
    if (credentialStatus.hasPin && accountPinCurrent.length !== 4) {
      setAccountPinMessage("Enter your current four-digit PIN.");
      return;
    }
    if (accountPinNew.length !== 4) {
      setAccountPinMessage("Choose a four-digit PIN.");
      return;
    }
    if (accountPinNew !== accountPinConfirm) {
      setAccountPinMessage("The new PINs do not match.");
      return;
    }
    if (mfaFactors.length > 0 && accountPinMfaCode.length !== 6) {
      setAccountPinMessage("Enter the six-digit code from your authenticator app.");
      return;
    }
    try {
      await postJson<SessionResponse>(
        credentialStatus.hasPin ? "/auth/pin/change" : "/auth/pin/setup",
        {
          ...(credentialStatus.hasPin ? { currentPin: accountPinCurrent } : {}),
          pin: accountPinNew,
          pinConfirmation: accountPinConfirm,
          ...(accountPinMfaCode.trim() ? { mfaCode: accountPinMfaCode.trim() } : {})
        }
      );
      const changed = credentialStatus.hasPin;
      setAccountPinCurrent("");
      setAccountPinNew("");
      setAccountPinConfirm("");
      setAccountPinMfaCode("");
      await loadCredentialStatus();
      const message = changed
        ? "Your new PIN is ready. Use it the next time you sign in."
        : "Your PIN is ready. You can now use it to sign in.";
      setAccountPinMessage(message);
      setProfileMessage(message);
    } catch (error) {
      const message = getErrorMessage(error);
      setAccountPinMessage(message);
      setProfileMessage(message);
    }
  }

  function accountPinForm() {
    const hasPin = credentialStatus?.hasPin === true;
    const pinInputType = accountPinVisible ? "text" : "password";
    return (
      <form
        className="record-form account-pin-form"
        aria-label="Account login PIN"
        onSubmit={(event) => {
          event.preventDefault();
          void runProfileAction("pin-save", saveAccountPin);
        }}
      >
        <div className="section-heading">
          <p className="eyebrow">Login PIN</p>
          <h4>{hasPin ? "Set a new PIN" : "Create your PIN"}</h4>
          <p>
            {hasPin
              ? "Enter your current PIN, then choose a new four-digit PIN."
              : "Choose a four-digit PIN and enter it again to confirm."}
          </p>
        </div>
        {credentialStatus === null ? (
          <p className="shell-note" role="status">
            Checking your PIN settings…
          </p>
        ) : (
          <>
            {hasPin ? (
              <label>
                Current PIN
                <input
                  type={pinInputType}
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  autoComplete="current-password"
                  minLength={4}
                  maxLength={4}
                  value={accountPinCurrent}
                  onChange={(event) => setAccountPinCurrent(event.target.value.replace(/\D/gu, ""))}
                />
              </label>
            ) : null}
            <label>
              {hasPin ? "New PIN" : "PIN"}
              <input
                type={pinInputType}
                inputMode="numeric"
                pattern="[0-9]{4}"
                autoComplete="new-password"
                minLength={4}
                maxLength={4}
                value={accountPinNew}
                onChange={(event) => setAccountPinNew(event.target.value.replace(/\D/gu, ""))}
              />
            </label>
            <label>
              Confirm {hasPin ? "new PIN" : "PIN"}
              <input
                type={pinInputType}
                inputMode="numeric"
                pattern="[0-9]{4}"
                autoComplete="new-password"
                minLength={4}
                maxLength={4}
                value={accountPinConfirm}
                onChange={(event) => setAccountPinConfirm(event.target.value.replace(/\D/gu, ""))}
              />
            </label>
            <label className="account-pin-visibility">
              <input
                type="checkbox"
                checked={accountPinVisible}
                onChange={(event) => setAccountPinVisible(event.target.checked)}
              />
              Show PIN while typing
            </label>
            {mfaFactors.length > 0 ? (
              <label>
                Authenticator code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  minLength={6}
                  maxLength={6}
                  value={accountPinMfaCode}
                  onChange={(event) => setAccountPinMfaCode(event.target.value.replace(/\D/gu, ""))}
                />
              </label>
            ) : null}
            <button
              type="submit"
              disabled={
                pendingProfileAction !== null ||
                (hasPin && accountPinCurrent.length !== 4) ||
                accountPinNew.length !== 4 ||
                accountPinNew !== accountPinConfirm ||
                (mfaFactors.length > 0 && accountPinMfaCode.length !== 6)
              }
              aria-busy={pendingProfileAction === "pin-save"}
            >
              {pendingProfileAction === "pin-save"
                ? "Saving…"
                : hasPin
                  ? "Save new PIN"
                  : "Create PIN"}
            </button>
          </>
        )}
        {accountPinMessage ? (
          <p className="shell-note" role="status" aria-live="polite">
            <AuthenticationActionMessage message={accountPinMessage} />
          </p>
        ) : null}
      </form>
    );
  }

  async function saveAccountPassword() {
    if (credentialStatus === null) return;
    if (changePasswordNew !== changePasswordConfirm) {
      setProfileMessage("New password and confirmation do not match.");
      return;
    }
    try {
      const result = await postJson<{
        changed?: true;
        created?: true;
        revokedSessions?: number;
      }>(credentialStatus.hasPassword ? "/auth/password/change" : "/auth/password/setup", {
        ...(credentialStatus.hasPassword
          ? { currentPassword: changePasswordCurrent }
          : credentialStatus.hasPin
            ? { currentPin: createPasswordCurrentPin }
            : {}),
        password: changePasswordNew,
        passwordConfirmation: changePasswordConfirm,
        ...(changePasswordMfaCode.trim() ? { mfaCode: changePasswordMfaCode.trim() } : {})
      });
      setChangePasswordCurrent("");
      setCreatePasswordCurrentPin("");
      setChangePasswordNew("");
      setChangePasswordConfirm("");
      setChangePasswordMfaCode("");
      await loadCredentialStatus();
      setProfileMessage(
        result.created
          ? "Password created. You can now use it as a sign-in fallback."
          : (result.revokedSessions ?? 0) > 0
            ? `Password changed. ${result.revokedSessions} other device session(s) were signed out.`
            : "Password changed."
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function reconnectLoginAccount(provider: SocialSignupProvider) {
    const configured = oauthProviders.find((item) => item.id === provider)?.configured === true;
    if (!configured) {
      setProfileMessage("This login provider is not configured yet.");
      return;
    }
    try {
      const response = await postJson<OAuthStartResponse>(
        `/auth/accounts/${encodeURIComponent(provider)}/link/start`,
        { redirectUri: `${window.location.origin}${routes.oauthCallback}` }
      );
      sessionStorage.setItem(
        pendingOAuthStorageKey,
        JSON.stringify({
          csrfToken: response.csrfToken,
          provider: response.provider,
          state: response.state
        })
      );
      setProfileMessage(`Redirecting to ${response.provider} to verify the login account.`);
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  useEffect(() => {
    const savedPhone = ownerUser?.phoneNumberE164;
    if (savedPhone === undefined || savedPhone === null) return;

    setOwnerPhoneNumber(savedPhone);
    setOwnerPhoneCountryCode(inferCountryCode(savedPhone) ?? "+254");
  }, [ownerUser?.phoneNumberE164]);

  useEffect(() => {
    void loadConnectedSocialAccounts();
    void loadBusinessSocialAccounts();
    void loadConnectedMailboxes();
    void loadPasskeys();
    void loadMfaFactors();
    void loadCredentialStatus();
  }, [accountId, business.id]);

  return (
    <div className="record-form shop-profile-card">
      <div className="section-heading">
        <p className="eyebrow">Account</p>
        <h3>Passkeys and login accounts</h3>
        <p>
          Recover your PIN or password with the recovery key stored on this device or your verified
          backup email. Passkeys are available only for account access.
        </p>
        <p className="shell-note">Identity strength: {identityLevel.replace("_", " ")}</p>
      </div>
      <Suspense fallback={<div className="inline-loading-card">Opening account security…</div>}>
        <AccountBackendControls
          accountId={accountId}
          displayName={ownerUser?.displayName ?? ""}
          onDisplayNameChanged={(displayName) =>
            ownerUser === null ? undefined : onOwnerUserChange({ ...ownerUser, displayName })
          }
        />
      </Suspense>
      {accountPinForm()}
      <div className="record-form">
        <div className="section-heading">
          <p className="eyebrow">Private identity contact</p>
          <h4>Owner phone number</h4>
          <p>
            Required for shop identity, recovery, support escalation, and fraud review. It is
            unverified and hidden from customers by default.
          </p>
        </div>
        <PhoneNumberField
          country={getCountryDialCode(ownerPhoneCountryCode).countryCode}
          countries={phoneCountryOptions}
          value={ownerPhoneNumber}
          label="Owner phone number"
          error={ownerPhoneError}
          onCountryChange={(country) => {
            setOwnerPhoneCountryCode(getCountryDialCodeByCountry(country).code);
            setOwnerPhoneError("");
          }}
          onValueChange={(value) => {
            setOwnerPhoneNumber(value);
            setOwnerPhoneError("");
          }}
        />
        <div className="compact-actions">
          <button
            type="button"
            disabled={ownerPhoneNumber.trim().length === 0 || pendingProfileAction !== null}
            aria-busy={pendingProfileAction === "owner-phone-update"}
            onClick={() => void runProfileAction("owner-phone-update", updateOwnerPhone)}
          >
            {pendingProfileAction === "owner-phone-update" ? "Saving…" : "Save phone number"}
          </button>
          <span className="shell-note">
            Status: {ownerUser?.phoneVerificationStatus ?? "unverified"} · Public display: off
          </span>
        </div>
        {ownerPhoneMergeRequired ? (
          <div className="record-form" role="group" aria-label="Join existing phone account">
            <p className="shell-note">
              Verify the PIN for this phone number. Grogoni will move this device account’s chats,
              shops, and records into the verified account and keep this device signed in.
            </p>
            <label>
              Existing account PIN
              <input
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={ownerPhoneMergePin}
                onChange={(event) => setOwnerPhoneMergePin(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => void runProfileAction("owner-phone-merge", mergeOwnerPhoneAccount)}
              disabled={ownerPhoneMergePin.trim().length < 4 || pendingProfileAction !== null}
            >
              {pendingProfileAction === "owner-phone-merge"
                ? "Verifying…"
                : "Verify and join accounts"}
            </button>
          </div>
        ) : null}
      </div>
      <div className="record-form">
        <div className="section-heading">
          <p className="eyebrow">Recovery identity</p>
          <h4>Backup email</h4>
          <p>
            Verify an email for account recovery and multi-factor authentication. Log in with your
            mobile phone number.
          </p>
          {emailMergeRequired ? (
            <p className="shell-note">
              Verification will join this device account’s chats, shops, and records to the existing
              email account.
            </p>
          ) : null}
        </div>
        <label>
          Email address
          <input
            type="email"
            autoComplete="email"
            value={ownerEmail}
            onChange={(event) => setOwnerEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </label>
        {emailChallengeId ? (
          <label>
            Verification code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={emailVerificationCode}
              onChange={(event) => setEmailVerificationCode(event.target.value)}
            />
          </label>
        ) : null}
        <button
          type="button"
          onClick={() =>
            void runProfileAction(
              "owner-email-upgrade",
              emailChallengeId ? verifyEmailIdentityUpgrade : startEmailIdentityUpgrade
            )
          }
          disabled={
            ownerEmail.trim().length === 0 ||
            pendingProfileAction !== null ||
            (emailChallengeId.length > 0 && emailVerificationCode.trim().length === 0)
          }
        >
          {pendingProfileAction === "owner-email-upgrade"
            ? "Working…"
            : emailChallengeId
              ? "Verify email"
              : "Add email"}
        </button>
      </div>
      <div className="connected-social-list" role="group" aria-label="Passkeys">
        {passkeys.map((passkey) => (
          <article className="connected-social-card" key={passkey.id}>
            <div>
              <span>Passkey</span>
              <strong>{passkey.label}</strong>
              <p>{passkey.backedUp ? "Synced or backed up" : "Stored on one device"}</p>
            </div>
            <div className="connected-social-meta">
              <span>Added: {formatDate(passkey.createdAt)}</span>
              <span>
                Last used: {passkey.lastUsedAt === null ? "—" : formatDate(passkey.lastUsedAt)}
              </span>
            </div>
            <div className="row-actions">
              <label>
                Passkey name
                <input
                  type="text"
                  maxLength={80}
                  value={passkeyLabels[passkey.id] ?? passkey.label}
                  onChange={(event) =>
                    setPasskeyLabels((current) => ({
                      ...current,
                      [passkey.id]: event.target.value
                    }))
                  }
                />
              </label>
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null}
                onClick={() =>
                  void runProfileAction("passkey-rename", () =>
                    renamePasskey(
                      passkey.id,
                      passkey.label,
                      passkeyLabels[passkey.id] ?? passkey.label
                    )
                  )
                }
              >
                Rename
              </button>
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null}
                onClick={() =>
                  void runProfileAction("passkey-revoke", () => revokePasskey(passkey.id))
                }
              >
                Revoke
              </button>
            </div>
          </article>
        ))}
      </div>
      <button
        type="button"
        disabled={!browserSupportsWebAuthn() || pendingProfileAction !== null}
        onClick={() => void runProfileAction("passkey-register", registerPasskey)}
      >
        {browserSupportsWebAuthn() ? "Add a passkey for account access" : "Passkeys unavailable"}
      </button>
      <button
        type="button"
        disabled={pendingProfileAction !== null}
        onClick={() =>
          void runProfileAction("device-recovery", async () => {
            const { publicKeyJwk } = await prepareDeviceRecoveryCredential({
              replaceExisting: true
            });
            const secured = await postJson<SessionResponse>("/auth/continue", {
              devicePublicKeyJwk: publicKeyJwk
            });
            if (secured.deviceRecoveryCredentialId) {
              await commitDeviceRecoveryCredential(secured.deviceRecoveryCredentialId);
            }
            setProfileMessage("Device recovery enabled. Protect this device with its screen lock.");
          })
        }
      >
        Enable device recovery
      </button>
      <div className="record-form" role="group" aria-label="Multi-factor authentication">
        <div className="section-heading">
          <p className="eyebrow">Multi-factor authentication</p>
          <h4>Authenticator app</h4>
          <p>MFA is optional. Enabling it adds a second step after password sign-in.</p>
        </div>
        {mfaFactors.map((factor) => (
          <div className="connected-social-card" key={factor.id}>
            <span>Enabled {formatDate(factor.createdAt)}</span>
            <button
              className="secondary"
              type="button"
              disabled={pendingProfileAction !== null || mfaCode.length !== 6}
              onClick={() =>
                void runProfileAction("mfa-disable", () => disableTotpFactor(factor.id))
              }
            >
              Disable with current code
            </button>
          </div>
        ))}
        {pendingTotp !== null ? (
          <>
            <label>
              Authenticator secret
              <input readOnly value={pendingTotp.secret} autoComplete="off" />
            </label>
            <a href={pendingTotp.otpauthUri}>Open authenticator app</a>
            <button
              type="button"
              disabled={mfaCode.length !== 6 || pendingProfileAction !== null}
              onClick={() => void runProfileAction("mfa-confirm", confirmTotpSetup)}
            >
              Confirm authenticator
            </button>
          </>
        ) : mfaFactors.length === 0 ? (
          <button
            type="button"
            disabled={pendingProfileAction !== null}
            onClick={() => void runProfileAction("mfa-setup", beginTotpSetup)}
          >
            Set up authenticator
          </button>
        ) : null}
        <label>
          Authenticator code
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={mfaCode}
            onChange={(event) => setMfaCode(event.target.value.replace(/\D/gu, ""))}
          />
        </label>
        {mfaRecoveryCodes.length > 0 ? (
          <div>
            <strong>Recovery codes (shown once)</strong>
            <pre>{mfaRecoveryCodes.join("\n")}</pre>
          </div>
        ) : null}
        {mfaFactors.length > 0 ? (
          <button
            className="secondary"
            type="button"
            disabled={pendingProfileAction !== null}
            onClick={() =>
              void runProfileAction("mfa-recovery-codes-regenerate", regenerateMfaRecoveryCodes)
            }
          >
            Regenerate recovery codes
          </button>
        ) : null}
      </div>
      <div
        className="record-form"
        role="group"
        aria-label={credentialStatus?.hasPassword ? "Change password" : "Create password"}
      >
        <div className="section-heading">
          <p className="eyebrow">Password fallback</p>
          <h4>{credentialStatus?.hasPassword ? "Change password" : "Create password"}</h4>
          <p>
            Add a recovery fallback or update the password already on this account. PIN and passkey
            sign-in are unaffected.
          </p>
        </div>
        {credentialStatus?.hasPassword ? (
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={changePasswordCurrent}
              onChange={(event) => setChangePasswordCurrent(event.target.value)}
            />
          </label>
        ) : credentialStatus?.hasPin ? (
          <label>
            Current PIN
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={4}
              value={createPasswordCurrentPin}
              onChange={(event) =>
                setCreatePasswordCurrentPin(event.target.value.replace(/\D/gu, ""))
              }
            />
          </label>
        ) : null}
        <label>
          New password
          <input
            type="password"
            minLength={10}
            maxLength={256}
            autoComplete="new-password"
            value={changePasswordNew}
            onChange={(event) => setChangePasswordNew(event.target.value)}
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            minLength={10}
            maxLength={256}
            autoComplete="new-password"
            value={changePasswordConfirm}
            onChange={(event) => setChangePasswordConfirm(event.target.value)}
          />
        </label>
        {mfaFactors.length > 0 ? (
          <label>
            Authenticator code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={changePasswordMfaCode}
              onChange={(event) => setChangePasswordMfaCode(event.target.value.replace(/\D/gu, ""))}
            />
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => void runProfileAction("password-save", saveAccountPassword)}
          disabled={
            credentialStatus === null ||
            pendingProfileAction !== null ||
            (credentialStatus.hasPassword && changePasswordCurrent.length === 0) ||
            (!credentialStatus.hasPassword &&
              credentialStatus.hasPin &&
              createPasswordCurrentPin.length !== 4) ||
            changePasswordNew.length < 10 ||
            changePasswordNew !== changePasswordConfirm ||
            (mfaFactors.length > 0 && changePasswordMfaCode.length !== 6)
          }
          aria-busy={pendingProfileAction === "password-save"}
        >
          {pendingProfileAction === "password-save"
            ? "Saving…"
            : credentialStatus?.hasPassword
              ? "Change password"
              : "Create password"}
        </button>
      </div>
      <div className="connected-social-list">
        {oauthProviders
          .filter((provider) =>
            ["google", "facebook", "tiktok", "x", "linkedin"].includes(provider.id)
          )
          .map((provider) => {
            const connected = connectedSocialAccounts.find(
              (account) => account.provider === provider.id
            );
            return (
              <article className="connected-social-card" key={provider.id}>
                <div>
                  <span>{provider.displayName}</span>
                  <strong>{connected === undefined ? "Disconnected" : "Connected"}</strong>
                  <p>
                    {connected?.displayName ??
                      connected?.email ??
                      (provider.configured ? "Ready to connect" : "Login provider not configured")}
                  </p>
                </div>
                <div className="connected-social-meta">
                  <span>
                    Connected: {connected === undefined ? "—" : formatDate(connected.connectedAt)}
                  </span>
                  <span>
                    Last used:{" "}
                    {connected?.lastUsedAt === null || connected === undefined
                      ? "—"
                      : formatDate(connected.lastUsedAt)}
                  </span>
                </div>
                <div className="row-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() =>
                      void runProfileAction("account-reconnect", () =>
                        reconnectLoginAccount(provider.id)
                      )
                    }
                    disabled={!provider.configured || pendingProfileAction !== null}
                    title={
                      provider.configured ? undefined : "This login provider is not configured yet."
                    }
                  >
                    Reconnect
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    disabled={connected === undefined || pendingProfileAction !== null}
                    onClick={() =>
                      connected === undefined
                        ? undefined
                        : void runProfileAction("account-disconnect", () =>
                            disconnectSocialAccount(connected.id)
                          )
                    }
                  >
                    Disconnect
                  </button>
                </div>
              </article>
            );
          })}
      </div>
      <ConnectedSourcesPanel />
      <div className="section-heading">
        <p className="eyebrow">Connected email channel</p>
        <h4>Mailboxes for customer conversations</h4>
        <p>
          These are authorized business mailboxes used to send and receive customer email. They are
          separate from the backup email used for account recovery and multi-factor authentication.
        </p>
      </div>
      <div className="connected-social-list" role="list" aria-label="Connected mailboxes">
        <article className="connected-social-card" role="listitem">
          <div>
            <span>Grogoni account email</span>
            <strong>{registeredEmail ?? "No account email registered"}</strong>
            <p>
              Backup recovery and multi-factor authentication. This address is not an email channel.
            </p>
          </div>
        </article>
        {connectedMailboxes.map((mailbox) => (
          <article className="connected-social-card" role="listitem" key={mailbox.id}>
            <div>
              <span>{mailbox.provider === "gmail" ? "Gmail" : "Microsoft Outlook"}</span>
              <strong>{mailbox.address}</strong>
              <p>
                {mailbox.status.replaceAll("_", " ")}
                {mailbox.isDefault ? " · default sender" : ""}
              </p>
            </div>
            <div className="connected-social-meta">
              <span>Connected: {formatDate(mailbox.connectedAt)}</span>
              <span>
                Last sync: {mailbox.lastSyncAt === null ? "Never" : formatDate(mailbox.lastSyncAt)}
              </span>
            </div>
            <label>
              <input
                type="checkbox"
                checked={mailbox.ingestUnknownSenders}
                disabled={pendingProfileAction !== null || mailbox.status !== "connected"}
                onChange={(event) =>
                  void runProfileAction(`mailbox-unknown-${mailbox.id}`, () =>
                    updateMailbox(mailbox.id, {
                      ingestUnknownSenders: event.target.checked
                    })
                  )
                }
              />
              Import mail from unknown senders
            </label>
            <label>
              <input
                type="checkbox"
                checked={mailbox.automaticReplyEnabled}
                disabled={pendingProfileAction !== null || mailbox.status !== "connected"}
                onChange={(event) =>
                  void runProfileAction(`mailbox-auto-reply-${mailbox.id}`, () =>
                    updateMailbox(mailbox.id, {
                      automaticReplyEnabled: event.target.checked,
                      automaticReplyText:
                        mailbox.automaticReplyText ??
                        "Thanks for your message. We received it and will follow up shortly."
                    })
                  )
                }
              />
              Send one automatic acknowledgement per thread every 24 hours
            </label>
            <label>
              <span>Automatic acknowledgement</span>
              <textarea
                rows={2}
                maxLength={1000}
                defaultValue={mailbox.automaticReplyText ?? ""}
                disabled={pendingProfileAction !== null || mailbox.status !== "connected"}
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next === (mailbox.automaticReplyText ?? "")) return;
                  void runProfileAction(`mailbox-auto-reply-text-${mailbox.id}`, () =>
                    updateMailbox(mailbox.id, {
                      automaticReplyText: next === "" ? null : next,
                      ...(next === "" ? { automaticReplyEnabled: false } : {})
                    })
                  );
                }}
                placeholder="Acknowledgement text"
              />
            </label>
            <div className="row-actions">
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null || mailbox.status !== "connected"}
                onClick={() =>
                  void runProfileAction(`mailbox-sync-${mailbox.id}`, () => syncMailbox(mailbox.id))
                }
              >
                Sync inbox
              </button>
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null || mailbox.status !== "connected"}
                onClick={() =>
                  void runProfileAction(`mailbox-history-${mailbox.id}`, () =>
                    syncMailbox(mailbox.id, 30)
                  )
                }
              >
                Import 30 days
              </button>
              <button
                className="secondary"
                type="button"
                disabled={
                  pendingProfileAction !== null ||
                  mailbox.isDefault ||
                  mailbox.status !== "connected"
                }
                onClick={() =>
                  void runProfileAction(`mailbox-default-${mailbox.id}`, () =>
                    updateMailbox(mailbox.id, { isDefault: true })
                  )
                }
              >
                Make default
              </button>
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null || mailbox.status === "disconnected"}
                onClick={() =>
                  void runProfileAction(`mailbox-disconnect-${mailbox.id}`, () =>
                    disconnectMailbox(mailbox.id)
                  )
                }
              >
                Disconnect
              </button>
            </div>
          </article>
        ))}
        {connectedMailboxProviders
          .filter((provider) => provider.configured)
          .map((provider) => {
            const alreadyConnected = connectedMailboxes.some(
              (mailbox) => mailbox.provider === provider.provider && mailbox.status === "connected"
            );
            return (
              <article className="connected-social-card" role="listitem" key={provider.provider}>
                <div>
                  <span>{provider.displayName}</span>
                  <strong>{alreadyConnected ? "Add another mailbox" : "Not connected"}</strong>
                  <p>Authorize with OAuth. Grogoni never stores your mailbox password.</p>
                </div>
                <button
                  type="button"
                  disabled={pendingProfileAction !== null}
                  onClick={() =>
                    void runProfileAction(`mailbox-connect-${provider.provider}`, () =>
                      connectMailbox(provider.provider)
                    )
                  }
                >
                  Connect {provider.displayName}
                </button>
              </article>
            );
          })}
      </div>
      <div className="section-heading">
        <p className="eyebrow">{business.name}</p>
        <h4>Login methods visible to this shop</h4>
        <p>
          The same login accounts above, shown through this shop's access rather than your personal
          session - useful when checking access from a shop-scoped view.
        </p>
      </div>
      <div className="connected-social-list" role="list" aria-label="Shop-scoped login accounts">
        {businessSocialAccounts.length === 0 ? (
          <p className="form-hint" role="listitem">
            No connected login accounts for this shop yet.
          </p>
        ) : (
          businessSocialAccounts.map((account) => (
            <article className="connected-social-card" role="listitem" key={account.id}>
              <div>
                <span>{account.providerName}</span>
                <strong>{account.displayName ?? account.email ?? "Connected"}</strong>
              </div>
              <div className="connected-social-meta">
                <span>Connected: {formatDate(account.connectedAt)}</span>
                <span>
                  Last used: {account.lastUsedAt === null ? "—" : formatDate(account.lastUsedAt)}
                </span>
              </div>
              <button
                className="secondary"
                type="button"
                disabled={pendingProfileAction !== null}
                onClick={() =>
                  void runProfileAction("business-account-disconnect", () =>
                    disconnectBusinessSocialAccount(account.id)
                  )
                }
              >
                Disconnect
              </button>
            </article>
          ))
        )}
      </div>
      {profileMessage.length > 0 ? (
        <p className="shell-note">
          <AuthenticationActionMessage message={profileMessage} />
        </p>
      ) : null}
    </div>
  );
}
