import type { RuntimeToolName } from "./index.js";

/** Human actions stay available; these grants limit the assistant and its selected model. */
export const assistantActions = [
  {
    id: "read",
    label: "Read",
    description: "Browse, search and inspect information you can access."
  },
  {
    id: "edit",
    label: "Edit",
    description: "Update existing products, contacts, records and drafts."
  },
  {
    id: "create",
    label: "Create",
    description: "Create products, contacts, invoices, receipts and records."
  },
  {
    id: "delete",
    label: "Delete",
    description: "Delete records, remove identities and cancel receipts."
  },
  {
    id: "send",
    label: "Send and publish",
    description: "Send messages, share files and submit supplier requests."
  },
  {
    id: "buy",
    label: "Buy and order",
    description: "Place marketplace orders or record purchases."
  },
  {
    id: "pay",
    label: "Record payments",
    description: "Record payments and financial transactions."
  },
  {
    id: "execute",
    label: "Run actions",
    description: "Operate a computer, upload files, run imports and confirm changes."
  },
  {
    id: "store",
    label: "Set up a store",
    description:
      "Create a store and change store ownership or access. Requires a signed-in account."
  }
] as const;
export type AssistantAction = (typeof assistantActions)[number]["id"];
export type AssistantPermissions = Record<AssistantAction, boolean>;
export interface AssistantPermissionsView {
  conversationId: string;
  permissions: AssistantPermissions;
  functions: Array<{ id: string; action: AssistantAction; label: string; storeRelated: boolean }>;
}
/** Every action starts allowed; the account owner turns off what they do not want. */
export function defaultAssistantPermissions(): AssistantPermissions {
  return {
    read: true,
    edit: true,
    create: true,
    delete: true,
    send: true,
    buy: true,
    pay: true,
    execute: true,
    store: true
  };
}
/** Saves before this version wrote every old default, so their "off" was not the user's choice. */
export const assistantPermissionsVersion = 2;

export function normalizeAssistantPermissions(value: unknown): AssistantPermissions {
  const defaults = defaultAssistantPermissions();
  if (!value || typeof value !== "object") return defaults;
  const source = value as Record<string, unknown>;
  const chosen = source.version === assistantPermissionsVersion;
  for (const { id } of assistantActions)
    if (typeof source[id] === "boolean" && (chosen || id === "read" || id === "edit"))
      defaults[id] = source[id] as boolean;
  return defaults;
}

const groups: Record<Exclude<AssistantAction, "store">, readonly RuntimeToolName[]> = {
  read: [
    "catalogue.marketplace.search",
    "catalogue.marketplace.products",
    "products.list",
    "invoices.list",
    "reports.summary",
    "notifications.list",
    "compliance.review",
    "network.contacts.resolve",
    "network.identity.list",
    "commerce.website.open",
    "commerce.sources.list",
    "commerce.discovery.search",
    "commerce.search",
    "contacts.search",
    "purchase.history",
    "sales.history",
    "route.history",
    "payments.debtors",
    "receipt.lookup",
    "receipt.list",
    "computer.observe",
    "computer.scroll",
    "unknown.clarify"
  ],
  edit: [
    "product.update",
    "product.stock_adjust",
    "product.field.add",
    "product.field.remove",
    "customer.update",
    "supplier.update",
    "supplier.contact.attach",
    "purchase.price.change",
    "logistics.update_status",
    "receipt.review",
    "receipt.correct"
  ],
  create: [
    "product.create",
    "customer.create",
    "supplier.create",
    "network.identity.propose",
    "network.identity.add",
    "procurement.quote.record",
    "procurement.prepare",
    "sale.record",
    "route.record",
    "invoice.draft"
  ],
  delete: [
    "product.delete",
    "network.identity.reject",
    "network.identity.unlink",
    "receipt.cancel"
  ],
  send: [
    "network.route",
    "procurement.submit",
    "procurement.respond",
    "messaging.send",
    "workspace.deliver"
  ],
  buy: ["commerce.checkout", "purchase.record"],
  pay: ["payment.record"],
  execute: [
    "catalogue.marketplace.import",
    "network.identity.confirm",
    "commerce.sources.execute",
    "receipt.scan",
    "receipt.confirm",
    "document_import.confirm",
    "computer.session.create",
    "computer.session.resume",
    "computer.navigate",
    "computer.click",
    "computer.type",
    "computer.upload",
    "computer.control.take",
    "computer.control.release",
    "computer.checkpoint",
    "computer.suspend",
    "computer.close"
  ]
};
export function assistantToolAction(tool: string): AssistantAction | null {
  for (const [action, names] of Object.entries(groups))
    if ((names as readonly string[]).includes(tool)) return action as AssistantAction;
  return null; // New tools are denied until explicitly classified.
}
export function assistantToolIsStoreRelated(tool: string): boolean {
  return /^(?:products?\.|invoices?\.|reports\.|compliance\.|customers?\.|suppliers?\.|purchases?\.|procurement\.|sales?\.|route\.|payments?\.|logistics\.|receipt\.|document_import\.|catalogue\.marketplace\.import)/u.test(
    tool
  );
}
export function assistantToolAllowed(permissions: AssistantPermissions, tool: string): boolean {
  const action = assistantToolAction(tool);
  return (
    action !== null &&
    permissions[action] &&
    (!assistantToolIsStoreRelated(tool) || permissions.store)
  );
}
