import type { ChatSurfaceProps } from "./chat-surface-contracts";
import type { GrogoniMode } from "./app-shell";
import { StackedModule } from "./StackedModule";
import { formatFileSize, formatMessageTime } from "./formatters";
export function ChatRecycleBinPanel({
  mode,
  isRecycleBinOpen,
  setIsRecycleBinOpen,
  recycleBin,
  onRestoreConversation,
  onEmptyRecycleBin
}: Pick<ChatSurfaceProps, "recycleBin" | "onRestoreConversation" | "onEmptyRecycleBin"> & {
  mode: GrogoniMode;
  isRecycleBinOpen: boolean;
  setIsRecycleBinOpen: (open: boolean) => void;
}) {
  return (
    <StackedModule
      moduleId="recycle-bin"
      className={mode === "seller" ? "sell-module" : "buy-module"}
      open={isRecycleBinOpen}
      title="Recycle bin"
      onClose={() => setIsRecycleBinOpen(false)}
    >
      <p>
        Deleted chats stay here for 14 days before they're permanently removed. Restoring or
        emptying the bin requires admin privileges.
      </p>
      {recycleBin !== null ? (
        <>
          <p>
            {formatFileSize(recycleBin.usedBytes)} of {formatFileSize(recycleBin.capacityBytes)}{" "}
            used
            {recycleBin.isFull ? " — full. Ask an admin to empty it." : ""}
          </p>
          {recycleBin.items.length === 0 ? (
            <p>The recycle bin is empty.</p>
          ) : (
            <>
              <div className="conversation-list">
                {recycleBin.items.map((item) => (
                  <article className="conversation-item" key={item.conversation.id}>
                    <span className="conversation-copy">
                      <span className="conversation-title-line">
                        <strong>{item.title ?? "Grogoni agent"}</strong>
                      </span>
                      <small>
                        Deleted {formatMessageTime(item.deletedAt)} · Permanently deleted{" "}
                        {formatMessageTime(item.purgeAt)} · {formatFileSize(item.sizeBytes)}
                      </small>
                    </span>
                    <div className="conversation-actions" aria-label="Recycle bin item actions">
                      <button
                        type="button"
                        onClick={() => onRestoreConversation(item.conversation.id)}
                      >
                        Restore
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <button className="danger" type="button" onClick={() => onEmptyRecycleBin()}>
                Empty recycle bin
              </button>
            </>
          )}
        </>
      ) : (
        <p>Loading…</p>
      )}
    </StackedModule>
  );
}
