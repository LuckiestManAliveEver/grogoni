import type { GrogoniMode } from "./app-shell";
import { StackedModule } from "./StackedModule";

interface ChatComposerActionsProps {
  draftHasText: boolean;
  mode: GrogoniMode;
  open: boolean;
  sendViaLabel: string;
  onAttachFiles: () => void;
  onAddParticipants?: () => void;
  onClose: () => void;
  onOpenCommand?: () => void;
  onSendSms: () => void;
  onSendVia: () => void;
  onShareApps: () => void;
  onTakePhoto: () => void;
}

export function ChatComposerActions({
  draftHasText,
  mode,
  open,
  sendViaLabel,
  onAttachFiles,
  onAddParticipants,
  onClose,
  onOpenCommand,
  onSendSms,
  onSendVia,
  onShareApps,
  onTakePhoto
}: ChatComposerActionsProps) {
  return (
    <StackedModule
      className="composer-actions-module"
      moduleId="composer-message-actions"
      open={open}
      title="More message actions"
      onClose={onClose}
    >
      <div className="composer-action-grid">
        {onAddParticipants ? (
          <button type="button" aria-label="Add agent or contact" onClick={onAddParticipants}>
            <span aria-hidden="true">＋</span>
            <span>Add agent or contact</span>
          </button>
        ) : null}
        <button type="button" aria-label="Send via" onClick={onSendVia}>
          <span className="phonebook-icon" aria-hidden="true" />
          <span>{sendViaLabel}</span>
        </button>
        {mode === "seller" ? (
          <button
            type="button"
            aria-label="Take photo"
            data-testid="seller-photo-button"
            onClick={onTakePhoto}
          >
            <span className="camera-icon" aria-hidden="true" />
            <span>Camera</span>
          </button>
        ) : null}
        <button type="button" aria-label="Photos" onClick={onAttachFiles}>
          <span className="composer-photos-icon" aria-hidden="true" />
          <span>Photos</span>
        </button>
        <button type="button" aria-label="Files" onClick={onAttachFiles}>
          <span className="composer-files-icon" aria-hidden="true" />
          <span>Files</span>
        </button>
        {mode === "seller" && onOpenCommand ? (
          <button type="button" aria-label="Open command" onClick={onOpenCommand}>
            <span className="composer-command-icon" aria-hidden="true">
              #
            </span>
            <span>Command</span>
          </button>
        ) : null}
        <button type="button" aria-label="Send as SMS" disabled={!draftHasText} onClick={onSendSms}>
          <span className="composer-sms-icon" aria-hidden="true">
            SMS
          </span>
          <span>Send as SMS</span>
        </button>
        <button
          type="button"
          aria-label="Share to apps"
          disabled={!draftHasText}
          onClick={onShareApps}
        >
          <span className="composer-share-icon" aria-hidden="true">
            ↗
          </span>
          <span>Share to apps</span>
        </button>
      </div>
    </StackedModule>
  );
}
