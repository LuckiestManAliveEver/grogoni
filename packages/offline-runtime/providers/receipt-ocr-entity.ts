import type { ReceiptOCRJobSummary } from "@grogoni/shared-types";
import type { Entity, ReceiptOcrExtraction } from "../types.js";

/**
 * The local mirror of a captured receipt before it syncs. Structured field extraction and
 * supplier/sales-agent contact matching only run on the server (services/api/src/cp2/domains/
 * suppliers/store.ts), so this shell reports an honest "not yet matched" state rather than
 * duplicating that logic on-device - the same job comes back fully matched after `/sync/push`.
 */
export function receiptOcrJobEntity(
  id: string,
  businessId: string,
  uploadedBy: string,
  sourceFileName: string,
  contentType: string,
  extraction: ReceiptOcrExtraction,
  now: string
): Entity {
  const hasContent = extraction.fullText.trim().length > 0;
  const emptyMatch = {
    extractedName: null,
    extractedPhone: null,
    extractedEmail: null,
    selectedRecordId: null,
    selectedContactId: null,
    confidence: 0,
    matchedBy: [],
    sources: [],
    requiresConfirmation: false,
    candidates: []
  };
  const job: ReceiptOCRJobSummary = {
    id,
    businessId,
    tenantId: businessId,
    shopId: businessId,
    uploadedBy,
    status: hasContent ? "REVIEW_REQUIRED" : "FAILED",
    sourceFileName,
    contentType,
    engine: extraction.engine,
    engineVersion: extraction.engineVersion,
    modelVersion: extraction.modelVersion,
    profile: extraction.profile,
    fallbackUsed: extraction.fallbackUsed,
    languageHints: ["eng"],
    blocks: extraction.blocks,
    fullText: extraction.fullText,
    averageConfidence: extraction.averageConfidence,
    warnings: [
      ...extraction.warnings,
      "Captured offline. Supplier matching and confirmation need an online connection."
    ],
    fieldEvidence: [],
    structuredExtraction: {
      supplier: {
        supplierName: null,
        tradingName: null,
        legalName: null,
        phoneNumber: null,
        alternatePhoneNumber: null,
        email: null,
        physicalAddress: null,
        taxPin: null,
        registrationNumber: null,
        branch: null,
        accountNumber: null
      },
      salesAgent: {
        name: null,
        phoneNumber: null,
        email: null,
        agentNumber: null,
        supplierRepresented: null,
        branch: null,
        notes: null
      },
      receipt: {
        receiptNumber: null,
        invoiceNumber: null,
        orderNumber: null,
        purchaseDate: null,
        purchaseTime: null,
        currency: null,
        subtotal: null,
        discount: null,
        tax: null,
        total: null,
        amountPaid: null,
        balance: null,
        paymentMethod: null,
        tillNumber: null,
        paybillNumber: null,
        transactionReference: null
      },
      products: []
    },
    contactMatchingResult: {
      matched: false,
      scriptId: "receipt_contact_matching",
      intent: "RECEIPT_CONTACT_MATCH",
      source: "context_script",
      ocrJobId: id,
      supplier: emptyMatch,
      salesAgent: emptyMatch,
      unmatchedFields: [],
      warnings: [],
      thresholds: { autoSelect: 0, confirmationRequired: 0, rejectBelow: 0 }
    },
    supplierCandidates: [],
    salesAgentCandidates: [],
    supplierName: null,
    salesAgentName: null,
    phone: null,
    receiptDate: null,
    total: null,
    items: [],
    matchedSupplierId: null,
    matchedSalesAgentId: null,
    errorMessage: hasContent ? null : "No readable text was found. Try a clearer receipt photo.",
    failureCode: hasContent ? null : "OCR_EMPTY_RESULT",
    imageStorageKey: null,
    imageHash: null,
    imageRetained: false,
    imageDeletedAt: null,
    cleanupPending: false,
    retryCount: 0,
    processingStartedAt: now,
    completedAt: now,
    temporaryImageExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null
  };
  return job as unknown as Entity;
}
