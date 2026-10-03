import type { EventRiskLevel } from "@grogoni/event-core";

export interface ToolDefinition<TInput extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  risk: EventRiskLevel;
  requiresConfirmation: boolean;
  validate(input: TInput): ValidationResult;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function valid(): ValidationResult {
  return { ok: true, errors: [] };
}

export function invalid(...errors: string[]): ValidationResult {
  return { ok: false, errors };
}

export type RuleIntent =
  | "add_product"
  | "update_product"
  | "adjust_stock"
  | "add_customer"
  | "update_customer"
  | "add_supplier"
  | "update_supplier"
  | "create_invoice"
  | "record_payment"
  | "update_logistics"
  | "check_debt"
  | "show_products"
  | "show_invoices"
  | "show_reports"
  | "show_notifications"
  | "unknown";

export type ParserNextAction =
  | {
      type: "navigate";
      view: "products" | "invoices" | "payments" | "reports" | "notifications";
      reason: string;
    }
  | {
      type: "draft";
      reason: string;
    }
  | {
      type: "clarify";
      question: string;
      reason: string;
    };

export interface ParserSlots {
  amount?: number;
  customerName?: string;
  productName?: string;
  quantity?: number;
  unit?: string;
  supplierName?: string;
  phone?: string;
}

export interface ParseResult {
  confidence: number;
  intent: RuleIntent;
  nextAction: ParserNextAction;
  normalizedInput: string;
  slots: ParserSlots;
}

export type RuntimeToolRisk = "low" | "medium" | "high" | "critical";

export interface ToolExecutionContext {
  accountId: string;
  userId: string;
  businessId: string;
  runtimeSessionId: string;
  permissions: string[];
  idempotencyKey: string;
  confirmed: boolean;
}

export interface AgentTool<TInput extends Record<string, unknown>, TOutput> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredPermission: string;
  riskLevel: "read" | "write" | "destructive";
  execute(context: ToolExecutionContext, input: TInput): Promise<TOutput>;
}

export type RuntimeToolName =
  | "products.list"
  | "invoices.list"
  | "reports.summary"
  | "notifications.list"
  | "compliance.review"
  | "network.route"
  | "network.contacts.resolve"
  | "network.identity.list"
  | "network.identity.propose"
  | "network.identity.confirm"
  | "network.identity.reject"
  | "network.identity.unlink"
  | "network.identity.add"
  | "commerce.search"
  | "commerce.checkout"
  | "product.create"
  | "product.update"
  | "product.delete"
  | "product.stock_adjust"
  | "product.field.add"
  | "product.field.remove"
  | "customer.create"
  | "customer.update"
  | "supplier.create"
  | "supplier.update"
  | "contacts.search"
  | "supplier.contact.attach"
  | "purchase.record"
  | "purchase.price.change"
  | "purchase.history"
  | "sale.record"
  | "sales.history"
  | "route.record"
  | "route.history"
  | "invoice.draft"
  | "payments.debtors"
  | "payment.record"
  | "logistics.update_status"
  | "receipt.scan"
  | "receipt.review"
  | "receipt.confirm"
  | "receipt.correct"
  | "receipt.cancel"
  | "receipt.lookup"
  | "receipt.list"
  | "document_import.confirm"
  | "messaging.send"
  | "workspace.deliver"
  | "computer.session.create"
  | "computer.session.resume"
  | "computer.navigate"
  | "computer.observe"
  | "computer.click"
  | "computer.type"
  | "computer.scroll"
  | "computer.upload"
  | "computer.control.take"
  | "computer.control.release"
  | "computer.checkpoint"
  | "computer.suspend"
  | "computer.close"
  | "unknown.clarify";

/**
 * Deliberately a minimal, hand-rollable subset of JSON Schema - not a validation-library
 * dependency - so it can be handed directly to an MCP `inputSchema` field (see
 * services/api/src/mcp/routes.ts, which already writes plain objects in this exact shape) and so
 * mcpSchemaForRuntimeTool() below needs no translation step.
 */
export type RuntimeToolInputFieldType = "string" | "number" | "boolean" | "array" | "object";

export interface RuntimeToolInputFieldSchema {
  type: RuntimeToolInputFieldType;
  /**
   * Documentation/MCP metadata only. validateRuntimeToolInputShape() below deliberately does NOT
   * enforce this - each tool's proposal builder (createRuntimeToolProposal and friends) already
   * enforces required fields with a specific, situation-aware clarification question ("Which
   * product should I delete?") that is better UX than a generic schema error, and is exercised by
   * existing tests (see cp10RuntimeEvalCommands). Duplicating that check here in a second place
   * would risk the two disagreeing.
   */
  required?: boolean;
  description: string;
}

export interface RuntimeToolInputSchema {
  type: "object";
  properties: Record<string, RuntimeToolInputFieldSchema>;
}

/** Merchant-facing copy in every language the owner app ships (English and Swahili). */
export interface LocalizedText {
  en: string;
  sw: string;
}

/**
 * The Shop Hub modules a tool can surface under (registry/modules.ts owns their display
 * metadata). A module is the tile a merchant taps; a tool is one action inside it.
 */
export type ShopModuleId =
  | "catalog"
  | "suppliers"
  | "receipts"
  | "orders"
  | "customers"
  | "network"
  | "payments"
  | "delivery"
  | "channels"
  | "agent"
  | "insights";

export interface RuntimeToolHubMetadata {
  module: ShopModuleId;
  /** Short merchant-facing action name ("Add a product"); `description` stays model-facing. */
  label: LocalizedText;
}

export interface RuntimeToolDefinition {
  name: RuntimeToolName;
  description: string;
  /**
   * Where this tool appears in the Shop Hub (GET /businesses/:businessId/capabilities), or null
   * for agent-internal and buyer-side tools a merchant never operates directly. Required so every
   * newly registered tool makes that choice explicitly.
   */
  hub: RuntimeToolHubMetadata | null;
  risk: RuntimeToolRisk;
  requiresConfirmation: boolean;
  readOnly: boolean;
  requiredPermission: string;
  inputSchema: RuntimeToolInputSchema;
  /**
   * Whether this tool is safe to expose through the MCP surface as its own callable tool. Every
   * entry below is currently false: today's MCP surface (services/api/src/mcp/routes.ts) only
   * exposes a small, separately-curated set of read tools plus the generic
   * grogoni.runtime_turn/grogoni.confirm_runtime_action pair, which routes natural-language messages
   * through this exact same registry and createRuntimeTurn pipeline rather than calling any of
   * these tool names directly. This field exists so a future, deliberate decision to expose a
   * specific tool directly is a one-line, reviewable change instead of an accidental default.
   */
  mcpExposable: boolean;
}

export interface RuntimeToolProposal {
  toolName: RuntimeToolName;
  input: Record<string, unknown>;
  reason: string;
  validation: ValidationResult;
}

export type RuntimeModelOutputKind = "tool" | "clarification" | "response";

export interface ParsedRuntimeModelOutput {
  kind: RuntimeModelOutputKind;
  proposal: RuntimeToolProposal;
}

export interface RuntimeModelOutputParseResult {
  ok: boolean;
  output: ParsedRuntimeModelOutput | null;
  errors: string[];
}
