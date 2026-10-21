import { useEffect, useRef, useState } from "react";
import type { CountryCode } from "libphonenumber-js";
import type { MessageHandoffStatus } from "@grogoni/shared-types";
import {
  isLongSmsBody,
  normalizeSmsRecipient,
  openSmsComposer,
  selectMessageComposerChannel
} from "./sms-handoff";

export interface SmsHandoffRequest {
  body: string;
  label: string;
  recipient: string;
}

interface SmsHandoffDialogProps extends SmsHandoffRequest {
  defaultCountry: CountryCode;
  hasAttachments: boolean;
  onClose: () => void;
  onRecord: (status: MessageHandoffStatus, normalizedErrorCode: string | null) => void;
}

function initialNormalizedRecipient(recipient: string, defaultCountry: CountryCode): string | null {
  try {
    return normalizeSmsRecipient(recipient, defaultCountry);
  } catch {
    return null;
  }
}

export function SmsHandoffDialog({
  body: initialBody,
  defaultCountry,
  hasAttachments,
  label,
  onClose,
  onRecord,
  recipient: initialRecipient
}: SmsHandoffDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [recipient, setRecipient] = useState(initialRecipient);
  const [body, setBody] = useState(initialBody);
  const [normalizedRecipient, setNormalizedRecipient] = useState<string | null>(() =>
    initialNormalizedRecipient(initialRecipient, defaultCountry)
  );
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    status: "composer_opened" | "no_sms_app" | "unsupported";
    nativeBridgeUsed: boolean;
  } | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  function cancelBeforeHandoff() {
    onRecord("cancelled_before_handoff", null);
    onClose();
  }

  function reviewRecipient() {
    try {
      const normalized = normalizeSmsRecipient(recipient, defaultCountry);
      setNormalizedRecipient(normalized);
      setError("");
    } catch (cause) {
      setNormalizedRecipient(null);
      const message = cause instanceof Error ? cause.message : "Enter a valid telephone number.";
      setError(message);
      onRecord("invalid_recipient", "invalid_recipient");
    }
  }

  async function continueToSmsApp() {
    if (
      selectMessageComposerChannel({ isGrogoniRecipient: false, smsRequested: true }) !==
      "sms_external_app"
    ) {
      return;
    }
    if (normalizedRecipient === null) {
      reviewRecipient();
      return;
    }
    if (body.trim().length === 0) {
      setError("Enter a message to continue.");
      return;
    }

    setIsOpening(true);
    const handoff = await openSmsComposer(normalizedRecipient, body);
    setIsOpening(false);
    setResult({
      status: handoff.status,
      nativeBridgeUsed: handoff.nativeBridgeUsed
    });
    onRecord(handoff.status, handoff.errorCode);
  }

  return (
    <div className="sms-handoff-backdrop" role="presentation">
      <section
        className="sms-handoff-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sms-handoff-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (result === null) {
              cancelBeforeHandoff();
            } else {
              onClose();
            }
          }
        }}
      >
        <div className="sms-handoff-heading">
          <div>
            <span className="eyebrow">External carrier message</span>
            <h2 id="sms-handoff-title">Send as SMS</h2>
          </div>
          <button
            type="button"
            aria-label="Close SMS handoff"
            onClick={() => {
              if (result === null) {
                cancelBeforeHandoff();
              } else {
                onClose();
              }
            }}
          >
            ×
          </button>
        </div>

        {result === null ? (
          <>
            <p>
              Grogoni will prepare this message in your phone&apos;s selected SMS app. Review it
              there and press Send yourself.
            </p>
            <label>
              Recipient name
              <input value={label} readOnly />
            </label>
            <label>
              Telephone number
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={recipient}
                onChange={(event) => {
                  setRecipient(event.target.value);
                  setNormalizedRecipient(null);
                  setError("");
                }}
                placeholder="+254 712 345 678"
              />
            </label>
            {normalizedRecipient === null ? (
              <button className="secondary" type="button" onClick={reviewRecipient}>
                Review SMS details
              </button>
            ) : (
              <div className="sms-handoff-review" aria-label="SMS handoff confirmation">
                <span>Sending to</span>
                <strong>
                  {label || "SMS recipient"} · {normalizedRecipient}
                </strong>
              </div>
            )}
            <label>
              Message preview
              <textarea
                rows={5}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  setError("");
                }}
              />
            </label>
            <div className="sms-handoff-warning">
              <strong>Your mobile carrier may charge for this SMS.</strong>
              <span>
                No internet is needed. Your SIM&apos;s SMS bundle or airtime is used. Sending
                continues in your phone&apos;s SMS app.
              </span>
            </div>
            {isLongSmsBody(body) ? (
              <div className="sms-handoff-warning" role="note">
                This is longer than 160 characters. Your SMS app or carrier may split it into
                multiple messages, and multiple charges may apply.
              </div>
            ) : null}
            {hasAttachments ? (
              <div className="sms-handoff-warning" role="note">
                SMS handoff is text-only. Your selected Grogoni attachments will stay in this draft
                and will not be shared.
              </div>
            ) : null}
            {error ? (
              <p className="sms-handoff-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="sms-handoff-actions">
              <button className="secondary" type="button" onClick={cancelBeforeHandoff}>
                Cancel
              </button>
              <button
                type="button"
                disabled={normalizedRecipient === null || body.trim().length === 0 || isOpening}
                aria-busy={isOpening}
                onClick={() => void continueToSmsApp()}
              >
                {isOpening ? "Opening…" : "Continue to SMS app"}
              </button>
            </div>
          </>
        ) : (
          <div className="sms-handoff-result" role="status">
            <strong>
              {result.status === "composer_opened"
                ? result.nativeBridgeUsed
                  ? "Opened your selected SMS app"
                  : "SMS app handoff requested"
                : result.status === "no_sms_app"
                  ? "No compatible SMS application was found"
                  : "Open Grogoni on a mobile phone to send an SMS"}
            </strong>
            <p>
              {result.status === "composer_opened"
                ? "Grogoni cannot tell whether you send, deliver, or read the message. Your draft remains in Grogoni."
                : result.status === "no_sms_app"
                  ? "Install or enable a compatible SMS application, then try again."
                  : "Desktop browsers do not provide a compatible carrier SMS handler."}
            </p>
            <button type="button" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
