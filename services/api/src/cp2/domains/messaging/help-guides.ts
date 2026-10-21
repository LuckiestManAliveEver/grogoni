import { createHash } from "node:crypto";
import { runtimeHashtagCapabilities } from "@grogoni/tool-core";

export const helpGuides = [
  {
    key: "home",
    title: "Help",
    text: "Welcome to Help. Ask Grogoni how to use the app in your language. Open a sub-chat for Buying, Selling, Receipts and documents, Messaging, Tools, or Account and troubleshooting. Your questions and replies stay in that thread. Help explains actions; use your ordinary shop chat to carry them out and review confirmations."
  },
  {
    key: "buying",
    title: "Buying",
    text: "Buyer journey: open Buy, ask for a product or browse shops, review availability and prices, add items to the cart, choose checkout and delivery details, then review the order before submitting. Open your conversations for shop replies. Use your checkout ID to ask about delivery tracking. Availability and delivery status must come from the app; the Help agent cannot verify them."
  },
  {
    key: "selling",
    title: "Selling",
    text: "Seller journey: create or select your shop in Workspace, add products and stock, set prices, and add customers and suppliers. Use your shop chat to record purchases and sales, prepare invoices, record payments, and view reports. Type # to choose a capability. Provide the requested fields and review any confirmation before the action runs. Open the resulting record card to review the saved fields."
  },
  {
    key: "receipts",
    title: "Receipts and documents",
    text: "Receipt journey: in your shop chat, use More to attach a receipt image, scan, PDF or supported document. Ask Luna to extract its fields. Review supplier or wholesaler, sales agent, receipt number, date, products, quantities, units, prices, tax and totals. Correct uncertain fields before confirming the import. Confirmation binds the document to its supplier, contacts, products and purchase records. Extraction alone is not proof that records were saved. Use receipt.scan, receipt.correct, receipt.confirm and receipt.cancel in an ordinary shop chat."
  },
  {
    key: "messaging",
    title: "Messaging",
    text: "Messaging journey: Normal message talks to Grogoni. More → Send via selects an available connected channel for a linked customer. More → Share to apps opens WhatsApp, Telegram, Messenger, Instagram, TikTok or X and retains a draft; choose the recipient and send in that app. Opening an app does not prove delivery. Business messaging connections shows readiness, Gmail/Outlook authorization and customer verification links. Business credentials and provider authorization are required for direct delivery. Customers verify their own identities. TikTok direct delivery requires approved partner access. Provider acceptance is different from confirmed delivery."
  },
  {
    key: "tools",
    title: "Tools",
    text: "Tool journey: in an ordinary shop chat, type # to browse capabilities. Select a tool, supply its fields (JSON supports multiple fields), review the proposal, and confirm when prompted. Check the result card and saved record. Help only explains tools and examples; pasting a command here does not execute it. Available capabilities:\n"
  },
  {
    key: "troubleshooting",
    title: "Account and troubleshooting",
    text: "For help, describe the screen, what you tried, the exact error, and the outcome you expected. Do not share PINs, passwords, access tokens or verification codes. Check the connection and selected shop first. If a channel is unavailable, review Business messaging connections and customer verification. If a request timed out, inspect the saved record or provider history before retrying a sale, payment or external message. Open the model/runtime panel for runtime readiness. Help cannot inspect private records or fix account permissions on your behalf."
  }
] as const;

export function helpConversationId(accountId: string, topic: string): string {
  const hash = createHash("sha256").update(`grogoni-help-v1:${accountId}:${topic}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function helpGuideText(topic: string): string {
  const guide = helpGuides.find((item) => item.key === topic) ?? helpGuides[0];
  return (
    guide.text +
    (topic === "tools"
      ? "Hashtags: " +
        runtimeHashtagCapabilities.map((tool) => tool.hashtag).join(", ") +
        "\n\n" +
        runtimeHashtagCapabilities
          .map(
            (tool) =>
              `${tool.hashtag}: ${tool.description}${tool.requiresConfirmation ? " (confirmation required)" : ""}`
          )
          .join("\n")
      : "")
  );
}
