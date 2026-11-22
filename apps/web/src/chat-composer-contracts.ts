import type { ChangeEvent } from "react";
import type { ChannelEndpointSummary } from "@grogoni/shared-types";
import type { ChatAttachment, GrogoniMode } from "./app-shell";
import type { ActiveBusiness, AgentSettings, InvoiceSummary } from "./grogoni-application-shared";
import type { ChatComposerState } from "./hooks/useChatComposerState";
export interface ChatComposerProps {
  agent: AgentSettings | null;
  business: ActiveBusiness | null;
  channelEndpoints: ChannelEndpointSummary[];
  composer: ChatComposerState;
  invoices: InvoiceSummary[];
  isAuthenticated: boolean;
  isBrowserGenerating: boolean;
  isSending: boolean;
  /** True while the composer is opening a conversation before the first send. */
  isOpening?: boolean;
  /** The conversation the thread shows; a send held while opening goes only to the one it named. */
  activeConversationId?: string | null;
  mode: GrogoniMode;
  activeAgentName: string;
  audienceLabel?: string | undefined;
  agentControlsAvailable?: boolean;
  pendingAttachments: ChatAttachment[];
  replyToMessageId: string | null;
  selectedConversationTitle: string;
  selectedEmailCustomerId: string | null | undefined;
  onAgentChange: (agent: AgentSettings) => void;
  onAttachmentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Adds files as pending attachments; without it the composer offers no voice notes. */
  onAddAttachmentFiles?: ((files: File[]) => void) | undefined;
  onCancelGeneration: () => void;
  onCancelReply: () => void;
  onOpenAgentProfile: () => void;
  onAddParticipants?: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onRequireSignIn: () => void;
  onSellerPhotoCapture: (file: File) => void;
}
