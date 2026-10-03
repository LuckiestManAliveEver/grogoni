import {
  parseMerchantCommand,
  parseProductContextScriptCommand,
  productContextScriptMatchToParseResult,
  type ParseResult
} from "@grogoni/tool-core";

import { quickActions, type ShellView } from "./app-shell";

import {
  type AgentSettings,
  type CustomerDebtSummary,
  type CustomerSummary,
  type InvoiceSummary,
  type ProductSummary
} from "./grogoni-application-shared";

import { formatAgentDisplayName } from "./formatters";

export function viewLabel(view: ShellView): string {
  if (view === "agent") return "Account and agent settings";
  const action = quickActions.find((item) => item.id === view);
  return action?.label ?? "Business home";
}

export function extractAgentHelpCommand(message: string): string | null | undefined {
  const match = message
    .trim()
    .match(
      /^(?:please\s+)?(?:ask\s+the\s+agent\s+for\s+help|help(?:\s+me)?|can\s+you\s+help(?:\s+me)?|i\s+need\s+help)(?:\s+(?:to|with))?\s*[,:-]?\s*(.*)$/i
    );

  if (match === null) {
    return undefined;
  }

  const command = match[1]?.trim() ?? "";
  return command.length === 0 ? null : command;
}

export function resolveAgentHelpDestination(command: string): ShellView | null {
  if (!/\b(?:open|go\s+to|navigate\s+to|take\s+me\s+to|show(?:\s+me)?|view)\b/i.test(command)) {
    return null;
  }

  const destinations: Array<{ aliases: RegExp; view: ShellView }> = [
    { aliases: /\bproducts?|catalogue|inventory\b/i, view: "products" },
    { aliases: /\bsuppliers?\b/i, view: "suppliers" },
    { aliases: /\bcustomers?\b/i, view: "customers" },
    { aliases: /\b(?:pos|point[ -]of[ -]sale|checkout|ring up)\b/i, view: "pos" },
    { aliases: /\binvoices?|sales?\b/i, view: "invoices" },
    { aliases: /\bpayments?|debts?|balances?\b/i, view: "payments" },
    { aliases: /\bmy\s+network|network\b/i, view: "network" },
    { aliases: /\bpurchase\s+receipts?|receipts?|imports?\b/i, view: "imports" },
    { aliases: /\bdeliver(?:y|ies)|logistics\b/i, view: "logistics" },
    { aliases: /\breports?|business\s+summary\b/i, view: "reports" },
    { aliases: /\balerts?|notifications?\b/i, view: "notifications" },
    { aliases: /\bhome|workspace\b/i, view: "home" }
  ];

  return destinations.find((destination) => destination.aliases.test(command))?.view ?? null;
}

export function createAgentHelpReply(): string {
  return "Tell me where you want to go or give me a command. I can open Products, POS terminal, Suppliers, Customers, Invoices, Payments, My Network, Purchase receipts, Reports, or Alerts. Try “#pos”, “help me open products”, or “help me add product Sugar.” I’ll navigate or prepare the command for your review.";
}

export type AgentRuntimeDecision =
  | {
      kind: "act";
      matchedCustomer: CustomerSummary | null;
      matchedProduct: ProductSummary | null;
      response: string;
      result: ParseResult;
    }
  | {
      kind: "options" | "resubmit";
      response: string;
    };

export function createAgentRuntimeDecision(input: {
  agent: AgentSettings;
  clarificationCount: number;
  customers: CustomerSummary[];
  customerDebts: CustomerDebtSummary[];
  invoices: InvoiceSummary[];
  message: string;
  products: ProductSummary[];
}): AgentRuntimeDecision {
  const scriptedResult = resolveContextScriptCommand(input.agent.contextScripts, input.message);
  const parserResult = scriptedResult ?? parseMerchantCommand(input.message);
  const matchedProduct = findBestMenuProduct(input.message, input.products);
  const matchedCustomer = findBestCustomer(input.message, input.customers);
  const menuResult =
    parserResult.intent === "unknown" && matchedProduct !== null && hasUseVerb(input.message)
      ? createMenuInvoiceResult(input.message, matchedProduct, matchedCustomer)
      : parserResult;
  const confidence =
    scriptedResult === null
      ? getAgentConfidence({
          matchedCustomer,
          matchedProduct,
          message: input.message,
          result: menuResult
        })
      : 0.95;

  if (scriptedResult !== null && menuResult.nextAction.type === "clarify") {
    return {
      kind: "options",
      response:
        "The matching context script needs more detail. Resend the task with the missing product, customer, invoice, or amount."
    };
  }

  if (confidence >= 0.75 && menuResult.nextAction.type !== "clarify") {
    return {
      kind: "act",
      matchedCustomer,
      matchedProduct,
      response: createAgentActionReply({
        agent: input.agent,
        customer: matchedCustomer,
        product: matchedProduct,
        result: menuResult
      }),
      result: menuResult
    };
  }

  if (confidence >= 0.5 || input.clarificationCount === 0) {
    return {
      kind: "options",
      response: createAgentOptionsReply({
        customers: input.customers,
        customerDebts: input.customerDebts,
        invoices: input.invoices,
        matchedCustomer,
        matchedProduct,
        products: input.products,
        result: menuResult
      })
    };
  }

  return {
    kind: "resubmit",
    response:
      "Please resend the task with the action and item name together, for example: show products, create invoice for Mary with Sugar, or record payment 500 for invoice INV-001."
  };
}

export function resolveContextScriptCommand(
  contextScripts: string[],
  message: string
): ParseResult | null {
  const match = parseProductContextScriptCommand({
    message,
    contextScripts,
    tenantId: "local-agent"
  });

  return match === null ? null : productContextScriptMatchToParseResult(match);
}

export function getAgentConfidence(input: {
  matchedCustomer: CustomerSummary | null;
  matchedProduct: ProductSummary | null;
  message: string;
  result: ParseResult;
}): number {
  if (input.result.intent !== "unknown" && input.result.nextAction.type !== "clarify") {
    return Math.max(input.result.confidence, 0.76);
  }

  if (input.matchedProduct !== null && hasUseVerb(input.message)) {
    return 0.82;
  }

  if (input.matchedProduct !== null || input.matchedCustomer !== null) {
    return 0.55;
  }

  if (input.result.intent !== "unknown") {
    return 0.5;
  }

  return input.result.confidence;
}

export function createAgentActionReply(input: {
  agent: AgentSettings;
  customer: CustomerSummary | null;
  product: ProductSummary | null;
  result: ParseResult;
}): string {
  const agentLabel = formatAgentDisplayName(input.agent);

  if (input.result.nextAction.type === "navigate") {
    return `${agentLabel} opened ${viewLabel(input.result.nextAction.view)}.`;
  }

  if (input.result.intent === "add_product") {
    return `${agentLabel} opened Products. Business changes still require the authorized runtime; resend when you are online.`;
  }

  if (input.result.intent === "add_customer") {
    return `${agentLabel} opened Customers. Business changes still require the authorized runtime; resend when you are online.`;
  }

  if (input.result.intent === "create_invoice") {
    const productText = input.product === null ? "" : ` with ${input.product.name}`;
    const customerText = input.customer === null ? "" : ` for ${input.customer.name}`;
    return `${agentLabel} opened Invoices${customerText}${productText}. Creating one still requires the authorized runtime.`;
  }

  if (input.result.intent === "record_payment") {
    return `${agentLabel} opened Payments. Recording a payment still requires the authorized runtime.`;
  }

  if (input.result.intent === "check_debt") {
    return `${agentLabel} opened payments and debt records.`;
  }

  return `${agentLabel} prepared the matching workspace action.`;
}

export function createAgentOptionsReply(input: {
  customers: CustomerSummary[];
  customerDebts: CustomerDebtSummary[];
  invoices: InvoiceSummary[];
  matchedCustomer: CustomerSummary | null;
  matchedProduct: ProductSummary | null;
  products: ProductSummary[];
  result: ParseResult;
}): string {
  const options = buildAgentOptions(input);

  if (input.result.nextAction.type === "clarify" && input.result.intent !== "unknown") {
    return `${input.result.nextAction.question} Resend the task with that detail included.`;
  }

  return `I found a few possible matches. Resend the task with one option: ${options.join("; ")}.`;
}

export function buildAgentOptions(input: {
  customers: CustomerSummary[];
  customerDebts: CustomerDebtSummary[];
  invoices: InvoiceSummary[];
  matchedCustomer: CustomerSummary | null;
  matchedProduct: ProductSummary | null;
  products: ProductSummary[];
}): string[] {
  const options = [
    input.matchedProduct === null ? null : `use product ${input.matchedProduct.name}`,
    input.matchedCustomer === null ? null : `use customer ${input.matchedCustomer.name}`,
    input.products.length > 0 ? "show products" : null,
    input.customers.length > 0 ? "show customers" : null,
    input.invoices.length > 0 ? "show invoices" : null,
    input.customerDebts.length > 0 ? "check customer debt" : null
  ].filter((option): option is string => option !== null);

  return options.length === 0
    ? ["show products", "create invoice for a customer", "record payment for an invoice"]
    : options.slice(0, 4);
}

export function createMenuInvoiceResult(
  message: string,
  product: ProductSummary,
  customer: CustomerSummary | null
): ParseResult {
  const slots: ParseResult["slots"] = {
    productName: product.name,
    quantity: extractFirstNumber(message) ?? 1,
    unit: product.unit
  };

  if (customer !== null) {
    slots.customerName = customer.name;
  }

  return {
    confidence: 0.82,
    intent: "create_invoice",
    nextAction: {
      type: "draft",
      reason: "Matched a requested menu item to an invoice draft."
    },
    normalizedInput: normalizeSearchText(message),
    slots
  };
}

export function findInvoiceForPayment(
  invoices: InvoiceSummary[],
  customer: CustomerSummary | null
): InvoiceSummary | null {
  const candidates =
    customer === null
      ? invoices
      : invoices.filter(
          (invoice) =>
            invoice.customerId === customer.id ||
            normalizeSearchText(invoice.customerName ?? "") === normalizeSearchText(customer.name)
        );
  return candidates.find((invoice) => invoice.status !== "confirmed") ?? candidates[0] ?? null;
}

export function findBestMenuProduct(
  message: string,
  products: ProductSummary[]
): ProductSummary | null {
  return findBestByName(message, products, (product) =>
    [product.name, product.sku ?? "", product.unit].join(" ")
  );
}

export function findBestCustomer(
  message: string,
  customers: CustomerSummary[]
): CustomerSummary | null {
  return findBestByName(message, customers, (customer) =>
    [customer.name, customer.phone ?? "", customer.email ?? ""].join(" ")
  );
}

export function findBestByName<TItem>(
  message: string,
  items: TItem[],
  getSearchText: (item: TItem) => string
): TItem | null {
  const messageTokens = new Set(tokenizeSearchText(message));
  let best: { item: TItem; score: number } | null = null;

  for (const item of items) {
    const itemTokens = tokenizeSearchText(getSearchText(item));
    if (itemTokens.length === 0) {
      continue;
    }

    const score = itemTokens.filter((token) => messageTokens.has(token)).length / itemTokens.length;

    if (score > 0 && (best === null || score > best.score)) {
      best = { item, score };
    }
  }

  return best !== null && best.score >= 0.34 ? best.item : null;
}

export function hasUseVerb(message: string): boolean {
  const tokens = new Set(tokenizeSearchText(message));
  return ["add", "buy", "get", "invoice", "need", "order", "sell", "take", "use", "want"].some(
    (verb) => tokens.has(verb)
  );
}

export function extractFirstNumber(message: string): number | undefined {
  const match = message.match(/\b\d+(?:\.\d+)?\b/);

  if (match === null) {
    return undefined;
  }

  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length > 1);
}
