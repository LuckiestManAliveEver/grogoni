import type { ChannelDelegationOutcome } from "../../cp2/domains/agent-runtime/channel-delegation-result.js";

// What the WhatsApp participant is told once the shop owner resolves a delegated write. These are
// fixed strings on purpose: no tool input, tool result, record id, owner name or model output is
// ever interpolated, so an approval can never leak owner-only context back into the chat.
const completedSummaries: Record<string, string> = {
  "products.list": "catalogue search completed",
  "product.create": "the new catalogue item was added",
  "product.update": "the catalogue item was updated",
  "product.stock_adjust": "the stock level was adjusted",
  "invoice.draft": "the quotation or invoice was prepared",
  "invoices.list": "invoice lookup completed",
  "logistics.update_status": "the delivery status was updated",
  "procurement.quote.record": "the supplier quotation was recorded",
  "procurement.prepare": "the procurement request was prepared",
  "procurement.submit": "the procurement request was submitted",
  "procurement.respond": "the procurement response was sent",
  "sale.record": "the sale was recorded",
  "sales.history": "sales lookup completed",
  "purchase.record": "the purchase was recorded",
  "purchase.history": "purchase lookup completed"
};

export const linkedDelegationResultMaxLength = 160;

export function linkedDelegationResultText(
  outcome: ChannelDelegationOutcome,
  toolName: string
): string {
  if (outcome === "rejected") return "The shop owner declined this request.";
  if (outcome === "failed")
    return "The shop owner approved this request, but it could not be completed.";
  const summary = Object.hasOwn(completedSummaries, toolName)
    ? completedSummaries[toolName]!
    : "your request was completed";
  return `Done: ${summary}.`;
}
