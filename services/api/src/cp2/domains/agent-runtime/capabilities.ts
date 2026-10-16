import type {
  ClientWorkspaceFileTransfer,
  FulfillmentStatus,
  PaymentMethod,
  ProductFieldDefinition,
  RuntimePlannedAction
} from "@grogoni/shared-types";

import { Cp2Error } from "../../cp2-error.js";
import { isChannelProvider, normalizeRuntimeLookup } from "./shared.js";
import type { AgentRuntimeDomainDeps } from "./store.js";
import {
  isProductFieldInputType,
  runtimeInvoiceItems,
  runtimeProductFieldId
} from "./capability-inputs.js";
import { executeReceiptCapability } from "./receipt-capabilities.js";
import { executeNetworkCapability } from "./network-capabilities.js";
import { executeCoreReadCapability } from "./core-read-capabilities.js";
import { executeCommerceCapability } from "./commerce-capabilities.js";
import { executeCommercialRecordsCapability } from "./commercial-records-capabilities.js";
import { executeProcurementCapability } from "./procurement-capabilities.js";
import {
  findRuntimeCustomerByName,
  findRuntimeProductByName,
  findRuntimeSupplierByName
} from "./runtime-entity-lookup.js";
import { classifyComputerAction } from "@grogoni/tool-core";

// findRuntimeUnknownEntityReferenceError lives in ./runtime-entity-lookup.js alongside the
// by-name lookups it's built on, re-exported here since services/api/src/cp2/domains/agent-runtime
// /store.ts already imports it from this file.
export { findRuntimeUnknownEntityReferenceError } from "./runtime-entity-lookup.js";

/**
 * Canonical post-policy capability dispatcher.
 * createRuntimeTurn owns policy, validation, confirmation, and telemetry before delegating here.
 */
export async function executeRuntimeCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    conversationId?: string;
    workspaceFiles?: ClientWorkspaceFileTransfer[];
    action: RuntimePlannedAction;
    now: Date;
  }
): Promise<unknown> {
  if (input.action.toolName.startsWith("computer.")) {
    if (deps.executeComputerCapability)
      return deps.executeComputerCapability({
        sessionId: input.sessionId,
        businessId: input.businessId,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        action: input.action,
        now: input.now
      });
    const policy = classifyComputerAction({
      toolName: input.action.toolName,
      actionInput: input.action.input
    });
    throw new Cp2Error(
      policy.requiresApproval ? 409 : 503,
      policy.requiresApproval
        ? "computer_action_requires_runtime_handoff_approval"
        : "computer_runtime_provider_unconfigured",
      policy.requiresApproval
        ? "This computer action must be checkpointed through RuntimeHandoff and explicitly approved before execution."
        : "ComputerRuntime is registered as a capability, but no isolated browser provider is configured for this API process."
    );
  }
  switch (input.action.toolName) {
    case "procurement.quote.record":
    case "procurement.prepare":
    case "procurement.submit":
    case "procurement.respond":
      return executeProcurementCapability(deps, input);
    case "contacts.search":
    case "supplier.contact.attach":
    case "purchase.record":
    case "purchase.price.change":
    case "purchase.history":
    case "sale.record":
    case "sales.history":
    case "route.record":
    case "route.history":
      return executeCommercialRecordsCapability(deps, input);
    case "network.route":
    case "network.contacts.resolve":
    case "network.identity.list":
    case "network.identity.propose":
    case "network.identity.confirm":
    case "network.identity.reject":
    case "network.identity.unlink":
    case "network.identity.add":
      return executeNetworkCapability(deps, input);
    case "products.list":
    case "invoices.list":
    case "reports.summary":
    case "payments.debtors":
    case "notifications.list":
    case "compliance.review":
      return executeCoreReadCapability(deps, input);
    case "commerce.search":
    case "commerce.checkout":
      return executeCommerceCapability(deps, input);

    case "product.create":
      return deps.createProduct({
        sessionId: input.sessionId,
        businessId: input.businessId,
        product: {
          name: String(input.action.input.name ?? ""),
          sku: null,
          unit: String(input.action.input.unit ?? "unit"),
          quantity: Number(input.action.input.quantity ?? 0),
          sellingPrice:
            typeof input.action.input.sellingPrice === "number"
              ? input.action.input.sellingPrice
              : null
        },
        now: input.now
      });

    case "product.update": {
      const product = findRuntimeProductByName(
        deps,
        input.businessId,
        String(input.action.input.productName ?? "")
      );

      if (product === null) {
        throw new Cp2Error(
          404,
          "runtime_product_not_found",
          "The product selected by the context script was not found."
        );
      }

      return deps.updateProduct({
        sessionId: input.sessionId,
        businessId: input.businessId,
        productId: product.id,
        product: {
          name:
            typeof input.action.input.name === "string" && input.action.input.name.trim() !== ""
              ? input.action.input.name
              : product.name,
          sku: product.sku,
          unit:
            typeof input.action.input.unit === "string" && input.action.input.unit.trim() !== ""
              ? input.action.input.unit
              : product.unit,
          quantity:
            typeof input.action.input.quantity === "number"
              ? input.action.input.quantity
              : product.quantity,
          buyingPrice:
            typeof input.action.input.buyingPrice === "number"
              ? input.action.input.buyingPrice
              : product.buyingPrice,
          sellingPrice:
            typeof input.action.input.sellingPrice === "number"
              ? input.action.input.sellingPrice
              : product.sellingPrice
        },
        now: input.now
      });
    }

    case "product.stock_adjust": {
      const product = findRuntimeProductByName(
        deps,
        input.businessId,
        String(input.action.input.productName ?? "")
      );

      if (product === null) {
        throw new Cp2Error(
          404,
          "runtime_product_not_found",
          "The product selected by the context script was not found."
        );
      }

      return deps.adjustProductStock({
        sessionId: input.sessionId,
        businessId: input.businessId,
        productId: product.id,
        adjustment: {
          quantityAfter:
            typeof input.action.input.quantity === "number"
              ? input.action.input.quantity
              : product.quantity,
          reason: "Adjusted via agent chat"
        },
        now: input.now
      });
    }

    case "product.delete": {
      const product = findRuntimeProductByName(
        deps,
        input.businessId,
        String(input.action.input.productName ?? "")
      );

      if (product === null) {
        throw new Cp2Error(
          404,
          "runtime_product_not_found",
          "The product selected by the context script was not found."
        );
      }

      return deps.deleteProduct({
        sessionId: input.sessionId,
        businessId: input.businessId,
        productId: product.id,
        now: input.now
      });
    }

    case "product.field.add": {
      const schema = deps.getProductFieldSchema({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
      const label = String(input.action.input.fieldName ?? "").trim();
      const field: ProductFieldDefinition = {
        id:
          typeof input.action.input.fieldId === "string" &&
          input.action.input.fieldId.trim().length > 0
            ? input.action.input.fieldId.trim()
            : runtimeProductFieldId(label),
        label,
        inputType: isProductFieldInputType(input.action.input.inputType)
          ? input.action.input.inputType
          : "text",
        required: input.action.input.required === true
      };

      return deps.saveProductFieldSchema({
        sessionId: input.sessionId,
        businessId: input.businessId,
        fields: [...schema.fields, field],
        now: input.now
      });
    }

    case "product.field.remove": {
      const schema = deps.getProductFieldSchema({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
      const fieldName = normalizeRuntimeLookup(String(input.action.input.fieldName ?? ""));
      const remaining = schema.fields.filter(
        (field) =>
          normalizeRuntimeLookup(field.id) !== fieldName &&
          normalizeRuntimeLookup(field.label) !== fieldName
      );

      if (remaining.length === schema.fields.length) {
        throw new Cp2Error(
          404,
          "runtime_product_field_not_found",
          "The product field was not found."
        );
      }

      return deps.saveProductFieldSchema({
        sessionId: input.sessionId,
        businessId: input.businessId,
        fields: remaining,
        now: input.now
      });
    }

    case "customer.create":
      return deps.createCustomer({
        sessionId: input.sessionId,
        businessId: input.businessId,
        customer: {
          name: String(input.action.input.name ?? ""),
          phone: typeof input.action.input.phone === "string" ? input.action.input.phone : null,
          email: null,
          notes: null
        },
        now: input.now
      });

    case "customer.update": {
      const customer = findRuntimeCustomerByName(
        deps,
        input.businessId,
        String(input.action.input.customerName ?? "")
      );

      if (customer === null) {
        throw new Cp2Error(404, "runtime_customer_not_found", "The customer was not found.");
      }

      return deps.updateCustomer({
        sessionId: input.sessionId,
        businessId: input.businessId,
        customerId: customer.id,
        customer: {
          name: customer.name,
          phone:
            typeof input.action.input.phone === "string"
              ? input.action.input.phone
              : customer.phone,
          email: customer.email,
          notes: customer.notes
        },
        now: input.now
      });
    }

    case "supplier.create":
      return deps.createSupplier({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplier: {
          name: String(input.action.input.name ?? ""),
          phone: typeof input.action.input.phone === "string" ? input.action.input.phone : null,
          email: null,
          notes: null
        },
        now: input.now
      });

    case "supplier.update": {
      const supplier = findRuntimeSupplierByName(
        deps,
        input.businessId,
        String(input.action.input.supplierName ?? "")
      );

      if (supplier === null) {
        throw new Cp2Error(404, "runtime_supplier_not_found", "The supplier was not found.");
      }

      return deps.updateSupplier({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplierId: supplier.id,
        supplier: {
          name: supplier.name,
          phone:
            typeof input.action.input.phone === "string"
              ? input.action.input.phone
              : supplier.phone,
          email: supplier.email,
          notes: supplier.notes
        },
        now: input.now
      });
    }

    case "logistics.update_status": {
      const logisticsId = String(input.action.input.logisticsId ?? "");
      const status = String(input.action.input.status ?? "") as FulfillmentStatus;

      return deps.updateLogisticsStatus({
        sessionId: input.sessionId,
        businessId: input.businessId,
        logisticsId,
        status: { status },
        now: input.now
      });
    }

    case "invoice.draft":
      return deps.createInvoice({
        sessionId: input.sessionId,
        businessId: input.businessId,
        invoice: {
          customerId:
            typeof input.action.input.customerId === "string"
              ? input.action.input.customerId
              : null,
          customerName:
            typeof input.action.input.customerName === "string"
              ? input.action.input.customerName
              : null,
          taxRate: typeof input.action.input.taxRate === "number" ? input.action.input.taxRate : 0,
          items: runtimeInvoiceItems(input.action.input.items)
        },
        now: input.now
      });

    case "payment.record":
      return deps.recordPayment({
        sessionId: input.sessionId,
        businessId: input.businessId,
        payment: {
          invoiceId: String(input.action.input.invoiceId ?? ""),
          amount: Number(input.action.input.amount),
          method: String(input.action.input.method ?? "") as PaymentMethod,
          reference:
            typeof input.action.input.reference === "string" ? input.action.input.reference : null,
          note: typeof input.action.input.note === "string" ? input.action.input.note : null
        },
        now: input.now
      });

    case "receipt.scan":
    case "receipt.confirm":
    case "receipt.correct":
    case "receipt.cancel":
    case "receipt.review":
    case "receipt.list":
    case "receipt.lookup":
      return executeReceiptCapability(deps, input);

    case "unknown.clarify":
      return null;

    case "document_import.confirm": {
      const importJobId = String(input.action.input.importJobId ?? "");
      const job = deps.requireDocumentImport(input.businessId, importJobId);

      return job.target === "product"
        ? deps.confirmProductImport({
            sessionId: input.sessionId,
            businessId: input.businessId,
            importJobId,
            now: input.now
          })
        : deps.confirmSupplierImport({
            sessionId: input.sessionId,
            businessId: input.businessId,
            importJobId,
            now: input.now
          });
    }

    case "messaging.send":
      return await deps.sendChannelMessage({
        sessionId: input.sessionId,
        businessId: input.businessId,
        ...(typeof input.action.input.customerId === "string"
          ? { customerId: input.action.input.customerId }
          : {}),
        ...(typeof input.action.input.customerName === "string"
          ? { customerName: input.action.input.customerName }
          : {}),
        ...(typeof input.action.input.conversationId === "string"
          ? { conversationId: input.action.input.conversationId }
          : {}),
        ...(isChannelProvider(input.action.input.provider)
          ? { provider: input.action.input.provider }
          : {}),
        ...(typeof input.action.input.mailboxId === "string"
          ? { mailboxId: input.action.input.mailboxId }
          : {}),
        ...(typeof input.action.input.subject === "string"
          ? { subject: input.action.input.subject }
          : {}),
        ...(typeof input.action.input.replyToMessageId === "string"
          ? { replyToMessageId: input.action.input.replyToMessageId }
          : {}),
        ...(Array.isArray(input.action.input.attachments)
          ? {
              attachments: input.action.input.attachments.flatMap((attachment) => {
                if (attachment === null || typeof attachment !== "object") return [];
                const record = attachment as Record<string, unknown>;
                return record.resourceType === "invoice" && typeof record.resourceId === "string"
                  ? [
                      {
                        resourceType: "invoice" as const,
                        resourceId: record.resourceId
                      }
                    ]
                  : [];
              })
            }
          : {}),
        text: String(input.action.input.text ?? ""),
        idempotencyKey: `runtime-message:${input.action.id}`,
        now: input.now
      });

    case "workspace.deliver": {
      if (input.conversationId === undefined) {
        throw new Cp2Error(
          409,
          "CONVERSATION_UNAVAILABLE",
          "Workspace files can only be delivered from an active conversation."
        );
      }
      const additionalPaths = Array.isArray(input.action.input.additionalPaths)
        ? input.action.input.additionalPaths.filter(
            (path): path is string => typeof path === "string" && path.trim().length > 0
          )
        : [];
      return await deps.deliverWorkspaceFile({
        sessionId: input.sessionId,
        businessId: input.businessId,
        conversationId: input.conversationId,
        requestedPaths: [String(input.action.input.path ?? ""), ...additionalPaths],
        ...(input.workspaceFiles === undefined ? {} : { transferredFiles: input.workspaceFiles }),
        ...(typeof input.action.input.caption === "string"
          ? { caption: input.action.input.caption }
          : {}),
        toolCallId: input.action.id,
        now: input.now
      });
    }
  }
}
