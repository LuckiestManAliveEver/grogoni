import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { CountryCode } from "libphonenumber-js";
import type { Scope } from "@grogoni/offline-runtime";
import type {
  ChannelEndpointSummary,
  ChannelProvider,
  MessageHandoffStatus
} from "@grogoni/shared-types";

import type { SmsHandoffRequest } from "../messaging/SmsHandoffDialog";
import { buildSmsHandoffRequest } from "../messaging/sms-handoff";
import { externalShareNoticeFor, shareMessageExternally } from "../messaging/platform-handoff";
import { useBluetoothSendState } from "./bluetoothSendState";

interface ChatComposerStateInput {
  activeConversationId: string | null;
  channelEndpoints: ChannelEndpointSummary[];
  chatDraft: string;
  initialEmailSubject: string;
  nearbyScope: Scope | null;
  smsDefaultCountry: CountryCode;
  smsFallbackRecipient?: { recipient: string; label: string };
  onDraftChange: (draft: string) => void;
  onPlatformHandoff: (status: MessageHandoffStatus, normalizedErrorCode: string | null) => void;
  onSend: (draft: string, provider?: ChannelProvider, subject?: string, invoiceId?: string) => void;
}

export function useChatComposerState(input: ChatComposerStateInput) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sellerPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const draftSyncTimerRef = useRef<number | null>(null);
  const [smsHandoffRequest, setSmsHandoffRequest] = useState<SmsHandoffRequest | null>(null);
  const [externalShareNotice, setExternalShareNotice] = useState<string | null>(null);
  const [liveDraft, setLiveDraft] = useState(input.chatDraft);
  const [emailSubject, setEmailSubject] = useState(input.initialEmailSubject);
  const [emailInvoiceId, setEmailInvoiceId] = useState("");
  const [selectedProvider, setSelectedProviderState] = useState<ChannelProvider | null>(null);
  const bluetooth = useBluetoothSendState(input.nearbyScope);
  const resetBluetooth = bluetooth.reset;

  const setSelectedProvider = useCallback(
    (provider: ChannelProvider | null) => {
      bluetooth.reset();
      setSelectedProviderState(provider);
    },
    [bluetooth]
  );

  function selectBluetooth() {
    setSelectedProviderState(null);
    bluetooth.select();
  }

  function clearDraftSyncTimer() {
    if (draftSyncTimerRef.current === null) return;
    window.clearTimeout(draftSyncTimerRef.current);
    draftSyncTimerRef.current = null;
  }

  function updateLiveDraft(nextDraft: string) {
    setLiveDraft(nextDraft);
    clearDraftSyncTimer();
    draftSyncTimerRef.current = window.setTimeout(() => {
      draftSyncTimerRef.current = null;
      input.onDraftChange(nextDraft);
    }, 120);
  }

  function commitDraft(nextDraft: string) {
    clearDraftSyncTimer();
    setLiveDraft(nextDraft);
    input.onDraftChange(nextDraft);
  }

  function sendLiveDraft() {
    clearDraftSyncTimer();
    // A send within the 120 ms sync window would leave the parent's draft behind the composer.
    // Commit it first, so the send's own setChatDraft("") is a change that clears the composer,
    // and a send that keeps the draft ("Your draft is saved") keeps this text.
    if (input.chatDraft !== liveDraft) flushSync(() => input.onDraftChange(liveDraft));
    if (bluetooth.selected) {
      bluetooth.send(liveDraft, () => {
        setLiveDraft("");
        input.onDraftChange("");
      });
      return;
    }
    if (
      navigator.onLine === false &&
      input.smsFallbackRecipient !== undefined &&
      (selectedProvider === null ||
        selectedProvider === "grogoni" ||
        selectedProvider === "native_sms") &&
      liveDraft.trim().length > 0
    ) {
      // Review the carrier route before opening the phone's SMS app. Keep the
      // draft intact: opening a composer does not confirm that an SMS was sent.
      openSmsHandoff(input.smsFallbackRecipient.recipient, input.smsFallbackRecipient.label);
      return;
    }
    input.onSend(
      liveDraft,
      selectedProvider ?? "grogoni",
      selectedProvider === "email" ? emailSubject : undefined,
      selectedProvider === "email" && emailInvoiceId !== "" ? emailInvoiceId : undefined
    );
  }

  function openSmsHandoff(recipient: string, label: string) {
    setSmsHandoffRequest(
      buildSmsHandoffRequest(recipient, label, liveDraft, input.smsDefaultCountry)
    );
  }

  async function openPlatformHandoff(label: string) {
    const result = await shareMessageExternally({
      text: liveDraft,
      title: label.trim() ? `Message for ${label.trim()}` : "Message from Grogoni"
    });
    input.onPlatformHandoff(result.status, result.errorCode);
    setExternalShareNotice(externalShareNoticeFor(result.status));
  }

  useEffect(() => setLiveDraft(input.chatDraft), [input.chatDraft]);

  useEffect(() => {
    setEmailSubject(input.initialEmailSubject);
    setEmailInvoiceId("");
  }, [input.activeConversationId, input.initialEmailSubject]);

  // Endpoint refreshes must never change the selected route. Offline SMS is
  // reviewed separately when Send is pressed.
  useEffect(() => {
    resetBluetooth();
    setSelectedProviderState(null);
  }, [input.activeConversationId, resetBluetooth]);

  useEffect(() => () => clearDraftSyncTimer(), []);

  return {
    bluetoothAvailable: bluetooth.available,
    bluetoothBusy: bluetooth.busy,
    bluetoothError: bluetooth.error,
    bluetoothStatus: bluetooth.status,
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
    sendViaBluetooth: bluetooth.selected,
    setEmailInvoiceId,
    setEmailSubject,
    setSelectedProvider,
    setSmsHandoffRequest,
    smsHandoffRequest,
    updateLiveDraft
  };
}

export type ChatComposerState = ReturnType<typeof useChatComposerState>;
