import type {
  ConversationAttachmentKind,
  ConversationMessageContent,
  ConversationMessageDeliveryStatus
} from "@grogoni/shared-types";

export type ShellView =
  | "home"
  | "chat"
  | "agent"
  | "products"
  | "suppliers"
  | "customers"
  | "pos"
  | "invoices"
  | "network"
  | "sync"
  | "runtime"
  | "payments"
  | "imports"
  | "logistics"
  | "compliance"
  | "beta"
  | "launch"
  | "reports"
  | "notifications";

export type { GrogoniChatSurface, GrogoniMode } from "@grogoni/shared-types";
export type { GrogoniSessionContext as GrogoniSessionState } from "@grogoni/shared-types";

export interface QuickAction {
  id: ShellView;
  label: string;
  summary: string;
}

export interface EmptyState {
  id: Exclude<ShellView, "home" | "chat">;
  title: string;
  body: string;
}

export interface ChatMessage {
  id: string;
  author: "merchant" | "grogoniclaw" | "contact";
  authorLabel?: string;
  body: string;
  /**
   * The server-typed conversation content, carried through unflattened so the generated-surface
   * registry (generated-surface-registry.tsx) can dispatch on `content.type` instead of the
   * caller checking one more optional field per new card type. See docs/frontend/frontend.md.
   */
  content?: ConversationMessageContent;
  attachments?: ChatAttachment[];
  confirmationToken?: string;
  createdAt?: string;
  status?: ConversationMessageDeliveryStatus;
  editedAt?: string | null;
  deletedAt?: string | null;
  replyToMessageId?: string | null;
  forwardedFromMessageId?: string | null;
  reactions?: Array<{ emoji: string; actorId: string }>;
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  category: "document" | "image" | "video" | "audio" | "other";
  kind?: ConversationAttachmentKind;
  previewable?: boolean;
  caption?: string;
  dataUrl?: string;
  previewUrl?: string;
  downloadUrl?: string;
}

export const quickActions: QuickAction[] = [
  {
    id: "home",
    label: "Home",
    summary: "Return to business overview"
  },
  {
    id: "chat",
    label: "Chat",
    summary: "Plan work through the agent runtime"
  },
  {
    id: "products",
    label: "Products",
    summary: "Manage stock records"
  },
  {
    id: "suppliers",
    label: "Suppliers",
    summary: "Manage supplier contacts"
  },
  {
    id: "customers",
    label: "Customers",
    summary: "Manage customer records"
  },
  {
    id: "pos",
    label: "POS terminal",
    summary: "Ring up sales and collect payment"
  },
  {
    id: "invoices",
    label: "Invoices",
    summary: "Create invoice drafts and confirm sales"
  },
  {
    id: "network",
    label: "My Network",
    summary: "Build and route trusted commerce connections"
  },
  {
    id: "sync",
    label: "Sync",
    summary: "Review offline queue and conflicts"
  },
  {
    id: "runtime",
    label: "Runtime",
    summary: "Review agent sessions and turns"
  },
  {
    id: "payments",
    label: "Payments",
    summary: "Record payments and review debt"
  },
  {
    id: "imports",
    label: "Purchase receipts",
    summary: "Upload receipts and review structured records"
  },
  {
    id: "logistics",
    label: "Logistics",
    summary: "Track pickup and delivery fulfillment"
  },
  {
    id: "compliance",
    label: "Compliance",
    summary: "Manage export, verification, tax, and trust controls"
  },
  {
    id: "beta",
    label: "Beta",
    summary: "Review closed beta access, gates, support, and telemetry"
  },
  {
    id: "launch",
    label: "Launch",
    summary: "Review public launch gates, checklist, incidents, and rollback"
  },
  {
    id: "reports",
    label: "Reports",
    summary: "Review sales, stock, debt, imports, and sync health"
  },
  {
    id: "notifications",
    label: "Alerts",
    summary: "Review in-app business notifications"
  }
];

export const emptyStates: EmptyState[] = [
  {
    id: "products",
    title: "No products yet",
    body: "Create the first product record to start stock tracking."
  },
  {
    id: "suppliers",
    title: "No suppliers yet",
    body: "Create the first supplier contact or confirm supplier imports."
  },
  {
    id: "customers",
    title: "No customers yet",
    body: "Create the first customer record to replace paper customer notes."
  },
  {
    id: "pos",
    title: "No sale in progress",
    body: "Choose a product to start a point-of-sale transaction."
  },
  {
    id: "invoices",
    title: "No invoices yet",
    body: "Create the first invoice draft to preview totals and confirm stock movement."
  },
  {
    id: "network",
    title: "No network yet",
    body: "Sync contacts or connect social profiles to build a trusted commerce graph."
  },
  {
    id: "sync",
    title: "No queued work",
    body: "Sync keeps offline mutations queued until server replay confirms them."
  },
  {
    id: "runtime",
    title: "No runtime turns yet",
    body: "Agent runtime sessions appear after the owner sends chat tasks."
  },
  {
    id: "payments",
    title: "No payments yet",
    body: "Manual payment records track invoice payments and customer debt. Live M-Pesa integration is intentionally deferred."
  },
  {
    id: "imports",
    title: "No purchase receipts yet",
    body: "Upload a receipt or paste supplier records to create structured supplier data."
  },
  {
    id: "logistics",
    title: "No logistics yet",
    body: "Logistics tracks pickup and delivery fulfillment for confirmed invoices."
  },
  {
    id: "compliance",
    title: "Compliance not reviewed yet",
    body: "Compliance keeps export, verification, tax, and device trust workflows explicit and audited."
  },
  {
    id: "beta",
    title: "Beta readiness not reviewed yet",
    body: "Beta readiness keeps access, support, sync, payment, and telemetry gates explicit before selected merchant use."
  },
  {
    id: "launch",
    title: "Launch readiness not reviewed yet",
    body: "Launch readiness keeps public onboarding, production checklist, support, telemetry, and rollback gates explicit before launch."
  },
  {
    id: "reports",
    title: "No report data yet",
    body: "Reports summarize deterministic business records once products, invoices, payments, imports, or sync work exists."
  },
  {
    id: "notifications",
    title: "No notifications yet",
    body: "In-app alerts appear when deterministic business rules find low stock, debt, sync conflicts, or failed imports."
  }
];

export function getEmptyState(view: ShellView): EmptyState | undefined {
  return emptyStates.find((state) => state.id === view);
}

export function createInitialChatMessages(businessName: string): ChatMessage[] {
  return [
    {
      id: "welcome",
      author: "grogoniclaw",
      body: `Karibu. What do you need? Find products, shops, services, or deliveries — just ask. Tap the shop icon when you are ready to start running ${businessName}.`
    }
  ];
}
