import type { ChangeEvent } from "react";

import type { ProductCaptureJobSummary } from "@grogoni/shared-types";

import { postJson } from "../api-helpers";
import type { ChatAttachment, ChatMessage } from "../app-shell";
import {
  createChatAttachment,
  dataUrlPayload,
  getErrorMessage,
  readFileAsDataUrl
} from "../chat-message-plumbing";
import type { ActiveBusiness } from "../grogoni-application-shared";

interface UseChatAttachmentsStateDeps {
  business: ActiveBusiness | null;
  setStatusMessage: (message: string) => void;
  setPendingAttachments: (
    attachments: ChatAttachment[] | ((current: ChatAttachment[]) => ChatAttachment[])
  ) => void;
  setChatMessages: (messages: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
}

export function useChatAttachmentsState(deps: UseChatAttachmentsStateDeps) {
  const { business, setStatusMessage, setPendingAttachments, setChatMessages } = deps;

  async function handleChatAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);

    if (files.length === 0) {
      return;
    }

    const accepted = files.filter((file) => file.size <= 10_000_000);
    if (accepted.length !== files.length) {
      setStatusMessage("Each attachment must be 10 MB or smaller");
    }
    const nextAttachments = await Promise.all(accepted.map(createChatAttachment));
    setPendingAttachments((attachments) => [...attachments, ...nextAttachments].slice(0, 10));
    event.target.value = "";
  }

  function removePendingAttachment(attachmentId: string) {
    setPendingAttachments((attachments) =>
      attachments.filter((attachment) => attachment.id !== attachmentId)
    );
  }

  /**
   * Sell-flow photo capture: unlike handleChatAttachmentChange (which only ever records
   * attachment metadata - see chat_attachments), this sends the real image bytes to the
   * product-captures pipeline so the seller can review detected/manual items and post a status.
   * Kept as a separate composer action rather than overloading the generic attach button so the
   * metadata-only guarantee of the general chat attachment channel is untouched.
   */
  async function handleSellerPhotoCapture(file: File) {
    if (business === null) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setStatusMessage("Choose a JPEG, PNG, or WebP product photo.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatusMessage("Product photos must be 10 MB or smaller.");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const job = await postJson<ProductCaptureJobSummary>(
        `/businesses/${business.id}/product-captures`,
        {
          fileName: file.name,
          contentType: file.type,
          contentBase64: dataUrlPayload(dataUrl)
        }
      );
      setChatMessages((messages) => [
        ...messages,
        {
          id: `product-capture-${job.id}`,
          author: "merchant",
          body: "Reviewing a photo capture",
          productCaptureJobId: job.id,
          createdAt: new Date().toISOString()
        }
      ]);
    } catch (error) {
      setStatusMessage(getErrorMessage(error));
    }
  }

  return {
    handleChatAttachmentChange,
    removePendingAttachment,
    handleSellerPhotoCapture
  };
}
