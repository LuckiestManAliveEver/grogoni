import { useGuestReplyPending } from "./guest-reply-pending";

/** "Grogoni is typing" in a guest's thread while their message is classified and searched. */
export function GuestTypingIndicator({ thread, name }: { thread: string | null; name: string }) {
  if (!useGuestReplyPending(thread)) return null;
  return (
    <article className="message grogoniclaw guest-typing" role="status" aria-live="polite">
      <span className="message-author">{name}</span>
      <p>
        <span className="typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="visually-hidden">{name} is typing</span>
      </p>
    </article>
  );
}
