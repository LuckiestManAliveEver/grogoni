import type { ChatMessage } from "../../app-shell";
import {
  canOfferRegenerate,
  ownQuestionOf,
  type ReplyVersionControls
} from "./reply-version-requests";

/**
 * Previous / next control for an agent reply that has more than one version
 * (docs/architecture/conversation-reply-versions.md). Renders nothing for a single version.
 *
 * The "n of m" sibling-version pattern follows the DeepSeek Chat Demo's BranchSwitcher (MIT, see
 * THIRD_PARTY_NOTICES.md); the component is written for Grogoni: native buttons, a text label a
 * screen reader announces when the version changes, no icon or tooltip dependency.
 */
export function ReplyVersionSwitcher({
  selected,
  count,
  busy,
  onSelect
}: {
  /** Zero-based index of the version shown. */
  selected: number;
  count: number;
  /** A regenerate or a switch is in flight for this reply. */
  busy: boolean;
  onSelect: (index: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <div className="reply-version-switcher" role="group" aria-label="Reply versions">
      <button
        type="button"
        aria-label="Previous version"
        disabled={busy || selected <= 0}
        onClick={() => onSelect(selected - 1)}
      >
        <span aria-hidden="true">‹</span>
      </button>
      <span aria-live="polite">
        Version {selected + 1} of {count}
      </span>
      <button
        type="button"
        aria-label="Next version"
        onClick={() => onSelect(selected + 1)}
        disabled={busy || selected >= count - 1}
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

/**
 * Under an agent reply: the version switcher when it has more than one version, and a status line
 * with Stop while a new version is being written for it. Renders nothing otherwise.
 */
export function ReplyVersionRow({
  message,
  thread,
  controls
}: {
  message: ChatMessage;
  /** The open thread: only the person who asked can switch versions; others see the position. */
  thread: ChatMessage[];
  controls: ReplyVersionControls;
}) {
  const writing = controls.regeneratingMessageId === message.id;
  if (message.replyVersions === undefined && !writing) return null;
  // The selected version records which revision of the question it answered; say so when the
  // question has been edited since, so an answer is never read as a reply to words it never saw.
  const answered = message.replyVersions?.questionRevision;
  const asked = thread.find((item) => item.id === message.replyToMessageId);
  const earlierWording =
    answered !== undefined &&
    asked !== undefined &&
    !asked.deletedAt &&
    (asked.editedAt ?? null) !== answered;
  return (
    <div className="reply-version-row">
      {message.replyVersions !== undefined ? (
        <ReplyVersionSwitcher
          selected={message.replyVersions.selected}
          count={message.replyVersions.count}
          busy={
            controls.regeneratingMessageId !== null ||
            !controls.available ||
            ownQuestionOf(message, thread) === null
          }
          onSelect={(index) => controls.onSelect(message.id, index)}
        />
      ) : null}
      {earlierWording ? (
        <span className="reply-version-note">Answered before the message was last edited.</span>
      ) : null}
      {writing ? (
        <span className="reply-version-progress" role="status">
          Writing another version…
          <button type="button" onClick={controls.onCancel}>
            Stop
          </button>
        </span>
      ) : null}
    </div>
  );
}

/**
 * The "Regenerate" entry of a message's More menu. Renders nothing unless the reply is eligible
 * and the viewer is the person who asked (canOfferRegenerate).
 */
export function RegenerateMenuItem({
  controls,
  message,
  thread,
  onChosen
}: {
  controls: ReplyVersionControls;
  message: ChatMessage;
  thread: ChatMessage[];
  /** Closes the menu, like every other entry. */
  onChosen: () => void;
}) {
  if (!canOfferRegenerate(message, thread, controls)) return null;
  const messageId = message.id;
  return (
    <button
      type="button"
      aria-label="Regenerate this reply"
      disabled={controls.regeneratingMessageId !== null}
      onClick={() => {
        onChosen();
        controls.onRegenerate(messageId);
      }}
    >
      Regenerate
    </button>
  );
}
