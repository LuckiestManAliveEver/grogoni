import { useEffect, useRef, useState } from "react";
import type { AuthSessionView, RecoveryApprovalStartResponse } from "@grogoni/shared-types";
import { ApiRequestError } from "./lib/api";
import {
  formatApprovalCode,
  recoveryApprovalStatus,
  startRecoveryApproval
} from "./recovery-approval";
import { getUserFacingErrorMessage } from "./user-facing-error";
import "./trusted-device-approval.css";

type WaitState =
  | { kind: "starting" }
  | { kind: "waiting"; request: RecoveryApprovalStartResponse }
  | { kind: "declined" | "expired" | "failed"; message: string };

/**
 * The signed-out browser's half of trusted-device recovery: shows the code, then waits for the
 * owner to approve it on a device that is still signed in. Polling stops on any final answer.
 */
export function TrustedDeviceRecoveryWait({
  identifier,
  onApproved
}: {
  identifier: string;
  onApproved: (session: AuthSessionView) => void;
}) {
  const [state, setState] = useState<WaitState>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const approved = useRef(onApproved);
  approved.current = onApproved;
  // One request per attempt. A remount (React StrictMode, a re-render of the parent) reuses it,
  // so the owner never sees a second request whose code nobody was shown.
  const started = useRef<{ key: string; request: Promise<RecoveryApprovalStartResponse> } | null>(
    null
  );

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: "starting" });

    async function poll(request: RecoveryApprovalStartResponse) {
      try {
        const result = await recoveryApprovalStatus(request);
        if (!active) return;
        if (result.status === "approved") {
          const { status: _status, ...session } = result;
          void _status;
          approved.current(session);
          return;
        }
        if (result.status === "declined") {
          setState({
            kind: "declined",
            message: "The request was declined on your other device."
          });
          return;
        }
        if (result.status === "expired") {
          setState({ kind: "expired", message: "This code expired. Start again for a new one." });
          return;
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 404) {
          setState({ kind: "expired", message: "This code expired. Start again for a new one." });
          return;
        }
        // A dropped connection is not an answer: keep waiting while the code is valid.
      }
      if (Date.parse(request.expiresAt) <= Date.now()) {
        setState({ kind: "expired", message: "This code expired. Start again for a new one." });
        return;
      }
      timer = setTimeout(() => void poll(request), request.pollIntervalMs);
    }

    const key = `${identifier}:${attempt}`;
    if (started.current?.key !== key)
      started.current = { key, request: startRecoveryApproval(identifier) };
    void started.current.request
      .then((request) => {
        if (!active) return;
        setState({ kind: "waiting", request });
        timer = setTimeout(() => void poll(request), request.pollIntervalMs);
      })
      .catch((error: unknown) => {
        if (active) setState({ kind: "failed", message: getUserFacingErrorMessage(error) });
      });
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [identifier, attempt]);

  useEffect(() => {
    if (state.kind !== "waiting") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [state.kind]);

  if (state.kind === "starting")
    return (
      <p className="auth-feedback" role="status">
        Creating your code…
      </p>
    );

  if (state.kind !== "waiting")
    return (
      <div className="auth-fields trusted-device-wait">
        <p role="alert">{state.message}</p>
        <button
          className="auth-primary-button"
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Get a new code
        </button>
      </div>
    );

  const remaining = Math.max(0, Date.parse(state.request.expiresAt) - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0");
  return (
    <div className="auth-fields trusted-device-wait" aria-live="polite">
      <ol className="trusted-device-steps">
        <li>
          Open Grogoni on a phone or computer that is still logged in to this account. A request
          appears there. If it does not, open Settings, then Login &amp; security, then{" "}
          <strong>Approve a browser</strong>.
        </li>
        <li>Enter this code there:</li>
      </ol>
      <p
        className="trusted-device-code"
        aria-label={`Code ${state.request.code.split("").join(" ")}`}
      >
        {formatApprovalCode(state.request.code)}
      </p>
      <ol className="trusted-device-steps" start={3}>
        <li>Confirm with that device's fingerprint, face or screen lock.</li>
      </ol>
      <p className="auth-feedback" role="status">
        Waiting for approval. Code expires in {minutes}:{seconds}.
      </p>
    </div>
  );
}
