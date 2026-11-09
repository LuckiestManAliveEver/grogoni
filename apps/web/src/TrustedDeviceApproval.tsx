import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  RecoveryApprovalOptionsResponse,
  RecoveryApprovalRecentSummary,
  RecoveryApprovalRequestSummary
} from "@grogoni/shared-types";
import { ApiRequestError } from "./lib/api";
import {
  checkRecoveryApprovalCode,
  confirmRecoveryApproval,
  declineRecoveryApproval,
  pendingRecoveryApprovals,
  recoveryApprovalMethod,
  type ApprovalMethodAvailability
} from "./recovery-approval";
import { usePasskeyEnrollment } from "./usePasskeyEnrollment";
import { getUserFacingErrorMessage } from "./user-facing-error";
import "./trusted-device-approval.css";

/** A focused app re-checks at most this often, so the prompt costs one request per visit. */
export const approvalRecheckMs = 30_000;

/**
 * Where the owner is in approving one browser. One value, so the screen can never show a
 * confirmation and an approval at once:
 *
 *   enter_code → confirm   (the code matched; shows which browser asked)
 *   confirm    → approved  (screen lock confirmed) | enter_code (cancelled, failed or declined)
 *   approved   → enter_code (undone, or the prompt dismissed)
 */
type ApprovalStep =
  | { kind: "enter_code" }
  /** The code matched: which browser asked, and the challenge to sign once the owner agrees. */
  | { kind: "confirm"; checked: RecoveryApprovalOptionsResponse }
  | { kind: "approved"; requestId: string; client: string };

const enterCode: ApprovalStep = { kind: "enter_code" };

/**
 * The trusted device's half of recovery approval: the owner types the code shown on the
 * signed-out browser, sees which browser asked, then confirms with this device's screen lock.
 * Until the browser collects its session, the owner can still withdraw the approval.
 *
 * - `prompt`: floats over the app while a request is open, re-checked when the app is focused.
 * - `panel`: always shown in Account security, so the owner can approve without the prompt.
 */
export function TrustedDeviceApproval({ mode }: { mode: "prompt" | "panel" }) {
  const [requests, setRequests] = useState<RecoveryApprovalRequestSummary[]>([]);
  const [recent, setRecent] = useState<RecoveryApprovalRecentSummary[]>([]);
  const [phone, setPhone] = useState<string | null>(null);
  const [method, setMethod] = useState<ApprovalMethodAvailability | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [step, setStep] = useState<ApprovalStep>(enterCode);
  const [needsPasskey, setNeedsPasskey] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** Only a signed-in phone account can approve. Until the server says so, show nothing. */
  const [eligible, setEligible] = useState(false);
  const lastChecked = useRef(0);

  const refresh = useCallback(async () => {
    lastChecked.current = Date.now();
    try {
      const pending = await pendingRecoveryApprovals();
      setRequests(pending.requests);
      setRecent(pending.recentApprovals ?? []);
      setPhone(pending.phone);
      setEligible(true);
      setMethod(await recoveryApprovalMethod(pending.phone));
    } catch {
      // Guests and signed-out screens cannot approve, so neither the prompt nor the panel shows.
      setRequests([]);
      setEligible(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (mode !== "prompt") return;
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastChecked.current >= approvalRecheckMs
      ) {
        setDismissed(false);
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [mode, refresh]);

  const enrollment = usePasskeyEnrollment({
    label: "Approval passkey",
    onCreated: async () => {
      setNeedsPasskey(false);
      setMethod({ method: "passkey" });
      setMessage("Passkey added. Enter the code again to approve.");
    }
  });

  function failed(error: unknown) {
    if (error instanceof ApiRequestError && error.code === "recovery_approval_passkey_missing") {
      setNeedsPasskey(true);
      setMessage("Add a passkey on this device first. It uses this device's screen lock.");
    } else if (error instanceof Error && error.name === "NotAllowedError") {
      setMessage("Screen lock confirmation was cancelled. Enter the code again to retry.");
    } else {
      setMessage(getUserFacingErrorMessage(error));
    }
    setStep(enterCode);
    setCode("");
    void refresh();
  }

  async function check(event: FormEvent) {
    event.preventDefault();
    if (busy || method === null || method.method === null) return;
    setBusy(true);
    setMessage("");
    try {
      setStep({ kind: "confirm", checked: await checkRecoveryApprovalCode({ code, method }) });
      setCode("");
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (busy || step.kind !== "confirm" || phone === null) return;
    const { checked } = step;
    setBusy(true);
    setMessage("");
    try {
      await confirmRecoveryApproval(checked, phone);
      setStep({ kind: "approved", requestId: checked.requestId, client: checked.client });
      setRequests([]);
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  }

  async function decline(requestId: string) {
    setBusy(true);
    setMessage("");
    try {
      await declineRecoveryApproval(requestId);
      const undoingLogin = recent.some((item) => item.requestId === requestId);
      setRequests((current) => current.filter((request) => request.requestId !== requestId));
      setRecent((current) => current.filter((item) => item.requestId !== requestId));
      setMessage(
        undoingLogin
          ? "Undone. That browser is signed out, and any passkey, device key, PIN or password added since it got in was removed. To set a new PIN, log out and choose Trouble logging in."
          : step.kind === "approved" && step.requestId === requestId
            ? "Approval withdrawn. If that browser had already logged in, it is now signed out."
            : "Declined. That browser was not let in."
      );
      setStep(enterCode);
    } catch (error) {
      setMessage(getUserFacingErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!eligible && step.kind !== "approved") return null;
  // After an approval or a decline the prompt stays until dismissed, so its outcome is read.
  const outcomeShown = step.kind !== "enter_code" || message !== "";
  if (mode === "prompt" && (dismissed || (requests.length === 0 && !outcomeShown))) return null;

  const confirmLabel =
    method?.method === "device"
      ? "Approve with screen lock"
      : method?.method === "passkey"
        ? "Approve with passkey"
        : "Approval unavailable";
  return (
    <section
      className={`record-form trusted-device-approval trusted-device-approval-${mode}`}
      aria-label="Approve a browser"
    >
      <div className="section-heading">
        <h4>{mode === "prompt" ? "A browser wants to log in" : "Approve a browser"}</h4>
        <p>
          When you are locked out on another browser, it shows a 6-digit code. Enter it here and
          confirm with this device's fingerprint, face or screen lock to let that browser in.
        </p>
      </div>
      {step.kind === "approved" ? (
        <>
          <p role="status">Approved {step.client}. Go back to it to add a passkey and finish.</p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void decline(step.requestId)}
          >
            Undo, this wasn't me
          </button>
        </>
      ) : step.kind === "confirm" ? (
        <div className="trusted-device-confirm" role="group" aria-label="Confirm the browser">
          <p>
            Let in <strong>{step.checked.client}</strong>? It asked{" "}
            {minutesAgo(step.checked.requestedAt)}. Only approve if you are holding it right now.
          </p>
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void confirm()}>
            {busy ? "Confirming…" : confirmLabel}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void decline(step.checked.requestId)}
          >
            This wasn't me
          </button>
        </div>
      ) : (
        <>
          {requests.length > 0 ? (
            <ul className="trusted-device-requests">
              {requests.map((request) => (
                <li key={request.requestId}>
                  <span>
                    {request.client} · asked {minutesAgo(request.requestedAt)}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void decline(request.requestId)}
                  >
                    This wasn't me
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="shell-note">No browser is waiting for approval right now.</p>
          )}
          <p className="trusted-device-warning">
            Only enter a code shown on a screen you are holding right now. If someone sent you a
            code or asked you to enter one, choose This wasn't me.
          </p>
          <form className="auth-fields" onSubmit={(event) => void check(event)}>
            <label>
              Code from the other browser
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^\d ]/gu, ""))}
              />
            </label>
            <button
              type="submit"
              disabled={
                busy ||
                method === null ||
                method.method === null ||
                code.replace(/\s/gu, "").length !== 6
              }
              aria-busy={busy}
            >
              {busy ? "Checking…" : method?.method === null ? confirmLabel : "Continue"}
            </button>
          </form>
          {method?.method === null ? (
            <p className="shell-note">
              This device cannot confirm with a screen lock. Use the Grogoni Android app with device
              security turned on, or a browser that supports passkeys.
            </p>
          ) : null}
          {needsPasskey ? (
            <>
              <button
                type="button"
                disabled={enrollment.busy}
                onClick={() => void enrollment.enroll()}
              >
                {enrollment.busy ? "Creating passkey…" : "Create passkey on this device"}
              </button>
              {enrollment.stepUpForm}
              {enrollment.message ? <p role="alert">{enrollment.message}</p> : null}
            </>
          ) : null}
        </>
      )}
      {mode === "panel" && recent.length > 0 ? (
        <div className="trusted-device-recent" role="group" aria-label="Recently let in">
          <h4>Let in during the last 24 hours</h4>
          <ul className="trusted-device-requests">
            {recent.map((item) => (
              <li key={item.requestId}>
                <span>
                  {item.client} · logged in {minutesAgo(item.loggedInAt)}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void decline(item.requestId)}
                >
                  Undo, this wasn't me
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      {mode === "prompt" ? (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setDismissed(true);
            setStep(enterCode);
            setMessage("");
          }}
        >
          {requests.length > 0 && step.kind !== "approved" ? "Not now" : "Done"}
        </button>
      ) : null}
    </section>
  );
}

function minutesAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes >= 120) return `${Math.floor(minutes / 60)} hours ago`;
  return minutes === 0 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
}
