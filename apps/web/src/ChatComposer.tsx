import { useEffect, useRef, useState } from "react";
import { runtimeHashtagCapabilities, runtimeHashtagQuery } from "@grogoni/tool-core";

import { chatAttachmentAccept } from "./grogoni-application-shared";
import { chatModuleCommands } from "./chat-module-commands";
import { startVoiceInput } from "./chat-message-plumbing";
import { formatChannelProvider } from "./formatters";
import type { ChatComposerProps } from "./chat-composer-contracts";
import {
  ChatComposerLazyPanel,
  ChatHashtagCapabilityPicker,
  ComposerAttachmentWorkbench,
  ExternalMessagingAppPicker
} from "./chat-composer-lazy-panels";

import { DeferredChatChannelPicker as ChatChannelPicker } from "./chat-composer-lazy-panels";
import { DeferredChatComposerActions as ChatComposerActions } from "./chat-composer-lazy-panels";

export function ChatComposer({
  business,
  channelEndpoints,
  composer,
  invoices,
  isAuthenticated,
  isBrowserGenerating,
  isSending,
  isOpening = false,
  mode,
  activeAgentName,
  audienceLabel,
  agentControlsAvailable = true,
  pendingAttachments,
  replyToMessageId,
  selectedConversationTitle,
  selectedEmailCustomerId,
  onAttachmentChange,
  onCancelGeneration,
  onCancelReply,
  onAddParticipants,
  onRemoveAttachment,
  onRequireSignIn,
  onSellerPhotoCapture
}: ChatComposerProps) {
  const {
    bluetoothAvailable,
    bluetoothBusy,
    bluetoothError,
    bluetoothStatus,
    commitDraft,
    emailInvoiceId,
    emailSubject,
    externalShareNotice,
    fileInputRef,
    liveDraft,
    openPlatformHandoff,
    openSmsHandoff,
    selectBluetooth,
    selectedProvider,
    sellerPhotoInputRef,
    sendLiveDraft,
    sendViaBluetooth,
    setEmailInvoiceId,
    setEmailSubject,
    setSelectedProvider,
    updateLiveDraft
  } = composer;
  const [messageActionsOpen, setMessageActionsOpen] = useState(false);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [externalAppsOpen, setExternalAppsOpen] = useState(false);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const hashtagQuery = agentControlsAvailable ? runtimeHashtagQuery(liveDraft) : null;
  const sellerHashtagCapabilities = [...chatModuleCommands, ...runtimeHashtagCapabilities];
  const matchingHashtagCapabilities =
    hashtagQuery === null
      ? []
      : sellerHashtagCapabilities.filter(
          (capability) =>
            capability.toolName.includes(hashtagQuery) || capability.module.includes(hashtagQuery)
        );
  const sendViaLabel = sendViaBluetooth
    ? "Send via · Bluetooth"
    : selectedProvider === null
      ? "Send via"
      : `Send via · ${formatChannelProvider(selectedProvider)}`;

  function openMessageActions() {
    messageInputRef.current?.blur();
    setMessageActionsOpen(true);
  }

  // Grows the composer to fit typed content (CSS caps it at max-height and scrolls beyond that)
  // instead of the fixed single-line box clipping a second wrapped line out of view - see
  // .composer-input textarea in styles.css. Resetting to "auto" first is required so scrollHeight
  // reports the height a shorter draft actually needs, not the tallest height ever reached.
  useEffect(() => {
    const element = messageInputRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [liveDraft]);

  function runMessageAction(action: () => void) {
    setMessageActionsOpen(false);
    window.setTimeout(action, 0);
  }

  void isAuthenticated;
  void onRequireSignIn;

  return (
    <>
      <div className="composer">
        {replyToMessageId ? (
          <div className="composer-reply">
            <span>Replying to a message</span>
            <button type="button" onClick={onCancelReply}>
              Cancel
            </button>
          </div>
        ) : null}
        {hashtagQuery !== null ? (
          <ChatComposerLazyPanel label="Shop capabilities" moduleKey="composer-capabilities">
            <ChatHashtagCapabilityPicker
              capabilities={matchingHashtagCapabilities}
              query={hashtagQuery}
              onSelect={updateLiveDraft}
            />
          </ChatComposerLazyPanel>
        ) : null}
        <small className="composer-agent-indicator">
          {audienceLabel ?? `${activeAgentName} will answer`}
        </small>
        <input
          ref={fileInputRef}
          className="chat-file-input"
          type="file"
          multiple
          accept={chatAttachmentAccept}
          onChange={onAttachmentChange}
        />
        {mode === "seller" ? (
          <input
            ref={sellerPhotoInputRef}
            className="chat-file-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            data-testid="seller-photo-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) onSellerPhotoCapture(file);
              event.target.value = "";
            }}
          />
        ) : null}
        {pendingAttachments.length > 0 ? (
          <ChatComposerLazyPanel label="Selected attachments" moduleKey="composer-attachments">
            <ComposerAttachmentWorkbench
              pendingAttachments={pendingAttachments}
              onRemoveAttachment={onRemoveAttachment}
              onCommitDraft={commitDraft}
            />
          </ChatComposerLazyPanel>
        ) : null}
        {selectedProvider === "email" ? (
          <>
            <label className="composer-input">
              <span>Subject</span>
              <input
                aria-label="Email subject"
                required
                maxLength={200}
                value={emailSubject}
                onChange={(event) => setEmailSubject(event.target.value)}
                placeholder="Required for email"
              />
            </label>
            <label className="composer-input">
              <span>Trusted attachment</span>
              <select
                aria-label="Attach a confirmed invoice"
                value={emailInvoiceId}
                onChange={(event) => setEmailInvoiceId(event.target.value)}
              >
                <option value="">No attachment</option>
                {invoices
                  .filter(
                    (invoice) =>
                      invoice.status === "confirmed" &&
                      invoice.customerId === selectedEmailCustomerId
                  )
                  .map((invoice) => (
                    <option value={invoice.id} key={invoice.id}>
                      Invoice {invoice.invoiceNumber} · {invoice.customerName ?? "Customer"}
                    </option>
                  ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="composer-input">
          <span>Message</span>
          <textarea
            ref={messageInputRef}
            aria-label="Message"
            rows={1}
            value={liveDraft}
            onChange={(event) => updateLiveDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                // Enter never adds a newline here, even while a send runs or the chat opens.
                event.preventDefault();
                if (!isSending && !isOpening) sendLiveDraft();
              }
            }}
            placeholder={
              isOpening
                ? "Opening this chat…"
                : !agentControlsAvailable
                  ? "Write a message"
                  : mode === "seller"
                    ? "Ask your agent, or type # to call a capability"
                    : "Ask Grogoni..."
            }
          />
        </label>
        <div className="composer-bottom-row">
          <button
            className="icon-button composer-icon-button composer-more-button"
            type="button"
            aria-label="Open message actions"
            aria-haspopup="dialog"
            aria-expanded={messageActionsOpen}
            onClick={openMessageActions}
          >
            <span className="attach-icon" aria-hidden="true" />
            <span className="visually-hidden">More</span>
          </button>
          <div className="composer-bottom-row-trailing">
            {isBrowserGenerating ? (
              <button
                className="secondary"
                type="button"
                onClick={onCancelGeneration}
                aria-label="Cancel on-device generation"
              >
                Cancel
              </button>
            ) : null}
            {liveDraft.trim().length === 0 ? (
              <button
                className="icon-button composer-icon-button composer-mic-button"
                type="button"
                aria-label="Record voice"
                onClick={() => startVoiceInput(commitDraft)}
              >
                <span className="mic-icon" aria-hidden="true" />
                <span className="visually-hidden">Voice</span>
              </button>
            ) : null}
            <button
              className="send-button"
              type="button"
              onClick={sendLiveDraft}
              disabled={
                isSending ||
                isOpening ||
                (sendViaBluetooth && bluetoothBusy) ||
                (selectedProvider === "email" && emailSubject.trim().length === 0) ||
                (liveDraft.trim().length === 0 && pendingAttachments.length === 0)
              }
              aria-busy={isSending || (sendViaBluetooth && bluetoothBusy)}
            >
              <span className="send-icon" aria-hidden="true" />
              <span className="visually-hidden">Send</span>
            </button>
          </div>
        </div>
        {externalShareNotice !== null ? (
          <small className="external-share-notice" role="status">
            {externalShareNotice}
            {pendingAttachments.length > 0
              ? " Attachments remain in Grogoni and were not shared."
              : " External messages are not covered by Grogoni end-to-end encryption."}
          </small>
        ) : null}
        {sendViaBluetooth && bluetoothError !== null ? (
          <small className="external-share-notice" role="status">
            {bluetoothError}
          </small>
        ) : null}
        <ChatComposerActions
          {...(onAddParticipants
            ? { onAddParticipants: () => runMessageAction(onAddParticipants) }
            : {})}
          draftHasText={liveDraft.trim().length > 0}
          mode={mode}
          open={messageActionsOpen}
          sendViaLabel={sendViaLabel}
          onClose={() => setMessageActionsOpen(false)}
          onAttachFiles={() => runMessageAction(() => fileInputRef.current?.click())}
          {...(agentControlsAvailable
            ? { onOpenCommand: () => runMessageAction(() => updateLiveDraft("#")) }
            : {})}
          onSendSms={() =>
            runMessageAction(() =>
              openSmsHandoff(
                selectedConversationTitle,
                selectedConversationTitle || "SMS recipient"
              )
            )
          }
          onSendVia={() => runMessageAction(() => setChannelPickerOpen(true))}
          onShareApps={() => runMessageAction(() => setExternalAppsOpen(true))}
          onTakePhoto={() => runMessageAction(() => sellerPhotoInputRef.current?.click())}
        />
        {externalAppsOpen ? (
          <ChatComposerLazyPanel label="Share to apps" moduleKey="external-messaging-apps">
            <ExternalMessagingAppPicker
              open={externalAppsOpen}
              {...(business ? { businessId: business.id } : {})}
              text={liveDraft}
              onClose={() => setExternalAppsOpen(false)}
              onSystemShare={() => {
                setExternalAppsOpen(false);
                void openPlatformHandoff(selectedConversationTitle);
              }}
            />
          </ChatComposerLazyPanel>
        ) : null}
        <ChatChannelPicker
          bluetoothAvailable={bluetoothAvailable}
          bluetoothBusy={bluetoothBusy}
          bluetoothError={bluetoothError}
          bluetoothSelected={sendViaBluetooth}
          bluetoothStatus={bluetoothStatus}
          channelEndpoints={channelEndpoints}
          open={channelPickerOpen}
          selectedProvider={selectedProvider}
          onClose={() => setChannelPickerOpen(false)}
          onSelect={setSelectedProvider}
          onSelectBluetooth={selectBluetooth}
        />
      </div>
    </>
  );
}
