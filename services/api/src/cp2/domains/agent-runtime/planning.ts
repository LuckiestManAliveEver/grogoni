import {
  createRuntimeToolProposalFromReceiptContextScript,
  invalid,
  valid,
  validateRuntimeToolInput,
  type ReceiptContextScriptMatch,
  type RuntimeToolProposal
} from "@grogoni/tool-core";

import { isChannelProvider, normalizeRuntimeLookup } from "./shared.js";
import type { AgentRuntimeDomainDeps } from "./store.js";

export function createRuntimeReceiptProposal(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    message: string;
    match: ReceiptContextScriptMatch;
    now: Date;
  }
): RuntimeToolProposal {
  const base = createRuntimeToolProposalFromReceiptContextScript(input.match);
  const extraction = documentExtractionFromRuntimeMessage(input.message);

  if (input.match.intent === "RECEIPT_SCAN") {
    const toolInput = {
      ...base.input,
      ...(extraction === null
        ? {}
        : {
            extractedText: extraction.text,
            fileName: extraction.fileName,
            contentType: "text/plain"
          })
    };
    return {
      ...base,
      input: toolInput,
      validation: validateRuntimeToolInput("receipt.scan", toolInput)
    };
  }

  if (
    input.match.intent !== "RECEIPT_CONFIRM" &&
    input.match.intent !== "RECEIPT_CORRECT" &&
    input.match.intent !== "RECEIPT_CANCEL"
  ) {
    return base;
  }

  const pendingJobs = deps
    .listReceiptOCRJobs({
      sessionId: input.sessionId,
      businessId: input.businessId,
      now: input.now
    })
    .filter(
      (job) =>
        !["CONFIRMED", "PURCHASE_RECORDED", "COMPLETED", "CANCELLED", "confirmed"].includes(
          job.status
        )
    );
  const referencedJob = pendingJobs.find((job) => input.message.includes(job.id));
  const job = referencedJob ?? pendingJobs[0];
  const toolInput = {
    ...base.input,
    ...(job === undefined ? {} : { ocrJobId: job.id }),
    ...(input.match.intent === "RECEIPT_CORRECT" && extraction !== null
      ? { extractedText: extraction.text }
      : {})
  };
  const toolName = base.toolName;

  return {
    ...base,
    input: toolInput,
    validation:
      job === undefined
        ? invalid("Scan a receipt before asking me to update it.")
        : validateRuntimeToolInput(toolName, toolInput)
  };
}

/** Owner-network discovery is deterministic so it never depends on a frontend side effect. */
export function createRuntimeNetworkProposal(message: string): RuntimeToolProposal | null {
  const normalized = normalizeRuntimeLookup(message);
  const isNetworkDiscovery =
    normalized.includes("through my network") ||
    normalized.includes("connected to") ||
    normalized.includes("contacts who") ||
    normalized.includes("friends know") ||
    normalized.includes("my network") ||
    (normalized.includes("find") && normalized.includes("supplier"));

  if (!isNetworkDiscovery) return null;
  const toolInput = { requestText: message.trim() };
  return {
    toolName: "network.route",
    input: toolInput,
    reason: "Request an agent-mediated route through the owner's canonical network graph.",
    validation: validateRuntimeToolInput("network.route", toolInput)
  };
}

export function createRuntimeCommerceProposal(message: string): RuntimeToolProposal | null {
  const normalized = normalizeRuntimeLookup(message);
  if (
    !normalized.includes("buy feed") &&
    !normalized.includes("where can i buy") &&
    !normalized.includes("shop for")
  ) {
    return null;
  }
  const query = normalized
    .replace(/\b(?:search|show|open|the|buy feed|where can i buy|shop for)\b/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    toolName: "commerce.search",
    input: query === "" ? {} : { query },
    reason: "Search the canonical unified commerce feed.",
    validation: valid()
  };
}

function documentExtractionFromRuntimeMessage(
  message: string
): { fileName: string; text: string } | null {
  const match =
    /\[document-extraction file="([^"]+)" format="[^"]+"\]\s*([\s\S]*?)\s*\[\/document-extraction\]/u.exec(
      message
    );
  const text = match?.[2]?.trim() ?? "";
  return match?.[1] === undefined || text.length === 0 ? null : { fileName: match[1], text };
}

/** Deterministic capability planners that run before model fallback. */
export function createRuntimeMessagingProposal(
  deps: AgentRuntimeDomainDeps,

  businessId: string,
  message: string
): RuntimeToolProposal | null {
  const invoiceEmail =
    /^(?:please\s+)?(?:email|send)\s+(.+?)\s+(?:the\s+|their\s+)?(?:latest\s+)?invoice(?:\s+by\s+email)?[.!]?$/iu.exec(
      message.trim()
    );
  if (invoiceEmail?.[1] !== undefined) {
    const requestedName = invoiceEmail[1].trim();
    const customers = [...deps.customers.values()].filter(
      (customer) =>
        customer.businessId === businessId &&
        customer.name.localeCompare(requestedName, undefined, { sensitivity: "accent" }) === 0
    );
    const customer = customers.length === 1 ? customers[0] : undefined;
    const invoice =
      customer === undefined
        ? undefined
        : [...deps.invoices.values()]
            .filter(
              (candidate) =>
                candidate.businessId === businessId &&
                candidate.customerId === customer.id &&
                candidate.status === "confirmed"
            )
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return {
      toolName: "messaging.send",
      input:
        customer === undefined || invoice === undefined
          ? {}
          : {
              customerId: customer.id,
              provider: "email",
              subject: `Invoice ${invoice.invoiceNumber}`,
              text: "Please find your invoice attached.",
              attachments: [{ resourceType: "invoice", resourceId: invoice.id }]
            },
      reason: `Prepared the latest confirmed invoice email for ${requestedName}.`,
      validation:
        customer === undefined
          ? invalid("Choose one canonical customer before sending an invoice.")
          : invoice === undefined
            ? invalid("Confirm an invoice for this customer before sending it.")
            : valid()
    };
  }
  const email = /^(?:please\s+)?email\s+(.+?)\s+(?:that|saying|:)\s+(.+)$/iu.exec(message.trim());
  const direct =
    /^(?:please\s+)?(?:message|tell)\s+(.+?)(?:\s+on\s+(telegram|whatsapp|messenger|instagram|tiktok|x|native[_ ]?sms|sms|email|grogoni))?\s+(?:that|saying|:)\s+(.+)$/iu.exec(
      message.trim()
    );
  const send =
    /^(?:please\s+)?send\s+["“]?(.+?)["”]?\s+to\s+(.+?)(?:\s+on\s+(telegram|whatsapp|messenger|instagram|tiktok|x|native[_ ]?sms|sms|email|grogoni))?$/iu.exec(
      message.trim()
    );
  const customerName = (email?.[1] ?? direct?.[1] ?? send?.[2])?.trim();
  const text = (email?.[2] ?? direct?.[3] ?? send?.[1])?.trim();
  const providerInput = (email === null ? (direct?.[2] ?? send?.[3]) : "email")
    ?.toLowerCase()
    .replace(" ", "_");
  const provider = providerInput === "sms" ? "native_sms" : providerInput;
  if (!customerName || !text) return null;
  return {
    toolName: "messaging.send",
    input: {
      customerName,
      text,
      ...(provider === "email" ? { subject: "Update from Grogoni" } : {}),
      ...(isChannelProvider(provider) ? { provider } : {})
    },
    reason: `Prepared a message to ${customerName}${provider ? ` on ${provider}` : ""}.`,
    validation:
      text.length <= 4000 ? valid() : invalid("The message is longer than 4000 characters.")
  };
}

export function createRuntimeDocumentImportProposal(
  deps: AgentRuntimeDomainDeps,

  businessId: string,
  message: string
): RuntimeToolProposal | null {
  const normalized = normalizeRuntimeLookup(message);
  const hasAction = /\b(add|apply|confirm|import|save|store)\b/u.test(normalized);
  const referencesDocument =
    /\b(catalogue|catalog|document|excel|extracted|import|pdf|spreadsheet|uploaded|word|workbook)\b/u.test(
      normalized
    );
  const businessImports = deps.importsForBusiness(businessId);
  const referencedJob = businessImports.find((job) => message.includes(job.id));

  if (!hasAction || (!referencesDocument && referencedJob === undefined)) {
    return null;
  }

  const latestPreview = businessImports
    .filter((job) => job.status === "previewed")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const job = referencedJob ?? latestPreview;

  if (job === undefined) {
    return {
      toolName: "document_import.confirm",
      input: {},
      reason: "No previewed document import is available.",
      validation: invalid("Upload and preview a document before asking me to add its records.")
    };
  }

  if (job.status !== "previewed") {
    return {
      toolName: "document_import.confirm",
      input: { importJobId: job.id, target: job.target },
      reason: "The referenced document import is not awaiting confirmation.",
      validation: invalid("Only a previewed document import can be added.")
    };
  }

  const selectedRows = job.rows.filter((row) => row.selected && row.errors.length === 0);

  return {
    toolName: "document_import.confirm",
    input: {
      importJobId: job.id,
      target: job.target,
      selectedRowCount: selectedRows.length
    },
    reason: `Prepared ${selectedRows.length} extracted ${job.target} record${
      selectedRows.length === 1 ? "" : "s"
    } from ${job.source.fileName}.`,
    validation:
      selectedRows.length === 0
        ? invalid("The document preview has no valid selected rows to add.")
        : valid()
  };
}
