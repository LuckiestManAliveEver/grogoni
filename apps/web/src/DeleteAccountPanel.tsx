import { useEffect, useState } from "react";

import { getJson, postJson } from "./api-helpers";
import { getErrorMessage } from "./chat-message-plumbing";
import { routes } from "./routes";
import type {
  AccountDeletionRequestSummary,
  ShopDeletionPreviewSummary,
  ShopDeletionRequestResult
} from "./grogoni-application-shared";

export function sanitizePin(value: string): string {
  return value.replace(/\D/g, "").slice(0, 4);
}

export function isValidPin(value: string): boolean {
  return /^\d{4}$/.test(value);
}

export interface DeleteAccountPanelProps {
  business: { id: string; name: string; grogoniId: string };
  pendingProfileAction: string | null;
  runProfileAction: (key: string, action: () => Promise<void>) => Promise<void>;
  setProfileMessage: (message: string) => void;
  onScheduleAccountDeletion: (input: {
    pin: string;
    confirmation: string;
    reason: string;
  }) => Promise<boolean>;
}

export function DeleteAccountPanel({
  business,
  pendingProfileAction,
  runProfileAction,
  setProfileMessage,
  onScheduleAccountDeletion
}: DeleteAccountPanelProps) {
  const [deletionStep, setDeletionStep] = useState<
    | "idle"
    | "choose"
    | "shop-confirm"
    | "shop-verify"
    | "shop-status"
    | "account-confirm"
    | "account-verify"
  >("idle");
  const [deletionPreview, setDeletionPreview] = useState<ShopDeletionPreviewSummary | null>(null);
  const [deletionRequest, setDeletionRequest] = useState<AccountDeletionRequestSummary | null>(
    null
  );
  const [deletionShopId, setDeletionShopId] = useState("");
  const [deletionPin, setDeletionPin] = useState("");
  const [deletionAcknowledged, setDeletionAcknowledged] = useState(false);
  const [accountDeletionConfirmation, setAccountDeletionConfirmation] = useState("");
  const [accountDeletionReason, setAccountDeletionReason] = useState("");
  const [accountDeletionPin, setAccountDeletionPin] = useState("");
  const [accountDeletionAcknowledged, setAccountDeletionAcknowledged] = useState(false);

  async function loadShopDeletionPreview() {
    try {
      const preview = await getJson<ShopDeletionPreviewSummary>(
        `/businesses/${business.id}/shop-deletion/preview`
      );
      setDeletionPreview(preview);
    } catch {
      setDeletionPreview(null);
    }
  }

  async function startShopDeletion() {
    try {
      const response = await postJson<ShopDeletionRequestResult>(
        `/businesses/${business.id}/shop-deletion/request`,
        {
          shopId: deletionShopId
        }
      );

      setDeletionRequest(response.request);
      setDeletionPreview(response.preview);
      setDeletionStep("shop-verify");
      setProfileMessage("Confirm with your owner PIN. No OTP is required.");
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function finalizeShopDeletion() {
    if (deletionRequest === null) {
      return;
    }

    try {
      const result = await postJson<AccountDeletionRequestSummary>(
        `/businesses/${business.id}/shop-deletion/${deletionRequest.id}/finalize`,
        {
          pin: deletionPin,
          acknowledgement: deletionAcknowledged,
          idempotencyKey: `web-${business.id}-${deletionRequest.id}`
        }
      );
      setDeletionRequest(result);
      setDeletionStep("shop-status");
      setProfileMessage(
        result.status === "QUARANTINED"
          ? "Shop hidden and quarantined. You can restore it for 30 days."
          : "Shop deletion is being processed."
      );
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function restoreShop() {
    if (deletionRequest === null) return;
    try {
      const result = await postJson<AccountDeletionRequestSummary>(
        `/businesses/${business.id}/shop-deletion/${deletionRequest.id}/restore`,
        {}
      );
      setDeletionRequest(result);
      setProfileMessage("Shop restored to active service.");
      await loadShopDeletionPreview();
    } catch (error) {
      setProfileMessage(getErrorMessage(error));
    }
  }

  async function finalizeAccountDeletion() {
    const deleted = await onScheduleAccountDeletion({
      pin: accountDeletionPin,
      confirmation: accountDeletionConfirmation,
      reason: accountDeletionReason
    });

    if (!deleted) {
      setProfileMessage("The account deletion request could not be completed.");
    }
  }

  function cancelDeletion() {
    setDeletionStep("idle");
    setDeletionShopId("");
    setDeletionPin("");
    setDeletionAcknowledged(false);
    setAccountDeletionConfirmation("");
    setAccountDeletionReason("");
    setAccountDeletionPin("");
    setAccountDeletionAcknowledged(false);
  }

  useEffect(() => {
    void loadShopDeletionPreview();
  }, [business.id]);

  return (
    <div className="record-form danger-zone-card">
      <div className="section-heading">
        <p className="eyebrow">Danger zone</p>
        <h3>Delete account</h3>
      </div>
      <p className="security-warning">
        Choose whether to delete only this shop or your entire Grogoni account.
      </p>
      {deletionStep === "idle" ? (
        <button
          className="destructive-button"
          type="button"
          onClick={() => setDeletionStep("choose")}
        >
          Delete account
        </button>
      ) : null}
      {deletionStep === "choose" ? (
        <div className="shop-deletion-card">
          <div className="storefront-card-header">
            <div>
              <span>Choose deletion scope</span>
              <strong>Shop or entire account</strong>
            </div>
            <button className="secondary" type="button" onClick={cancelDeletion}>
              Cancel
            </button>
          </div>
          <div className="connected-social-list" aria-label="Deletion options">
            <article className="connected-social-card">
              <div>
                <span>Current shop</span>
                <strong>Delete this shop only</strong>
                <p>
                  Hides {business.name} immediately and schedules its business data for purge. Your
                  Grogoni login and other shops remain active.
                </p>
              </div>
              <button type="button" onClick={() => setDeletionStep("shop-confirm")}>
                Delete this shop
              </button>
            </article>
            <article className="connected-social-card">
              <div>
                <span>Entire account</span>
                <strong>Delete your Grogoni account</strong>
                <p>
                  Disables your login, revokes every session, and schedules all associated personal
                  and shop data for deletion.
                </p>
              </div>
              <button
                className="destructive-button"
                type="button"
                onClick={() => setDeletionStep("account-confirm")}
              >
                Delete entire account
              </button>
            </article>
          </div>
          <a href={routes.accountDeletion}>Read the account-deletion process</a>
        </div>
      ) : null}
      {deletionStep === "shop-confirm" ? (
        <div className="shop-deletion-card">
          <div className="storefront-card-header">
            <div>
              <span>Delete this shop</span>
              <strong>Step 1 of 2</strong>
            </div>
            <button className="secondary" type="button" onClick={() => setDeletionStep("choose")}>
              Back
            </button>
          </div>
          <p>This will remove:</p>
          <ul>
            <li>Products and catalogue</li>
            <li>Customers, suppliers and sales agents</li>
            <li>Sales, invoices and payments</li>
            <li>Messages, notifications and context scripts</li>
            <li>Uploaded business files and connected services</li>
          </ul>
          {deletionPreview === null ? null : (
            <div className="supplier-card-metrics">
              <span>Products: {deletionPreview.counts.products}</span>
              <span>Customers: {deletionPreview.counts.customers}</span>
              <span>Suppliers: {deletionPreview.counts.suppliers}</span>
              <span>Sales records: {deletionPreview.counts.salesRecords}</span>
              <span>Files: {deletionPreview.counts.uploadedFiles}</span>
            </div>
          )}
          <label>
            Type the shop ID to continue
            <input
              value={deletionShopId}
              onChange={(event) => setDeletionShopId(event.target.value)}
              placeholder={business.grogoniId}
            />
          </label>
          <div className="row-actions">
            <button className="secondary" type="button" onClick={cancelDeletion}>
              Cancel
            </button>
            <button
              type="button"
              disabled={deletionShopId !== business.grogoniId || pendingProfileAction !== null}
              onClick={() => void runProfileAction("shop-deletion-start", startShopDeletion)}
              aria-busy={pendingProfileAction === "shop-deletion-start"}
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}
      {deletionStep === "shop-verify" ? (
        <div className="shop-deletion-card">
          <div className="storefront-card-header">
            <div>
              <span>Verify deletion</span>
              <strong>Step 2 of 2</strong>
            </div>
            <button
              className="secondary"
              type="button"
              onClick={() => setDeletionStep("shop-confirm")}
            >
              Back
            </button>
          </div>
          <p>
            Confirm this request with your owner PIN. OTP is reserved for lost-account recovery.
          </p>
          <label>
            Login PIN
            <input
              autoFocus
              value={deletionPin}
              type="password"
              inputMode="numeric"
              maxLength={4}
              onChange={(event) => setDeletionPin(sanitizePin(event.target.value))}
            />
          </label>
          <label className="checkbox-row">
            <input
              checked={deletionAcknowledged}
              type="checkbox"
              onChange={(event) => setDeletionAcknowledged(event.target.checked)}
            />
            I understand the shop will be hidden now and permanently purged after 30 days.
          </label>
          <div className="row-actions">
            <button className="secondary" type="button" onClick={cancelDeletion}>
              Cancel
            </button>
            <button
              className="destructive-button"
              type="button"
              disabled={
                !isValidPin(deletionPin) || !deletionAcknowledged || pendingProfileAction !== null
              }
              onClick={() => void runProfileAction("shop-deletion-finalize", finalizeShopDeletion)}
              aria-busy={pendingProfileAction === "shop-deletion-finalize"}
            >
              Quarantine shop
            </button>
          </div>
        </div>
      ) : null}
      {deletionStep === "shop-status" ? (
        <div className="shop-deletion-card" role="status">
          <strong>{deletionRequest?.status ?? "Processing"}</strong>
          <p>
            {deletionRequest?.status === "QUARANTINED"
              ? `This shop is hidden. Restore it before ${new Date(
                  deletionRequest.anonymizeAfter
                ).toLocaleDateString()}.`
              : deletionRequest?.status === "RESTORED"
                ? "This shop has been restored."
                : "Your shop deletion is being processed. You can close this screen."}
          </p>
          {deletionRequest?.status === "QUARANTINED" ? (
            <button
              type="button"
              onClick={() => void runProfileAction("shop-restore", restoreShop)}
              disabled={pendingProfileAction !== null}
              aria-busy={pendingProfileAction === "shop-restore"}
            >
              {pendingProfileAction === "shop-restore" ? "Restoring…" : "Restore shop"}
            </button>
          ) : null}
        </div>
      ) : null}
      {deletionStep === "account-confirm" ? (
        <div className="shop-deletion-card">
          <div className="storefront-card-header">
            <div>
              <span>Delete entire account</span>
              <strong>Step 1 of 2</strong>
            </div>
            <button className="secondary" type="button" onClick={() => setDeletionStep("choose")}>
              Back
            </button>
          </div>
          <p>
            Access is disabled immediately. Recoverable data is held for up to 30 days and then
            deleted or irreversibly anonymized, except records retained for legal, security,
            fraud-prevention, or regulatory reasons.
          </p>
          <label>
            Type DELETE to confirm
            <input
              value={accountDeletionConfirmation}
              onChange={(event) => setAccountDeletionConfirmation(event.target.value)}
            />
          </label>
          <label>
            Deletion reason
            <input
              value={accountDeletionReason}
              onChange={(event) => setAccountDeletionReason(event.target.value)}
            />
          </label>
          <div className="row-actions">
            <button className="secondary" type="button" onClick={cancelDeletion}>
              Cancel
            </button>
            <button
              className="destructive-button"
              type="button"
              disabled={accountDeletionConfirmation !== "DELETE"}
              onClick={() => setDeletionStep("account-verify")}
            >
              Continue to verification
            </button>
          </div>
        </div>
      ) : null}
      {deletionStep === "account-verify" ? (
        <div
          className="account-deletion-verification"
          role="group"
          aria-label="Verify account deletion"
        >
          <div className="storefront-card-header">
            <div>
              <span>Delete entire account</span>
              <strong>Step 2 of 2</strong>
            </div>
            <button
              className="secondary"
              type="button"
              onClick={() => setDeletionStep("account-confirm")}
              disabled={pendingProfileAction !== null}
            >
              Back
            </button>
          </div>
          <p>
            Enter your owner PIN. If accepted, every active session is revoked. You can restore the
            account through the authenticated recovery screen for up to 30 days.
          </p>
          <label>
            Owner PIN
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              maxLength={4}
              value={accountDeletionPin}
              onChange={(event) => setAccountDeletionPin(sanitizePin(event.target.value))}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={accountDeletionAcknowledged}
              onChange={(event) => setAccountDeletionAcknowledged(event.target.checked)}
            />
            I understand that all account access is disabled immediately and permanent purge is
            scheduled after the recovery window.
          </label>
          <div className="row-actions">
            <button
              className="secondary"
              type="button"
              onClick={cancelDeletion}
              disabled={pendingProfileAction !== null}
            >
              Cancel
            </button>
            <button
              className="destructive-button"
              type="button"
              data-testid="delete-account-confirm"
              disabled={
                !isValidPin(accountDeletionPin) ||
                !accountDeletionAcknowledged ||
                pendingProfileAction !== null
              }
              aria-busy={pendingProfileAction === "account-deletion"}
              onClick={() => void runProfileAction("account-deletion", finalizeAccountDeletion)}
            >
              {pendingProfileAction === "account-deletion"
                ? "Deleting account…"
                : "Delete account and associated data"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
