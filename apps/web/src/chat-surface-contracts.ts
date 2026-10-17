import type { ChangeEvent, ReactNode } from "react";

import type {
  BuyFeedSummary,
  BuyResultSummary,
  ChannelEndpointSummary,
  ChannelProvider,
  ConversationInboxItem,
  MessageHandoffStatus,
  NetworkInviteSummary,
  ProductFieldDefinition,
  RecycleBinStatusSummary
} from "@grogoni/shared-types";

import type { ChatAttachment, ChatMessage, ShellView, GrogoniMode } from "./app-shell";
import type { NetworkConnectionAction } from "./hooks/useNetworkState";
import type { DevicePhonebookContact } from "./phonebook-directory";
import type { InviteOutcome } from "./phonebook-sync";
import type {
  BuyCartItem,
  ContactPickerContact,
  InvoiceSummary,
  NetworkGraphSummary,
  OAuthProviderSummary,
  ProductFieldDraft,
  ProductFormState,
  ProductSummary,
  PublicStorefrontSummary,
  ShopPresenceStatus,
  SocialSignupProvider
} from "./grogoni-application-shared";

export interface ChatSurfaceProps {
  activeConversationId: string | null;
  chatDraft: string;
  initialEmailSubject: string;
  channelEndpoints: ChannelEndpointSummary[];
  children: ReactNode;
  conversations: ConversationInboxItem[];
  invoices: InvoiceSummary[];
  messages: ChatMessage[];
  isInboxOpen: boolean;
  isContactTyping: boolean;
  isConfirming: boolean;
  isSending: boolean;
  isBrowserGenerating: boolean;
  securityLabel: string;
  replyToMessageId: string | null;
  marketplaceIntroComplete: boolean;
  marketplaceShortcutOpen: boolean;
  networkGraph: NetworkGraphSummary | null;
  networkDevicePhonebook: DevicePhonebookContact[];
  networkInvites: NetworkInviteSummary[];
  oauthProviders: OAuthProviderSummary[];
  oauthProvidersLoaded: boolean;
  pendingAttachments: ChatAttachment[];
  productForm: ProductFormState;
  productFields: ProductFieldDefinition[];
  productCount: number;
  products: ProductSummary[];
  publicStorefronts: PublicStorefrontSummary[];
  publicStorefrontsLoading: boolean;
  shopPresenceStatus: ShopPresenceStatus;
  workspaceOpen: boolean;
  buyFeed: BuyFeedSummary | null;
  isSearchingBuyFeed: boolean;
  buyCart: BuyCartItem[];
  isCheckingOut: boolean;
  onAttachmentChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSellerPhotoCapture: (file: File) => void;
  onStatusBroadcastPosted: (statusBroadcastId: string) => void;
  onSearchBuyFeed: (query: string) => void;
  onAddToCart: (result: BuyResultSummary) => void;
  onRemoveFromCart: (cartItemId: string) => void;
  onCheckout: () => void;
  onRefreshInvoices: () => void;
  onBackToChat: () => void;
  onCloseMarketplace: () => void;
  onCloseWorkspace: () => void;
  onDraftChange: (draft: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onCreateConversation: (recipient: string, title: string) => void;
  onCreateAgentSession: (title?: string) => void;
  onRequireSignIn: () => void;
  onBrowseAsGuest: () => void;
  onSignUp: () => void;
  onLogIn: () => void;
  recognizedDeviceLabel: string | null;
  onRefreshPublicStorefronts: () => void;
  onConversationPreference: (
    conversationId: string,
    preference: "archive" | "mute" | "pin"
  ) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  recycleBin: RecycleBinStatusSummary | null;
  onDeleteConversation: (conversationId: string) => void;
  onRestoreConversation: (conversationId: string) => void;
  onLoadRecycleBin: () => void;
  onEmptyRecycleBin: (conversationIds?: string[]) => void;
  onEnableNotifications: () => void;
  onInboxOpenChange: (open: boolean) => void;
  onReply: (messageId: string) => void;
  onCancelReply: () => void;
  onEditMessage: (messageId: string, text: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onReactMessage: (messageId: string, reaction: string | null) => void;
  onAgentFeedback: (messageId: string, correct: boolean) => void;
  onForwardMessage: (messageId: string, conversationId: string) => void;
  onRetryMessages: () => void;
  /** Messages waiting in the outbox; the retry control shows only when this is above zero. */
  queuedMessageCount: number;
  /**
   * "The shop": the Shop Hub for an owner, the marketplace sheet of shops for someone without
   * one, or a wait for the account's shops when that is not known yet.
   */
  onOpenShop: () => void;
  onNavigate: (view: ShellView) => void;
  onOpenWorkspace: () => void;
  onModeChange: (mode: GrogoniMode) => void;
  onOpenAgentProfile: () => void;
  onCompleteMarketplaceIntro: () => void;
  onProductEdit: (product: ProductSummary) => void;
  onProductFieldsSave: (fields: ProductFieldDraft[]) => void;
  onProductFormChange: (form: ProductFormState) => void;
  onProductRemove: (productId: string) => void;
  onProductReset: () => void;
  onProductSave: () => Promise<boolean>;
  onProductsDuplicated: () => void;
  onNetworkDisconnectSource: (sourceId: string) => void;
  onNetworkPhoneContactsSync: (
    selectedContacts: ContactPickerContact[]
  ) => Promise<NetworkGraphSummary | null>;
  onNetworkInviteContacts: (contacts: DevicePhonebookContact[]) => Promise<InviteOutcome>;
  onNetworkConnectionAction: (
    action: NetworkConnectionAction
  ) => Promise<{ ok: boolean; message: string }>;
  onNetworkProviderOAuth: (provider: SocialSignupProvider) => Promise<void>;
  onNetworkRefresh: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onStatusChange: (status: ShopPresenceStatus) => void;
  onConfirm: (confirmationToken: string) => void;
  onReject?: (confirmationToken: string) => void;
  onSend: (draft: string, provider?: ChannelProvider, subject?: string, invoiceId?: string) => void;
  onCancelGeneration: () => void;
  onSmsHandoff: (status: MessageHandoffStatus, normalizedErrorCode: string | null) => void;
  onPlatformHandoff: (status: MessageHandoffStatus, normalizedErrorCode: string | null) => void;
}
