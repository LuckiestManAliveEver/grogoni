import { runtimeToolRegistry } from "../registry/index.js";
import {
  invalid,
  valid,
  type ParseResult,
  type RuntimeToolName,
  type RuntimeToolProposal
} from "../contracts/runtime.js";

export function mcpSchemaForRuntimeTool(toolName: RuntimeToolName): {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
} {
  const definition = runtimeToolRegistry[toolName];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [field, fieldSchema] of Object.entries(definition.inputSchema.properties)) {
    properties[field] = { type: fieldSchema.type, description: fieldSchema.description };
    if (fieldSchema.required) required.push(field);
  }
  return {
    name: `grogoni.${definition.name}`,
    description: definition.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      ...(required.length > 0 ? { required } : {}),
      properties
    },
    annotations: {
      readOnlyHint: definition.readOnly,
      destructiveHint: definition.risk === "critical"
    }
  };
}

// Model prompt-shaping (output-format instructions + worked few-shot examples) lives in
// ./runtime-proposal-prompting.js, re-exported below - a distinct concern from turning an already
// -parsed intent into a tool proposal, which is what the rest of this file does.
export {
  renderRuntimeModelFewShotExamples,
  renderRuntimeModelOutputInstructions
} from "./runtime-proposal-prompting.js";

export function createRuntimeToolProposal(result: ParseResult): RuntimeToolProposal {
  switch (result.intent) {
    case "show_products":
      return {
        toolName: "products.list",
        input: {},
        reason: "List products for the active business.",
        validation: valid()
      };

    case "show_invoices":
      return {
        toolName: "invoices.list",
        input: {},
        reason: "List invoices for the active business.",
        validation: valid()
      };

    case "show_reports":
      return {
        toolName: "reports.summary",
        input: {},
        reason: "Get the report summary for the active business.",
        validation: valid()
      };

    case "show_notifications":
      return {
        toolName: "notifications.list",
        input: {},
        reason: "List notifications for the active business.",
        validation: valid()
      };

    case "add_product":
      return {
        toolName: "product.create",
        input: {
          name: result.slots.productName ?? "",
          unit: result.slots.unit ?? "unit",
          quantity: result.slots.quantity ?? 0,
          sellingPrice: result.slots.amount ?? null
        },
        reason: "Draft a product creation action from the merchant command.",
        validation:
          result.slots.productName === undefined
            ? invalid("Product name is required before a product can be drafted.")
            : valid()
      };

    case "update_product":
      return {
        toolName: "product.update",
        input: {
          productName: result.slots.productName ?? "",
          ...(result.slots.unit === undefined ? {} : { unit: result.slots.unit }),
          ...(result.slots.quantity === undefined ? {} : { quantity: result.slots.quantity }),
          ...(result.slots.amount === undefined ? {} : { sellingPrice: result.slots.amount })
        },
        reason: "Draft a product update action from the merchant command.",
        validation:
          result.slots.productName === undefined ? invalid("Which product should I edit?") : valid()
      };

    case "adjust_stock":
      return {
        toolName: "product.stock_adjust",
        input: {
          productName: result.slots.productName ?? "",
          quantity: result.slots.quantity ?? 0
        },
        reason: "Draft a stock adjustment action from the merchant command.",
        validation:
          result.slots.productName === undefined
            ? invalid("Which product stock should I adjust?")
            : result.slots.quantity === undefined
              ? invalid("What should the new quantity be?")
              : valid()
      };

    case "add_customer":
      return {
        toolName: "customer.create",
        input: {
          name: result.slots.customerName ?? "",
          ...(result.slots.phone === undefined ? {} : { phone: result.slots.phone })
        },
        reason: "Draft a customer creation action from the merchant command.",
        validation:
          result.slots.customerName === undefined
            ? invalid("Customer name is required before a customer can be drafted.")
            : valid()
      };

    case "update_customer":
      return {
        toolName: "customer.update",
        input: {
          customerName: result.slots.customerName ?? "",
          ...(result.slots.phone === undefined ? {} : { phone: result.slots.phone })
        },
        reason: "Draft a customer update action from the merchant command.",
        validation:
          result.slots.customerName === undefined
            ? invalid("Which customer should I edit?")
            : result.slots.phone === undefined
              ? invalid("What should the new phone number be?")
              : valid()
      };

    case "add_supplier":
      return {
        toolName: "supplier.create",
        input: {
          name: result.slots.supplierName ?? "",
          ...(result.slots.phone === undefined ? {} : { phone: result.slots.phone })
        },
        reason: "Draft a supplier creation action from the merchant command.",
        validation:
          result.slots.supplierName === undefined
            ? invalid("Supplier name is required before a supplier can be drafted.")
            : valid()
      };

    case "update_supplier":
      return {
        toolName: "supplier.update",
        input: {
          supplierName: result.slots.supplierName ?? "",
          ...(result.slots.phone === undefined ? {} : { phone: result.slots.phone })
        },
        reason: "Draft a supplier update action from the merchant command.",
        validation:
          result.slots.supplierName === undefined
            ? invalid("Which supplier should I edit?")
            : result.slots.phone === undefined
              ? invalid("What should the new phone number be?")
              : valid()
      };

    case "create_invoice":
      return {
        toolName: "invoice.draft",
        input: {
          customerName: result.slots.customerName ?? null,
          quantity: result.slots.quantity ?? null
        },
        reason: "Draft an invoice action from the merchant command.",
        validation: invalid("Invoice runtime draft needs product and price details.")
      };

    case "record_payment":
      return {
        toolName: "payment.record",
        input: {
          amount: result.slots.amount ?? null,
          customerName: result.slots.customerName ?? null
        },
        reason: "Draft a payment recording action from the merchant command.",
        validation: invalid("Payment runtime draft needs an invoice id and method.")
      };

    case "update_logistics":
      return {
        toolName: "logistics.update_status",
        input: {
          customerName: result.slots.customerName ?? null
        },
        reason: "Draft a logistics status update from the merchant command.",
        validation: invalid("Logistics runtime draft needs which delivery and the new status.")
      };

    case "check_debt":
      return {
        toolName: "payments.debtors",
        input: {},
        reason: "List canonical customer debt balances for the active business.",
        validation: valid()
      };

    case "unknown":
      return {
        toolName: "unknown.clarify",
        input: {},
        reason:
          result.nextAction.type === "clarify" ? result.nextAction.reason : "Clarify request.",
        validation: invalid(
          result.nextAction.type === "clarify"
            ? result.nextAction.question
            : "I need more details before I can plan that action."
        )
      };
  }
}
