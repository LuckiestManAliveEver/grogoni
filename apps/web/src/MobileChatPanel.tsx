import type { ReactNode } from "react";
export function MobileChatPanel({
  children,
  className,
  title,
  onClose
}: {
  children: ReactNode;
  className: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <section className={`mobile-chat-panel ${className}`} aria-label={title}>
      <div className="stacked-module-heading">
        <h2>{title}</h2>
        <button type="button" onClick={onClose} aria-label={`Close ${title}`}>
          ×
        </button>
      </div>
      <div className="stacked-module-content">{children}</div>
    </section>
  );
}
