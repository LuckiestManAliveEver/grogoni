import type {
  ParseResult,
  ParserNextAction,
  ParserSlots,
  RuleIntent
} from "../contracts/runtime.js";

export function shouldUseStructuredFallback(
  result: ParseResult,
  previousClarificationCount: number
): boolean {
  return result.nextAction.type === "clarify" && previousClarificationCount >= 2;
}

interface IntentRule {
  intent: Exclude<RuleIntent, "unknown">;
  keywords: string[];
  phrases: string[];
  weight: number;
}

const highConfidenceThreshold = 0.44;
const lowConfidenceThreshold = 0.42;

const intentRules: IntentRule[] = [
  {
    intent: "show_products",
    keywords: ["products", "product", "bidhaa", "stock", "inventory"],
    phrases: [
      "show products",
      "list products",
      "open products",
      "show stock",
      "list stock",
      "onyesha bidhaa"
    ],
    weight: 1
  },
  {
    intent: "show_invoices",
    keywords: ["invoices", "invoice", "ankara", "bills", "sales"],
    phrases: [
      "show invoices",
      "list invoices",
      "open invoices",
      "show sales",
      "list sales",
      "onyesha ankara",
      "invoice list"
    ],
    weight: 1
  },
  {
    intent: "show_reports",
    keywords: ["reports", "report", "ripoti", "insights", "knowledge"],
    phrases: [
      "show reports",
      "show report",
      "list reports",
      "open reports",
      "business summary",
      "onyesha ripoti"
    ],
    weight: 1
  },
  {
    intent: "show_notifications",
    keywords: ["notifications", "notification", "alerts", "alert"],
    phrases: [
      "show notifications",
      "show alerts",
      "list notifications",
      "list alerts",
      "open notifications",
      "open alerts"
    ],
    weight: 1
  },
  {
    intent: "add_product",
    keywords: [
      "add",
      "ongeza",
      "new",
      "stock",
      "product",
      "bidhaa",
      "item",
      "weka",
      "packet",
      "packets",
      "bag",
      "bags",
      "cement"
    ],
    phrases: [
      "add product",
      "add packet",
      "add packets",
      "add bag",
      "add bags",
      "add stock",
      "new product",
      "new item",
      "stock product",
      "ongeza bidhaa",
      "ongeza product",
      "ongeza stock",
      "weka bidhaa"
    ],
    weight: 1.08
  },
  {
    intent: "update_product",
    keywords: ["edit", "update", "modify", "change", "correct", "revise", "rename", "product"],
    phrases: [
      "edit product",
      "update product",
      "modify product",
      "change product",
      "correct product",
      "revise product",
      "rename product",
      "hariri bidhaa",
      "badilisha bidhaa",
      "rekebisha bidhaa"
    ],
    weight: 1.08
  },
  {
    intent: "adjust_stock",
    keywords: ["adjust", "stock", "quantity", "increase", "decrease", "reduce"],
    phrases: [
      "adjust stock",
      "change quantity",
      "update quantity",
      "add quantity",
      "reduce quantity",
      "increase stock",
      "decrease stock",
      "stock adjustment",
      "correct stock",
      "rekebisha stock",
      "ongeza idadi",
      "punguza idadi"
    ],
    weight: 1.1
  },
  {
    intent: "add_customer",
    keywords: ["add", "ongeza", "new", "customer", "client", "mteja", "mpya"],
    phrases: [
      "add customer",
      "new customer",
      "ongeza mteja",
      "ongeza customer",
      "add client",
      "add mteja",
      "new client",
      "new mteja",
      "mteja mpya"
    ],
    weight: 1.08
  },
  {
    intent: "update_customer",
    keywords: ["edit", "update", "modify", "change", "customer", "client", "mteja"],
    phrases: [
      "edit customer",
      "update customer",
      "modify customer",
      "change customer",
      "edit client",
      "update client",
      "hariri mteja",
      "badilisha mteja"
    ],
    weight: 1.08
  },
  {
    intent: "add_supplier",
    keywords: ["add", "ongeza", "new", "supplier", "msambazaji", "mpya"],
    phrases: [
      "add supplier",
      "new supplier",
      "ongeza msambazaji",
      "ongeza supplier",
      "new msambazaji",
      "msambazaji mpya"
    ],
    weight: 1.08
  },
  {
    intent: "update_supplier",
    keywords: ["edit", "update", "modify", "change", "supplier", "msambazaji"],
    phrases: [
      "edit supplier",
      "update supplier",
      "modify supplier",
      "change supplier",
      "hariri msambazaji",
      "badilisha msambazaji"
    ],
    weight: 1.08
  },
  {
    intent: "create_invoice",
    keywords: ["invoice", "ankara", "bill", "sell", "sale", "uza", "create", "make"],
    phrases: [
      "create invoice",
      "make invoice",
      "new invoice",
      "andika ankara",
      "invoice customer",
      "create bill"
    ],
    weight: 1
  },
  {
    intent: "record_payment",
    keywords: ["payment", "paid", "pay", "malipo", "amelipa", "mpesa", "cash", "received"],
    phrases: [
      "record payment",
      "mark paid",
      "received payment",
      "ame lipa",
      "malipo ya",
      "customer paid",
      "mpesa"
    ],
    weight: 1
  },
  {
    intent: "update_logistics",
    keywords: [
      "delivered",
      "delivery",
      "picked",
      "pickup",
      "dispatched",
      "shipped",
      "fulfil",
      "fulfill"
    ],
    phrases: [
      "mark delivered",
      "mark as delivered",
      "out for delivery",
      "mark picked up",
      "picked up",
      "mark dispatched",
      "delivery complete",
      "imefika",
      "imetumwa"
    ],
    weight: 1.1
  },
  {
    intent: "check_debt",
    keywords: ["debt", "deni", "owes", "owe", "balance", "baki", "credit"],
    phrases: [
      "check debt",
      "show debt",
      "ana deni",
      "customer balance",
      "owes how much",
      "baki ya"
    ],
    weight: 1
  }
];

const commandWords = new Set([
  "add",
  "adjust",
  "andika",
  "badilisha",
  "change",
  "correct",
  "create",
  "edit",
  "for",
  "hariri",
  "invoice",
  "list",
  "make",
  "modify",
  "new",
  "open",
  "ongeza",
  "price",
  "product",
  "quantity",
  "record",
  "rekebisha",
  "revise",
  "show",
  "stock",
  "the",
  "to",
  "update",
  "weka"
]);

export function parseMerchantCommand(input: string): ParseResult {
  const normalizedInput = normalizeInput(input);

  if (normalizedInput.length === 0) {
    return createUnknownResult(normalizedInput, "Type a command first.");
  }

  const scores = intentRules.map((rule) => ({
    intent: rule.intent,
    score: scoreRule(normalizedInput, rule)
  }));
  scores.sort((left, right) => right.score - left.score);

  const best = scores[0];
  const second = scores[1];
  const confidence =
    best === undefined
      ? 0
      : Math.min(0.99, roundConfidence(best.score - (second?.score ?? 0) * 0.25));

  if (
    best === undefined ||
    best.score < lowConfidenceThreshold ||
    confidence < lowConfidenceThreshold
  ) {
    return createUnknownResult(
      normalizedInput,
      "I could not match that to a Grogoni command. Try products, customers, invoices, payments, or debt."
    );
  }

  const intent = best.intent;
  const slots = extractSlots(normalizedInput, intent);

  if (confidence < highConfidenceThreshold) {
    return {
      confidence,
      intent,
      nextAction: {
        type: "clarify",
        question: `Did you mean ${formatIntent(intent)}?`,
        reason: "Parser confidence is below the action threshold."
      },
      normalizedInput,
      slots
    };
  }

  const missingSlotQuestion = getMissingSlotQuestion(intent, slots);

  if (missingSlotQuestion !== undefined) {
    return {
      confidence,
      intent,
      nextAction: {
        type: "clarify",
        question: missingSlotQuestion,
        reason: "A required slot is missing."
      },
      normalizedInput,
      slots
    };
  }

  return {
    confidence,
    intent,
    nextAction: getNextAction(intent),
    normalizedInput,
    slots
  };
}

function createUnknownResult(normalizedInput: string, question: string): ParseResult {
  return {
    confidence: 0,
    intent: "unknown",
    nextAction: {
      type: "clarify",
      question,
      reason: "No supported intent matched."
    },
    normalizedInput,
    slots: {}
  };
}

export function getNextAction(intent: Exclude<RuleIntent, "unknown">): ParserNextAction {
  if (intent === "show_products") {
    return {
      type: "navigate",
      view: "products",
      reason: "Read-only product navigation is safe in CP4."
    };
  }

  if (intent === "show_invoices") {
    return {
      type: "navigate",
      view: "invoices",
      reason: "Read-only invoice navigation is safe."
    };
  }

  if (intent === "check_debt") {
    return {
      type: "navigate",
      view: "payments",
      reason: "Debt checking routes to the payment placeholder until CP8."
    };
  }

  if (intent === "show_reports") {
    return {
      type: "navigate",
      view: "reports",
      reason: "Read-only report navigation is safe."
    };
  }

  if (intent === "show_notifications") {
    return {
      type: "navigate",
      view: "notifications",
      reason: "Read-only notification navigation is safe."
    };
  }

  return {
    type: "draft",
    reason: "State-changing commands remain drafts until deterministic validation and confirmation."
  };
}

function getMissingSlotQuestion(intent: RuleIntent, slots: ParserSlots): string | undefined {
  if (intent === "add_product" && slots.productName === undefined) {
    return "Which product should I draft?";
  }

  if (intent === "update_product" && slots.productName === undefined) {
    return "Which product should I edit?";
  }

  if (intent === "adjust_stock" && slots.productName === undefined) {
    return "Which product stock should I adjust?";
  }

  if (
    intent === "adjust_stock" &&
    slots.productName !== undefined &&
    slots.quantity === undefined
  ) {
    return "What should the new quantity be?";
  }

  if (intent === "add_supplier" && slots.supplierName === undefined) {
    return "What is the supplier name?";
  }

  if (intent === "update_supplier" && slots.supplierName === undefined) {
    return "Which supplier should I edit?";
  }

  if (
    intent === "update_supplier" &&
    slots.supplierName !== undefined &&
    slots.phone === undefined
  ) {
    return "What should the new phone number be?";
  }

  if (intent === "add_customer" && slots.customerName === undefined) {
    return "What is the customer name?";
  }

  if (intent === "update_customer" && slots.customerName === undefined) {
    return "Which customer should I edit?";
  }

  if (
    intent === "update_customer" &&
    slots.customerName !== undefined &&
    slots.phone === undefined
  ) {
    return "What should the new phone number be?";
  }

  if (intent === "create_invoice" && slots.customerName === undefined) {
    return "Who is this invoice for?";
  }

  if (intent === "record_payment" && slots.amount === undefined) {
    return "How much was paid?";
  }

  return undefined;
}

function extractSlots(input: string, intent: RuleIntent): ParserSlots {
  const slots: ParserSlots = {};
  const amountMatch = input.match(
    /\b(?:kes|ksh|sh|k)\s?(\d+(?:\.\d+)?)\b|\b(\d+(?:\.\d+)?)\s?(?:kes|ksh|sh|bob)\b/
  );
  const amountValue = amountMatch?.[1] ?? amountMatch?.[2];

  if (amountValue !== undefined) {
    slots.amount = Number(amountValue);
  }

  // A currency-tagged number ("ksh 150") must not also be read as a bare quantity - without this,
  // "add product sugar ksh 150" would set both quantity and price to 150.
  const inputWithoutAmount = amountMatch === null ? input : input.replace(amountMatch[0], " ");

  // A phone number (7+ digits, optionally +/spaces/dashes) is long enough not to collide with a
  // typical quantity or price - matched and removed first so "add supplier John 0712345678" does
  // not also read 0712345678 as a quantity.
  const phoneMatch = inputWithoutAmount.match(/\b(\+?\d[\d\s-]{6,14}\d)\b/);

  if (phoneMatch?.[1] !== undefined) {
    slots.phone = phoneMatch[1].replace(/[\s-]/g, "");
  }

  const inputWithoutPhone =
    phoneMatch === null ? inputWithoutAmount : inputWithoutAmount.replace(phoneMatch[0], " ");
  const quantityMatch = inputWithoutPhone.match(/\b(\d+(?:\.\d+)?)\b/);

  if (quantityMatch?.[1] !== undefined) {
    slots.quantity = Number(quantityMatch[1]);
  }

  if (intent === "add_product" || intent === "update_product" || intent === "adjust_stock") {
    const productName = extractNamedValue(input, [
      "product",
      "bidhaa",
      "stock",
      "item",
      "of",
      "ya"
    ]);
    const unit = extractUnit(input);

    if (productName !== undefined) {
      slots.productName = productName;
    }

    if (unit !== undefined) {
      slots.unit = unit;
    }
  }

  if (intent === "add_supplier" || intent === "update_supplier") {
    const supplierName = extractNamedValue(input, ["supplier", "msambazaji", "for", "ya"]);

    if (supplierName !== undefined) {
      slots.supplierName = supplierName;
    }
  }

  if (
    intent === "add_customer" ||
    intent === "update_customer" ||
    intent === "create_invoice" ||
    intent === "check_debt" ||
    intent === "update_logistics"
  ) {
    const customerName = extractNamedValue(input, ["customer", "client", "mteja", "for", "ya"]);

    if (customerName !== undefined) {
      slots.customerName = customerName;
    }
  }

  if (intent === "record_payment") {
    const customerName = extractNamedValue(input, ["from", "customer", "client", "mteja", "kwa"]);

    if (customerName !== undefined) {
      slots.customerName = customerName;
    }

    if (slots.amount === undefined && slots.quantity !== undefined) {
      slots.amount = slots.quantity;
    }
  }

  return stripUndefinedSlots(slots);
}

function extractNamedValue(input: string, markers: string[]): string | undefined {
  const words = input.split(" ");
  const markerIndex = words.findIndex((word) => markers.includes(word));
  const startIndex = markerIndex >= 0 ? markerIndex + 1 : 0;
  const candidates = words
    .slice(startIndex)
    .filter((word) => !commandWords.has(word))
    .filter((word) => !/^\d+(?:\.\d+)?$/.test(word))
    .filter((word) => !["kes", "ksh", "sh", "bob", "paid", "payment", "malipo"].includes(word));

  if (candidates.length === 0) {
    return undefined;
  }

  return titleCase(candidates.slice(0, 4).join(" "));
}

function extractUnit(input: string): string | undefined {
  const unitMatch = input.match(
    /\b(?:kg|kgs|packet|packets|crate|crates|box|boxes|pcs|pieces|bags?)\b/
  );
  return unitMatch?.[0];
}

function scoreRule(input: string, rule: IntentRule): number {
  const phraseScore = rule.phrases.reduce(
    (score, phrase) => (input.includes(phrase) ? score + 0.72 : score),
    0
  );
  const keywordHits = rule.keywords.filter((keyword) => input.includes(keyword)).length;
  const keywordScore = keywordHits * 0.24;

  return (phraseScore + keywordScore) * rule.weight;
}

function normalizeInput(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

function stripUndefinedSlots(slots: ParserSlots): ParserSlots {
  return Object.fromEntries(
    Object.entries(slots).filter(([, value]) => value !== undefined)
  ) as ParserSlots;
}

export function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function formatIntent(intent: RuleIntent): string {
  return intent.replaceAll("_", " ");
}
