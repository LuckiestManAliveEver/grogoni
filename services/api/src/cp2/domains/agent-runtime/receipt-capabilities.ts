import type { RuntimePlannedAction } from "@grogoni/shared-types";
import type { AgentRuntimeDomainDeps } from "./store.js";

export function executeReceiptCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    action: RuntimePlannedAction;
    now: Date;
  }
): unknown {
  switch (input.action.toolName) {
    case "receipt.scan":
      return deps.createReceiptOCRJob({
        sessionId: input.sessionId,
        businessId: input.businessId,
        sourceFileName:
          typeof input.action.input.fileName === "string"
            ? input.action.input.fileName
            : "agent-receipt.txt",
        contentType:
          typeof input.action.input.contentType === "string"
            ? input.action.input.contentType
            : "text/plain",
        extractedText: String(input.action.input.extractedText ?? ""),
        now: input.now
      });

    case "receipt.confirm":
      return deps.confirmReceiptOCRJob({
        sessionId: input.sessionId,
        businessId: input.businessId,
        ocrJobId: String(input.action.input.ocrJobId ?? ""),
        ...(typeof input.action.input.supplierId === "string"
          ? { supplierId: input.action.input.supplierId }
          : {}),
        ...(typeof input.action.input.salesAgentId === "string"
          ? { salesAgentId: input.action.input.salesAgentId }
          : {}),
        ...(typeof input.action.input.createSupplier === "boolean"
          ? { createSupplier: input.action.input.createSupplier }
          : {}),
        ...(typeof input.action.input.createSalesAgent === "boolean"
          ? { createSalesAgent: input.action.input.createSalesAgent }
          : {}),
        now: input.now
      });

    case "receipt.correct":
      return deps.correctReceiptOCRJob({
        sessionId: input.sessionId,
        businessId: input.businessId,
        ocrJobId: String(input.action.input.ocrJobId ?? ""),
        extractedText: String(input.action.input.extractedText ?? ""),
        now: input.now
      });

    case "receipt.cancel":
      return deps.cancelReceiptOCRJob({
        sessionId: input.sessionId,
        businessId: input.businessId,
        ocrJobId: String(input.action.input.ocrJobId ?? ""),
        now: input.now
      });

    case "receipt.review":
      return deps.listReceiptOCRJobs({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });

    case "receipt.list":
      return deps.listPurchaseReceipts({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });

    case "receipt.lookup":
      return deps
        .listPurchaseReceipts({
          sessionId: input.sessionId,
          businessId: input.businessId,
          now: input.now
        })
        .filter((receipt) => {
          const supplierName = String(input.action.input.supplierName ?? "").toLowerCase();
          const itemName = String(input.action.input.itemName ?? "").toLowerCase();
          const supplierMatches =
            supplierName.length === 0 || receipt.supplierName.toLowerCase().includes(supplierName);
          const itemMatches =
            itemName.length === 0 ||
            receipt.lineItems.some((item) => item.name.toLowerCase().includes(itemName));

          return supplierMatches && itemMatches;
        });

    default:
      throw new Error(`Unsupported receipt capability: ${input.action.toolName}`);
  }
}
