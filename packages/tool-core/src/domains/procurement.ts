import type { RuntimeToolDefinition, RuntimeToolName } from "../contracts/runtime.js";

export const procurementRuntimeTools = {
  "procurement.quote.record": {
    name: "procurement.quote.record",
    hub: {
      module: "suppliers",
      label: { en: "Record supplier quote", sw: "Rekodi bei ya msambazaji" }
    },
    description:
      "Record an immutable owner-entered supplier offer. This is not supplier acknowledgement or an order.",
    risk: "high",
    requiresConfirmation: true,
    readOnly: false,
    requiredPermission: "supplier:write",
    mcpExposable: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", required: true, description: "Stable quote identifier." },
        productId: {
          type: "string",
          required: true,
          description: "Canonical business product ID."
        },
        supplierId: {
          type: "string",
          required: true,
          description: "Canonical business supplier ID."
        },
        currency: { type: "string", required: true, description: "Three-letter ISO currency." },
        unit: {
          type: "string",
          required: true,
          description: "Exact canonical product quantity unit approved with this offer."
        },
        unitPriceMinor: {
          type: "number",
          required: true,
          description: "Positive integer price per unit in minor currency units."
        },
        priceIncludesCharges: {
          type: "boolean",
          required: true,
          description:
            "Must explicitly be true: the quoted unit price includes tax, delivery and all other charges."
        },
        minQuantityMilli: {
          type: "number",
          required: true,
          description: "Positive minimum order quantity in thousandths."
        },
        incrementMilli: {
          type: "number",
          required: true,
          description: "Positive order increment in thousandths."
        },
        availableQuantityMilli: {
          type: "number",
          required: true,
          description: "Nonnegative available quantity in thousandths."
        },
        leadTimeDays: {
          type: "number",
          required: true,
          description: "Integer delivery lead time, zero to 365 days."
        },
        expiresAt: { type: "string", required: true, description: "Quote expiry timestamp." }
      }
    }
  },
  "procurement.prepare": {
    name: "procurement.prepare",
    hub: {
      module: "suppliers",
      label: { en: "Prepare replenishment drafts", sw: "Andaa rasimu za ununuzi" }
    },
    description:
      "Prepare durable purchase drafts for an existing authorized environment task using committed inventory, sales and quotes. Never submits orders or increases stock.",
    risk: "medium",
    requiresConfirmation: false,
    readOnly: false,
    requiredPermission: "import:write",
    mcpExposable: false,
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          required: true,
          description: "Existing authorized business environment task ID."
        }
      }
    }
  }
} satisfies Partial<Record<RuntimeToolName, RuntimeToolDefinition>>;
