import { describe, expect, it } from "vitest";
import {
  mcpSchemaForRuntimeTool,
  runtimeToolRegistry,
  type RuntimeToolName
} from "../packages/tool-core/src";

const allToolNames = Object.keys(runtimeToolRegistry) as RuntimeToolName[];

describe("runtime tool registry", () => {
  it("preserves the canonical registry order while composing domain modules", () => {
    expect(allToolNames).toEqual([
      "products.list",
      "invoices.list",
      "reports.summary",
      "notifications.list",
      "compliance.review",
      "network.route",
      "network.contacts.resolve",
      "network.identity.list",
      "network.identity.propose",
      "network.identity.confirm",
      "network.identity.reject",
      "network.identity.unlink",
      "network.identity.add",
      "commerce.search",
      "commerce.checkout",
      "product.create",
      "product.update",
      "product.delete",
      "product.stock_adjust",
      "product.field.add",
      "product.field.remove",
      "customer.create",
      "customer.update",
      "supplier.create",
      "supplier.update",
      "contacts.search",
      "supplier.contact.attach",
      "purchase.record",
      "purchase.price.change",
      "purchase.history",
      "sale.record",
      "sales.history",
      "route.record",
      "route.history",
      "procurement.submit",
      "procurement.respond",
      "procurement.quote.record",
      "procurement.prepare",
      "invoice.draft",
      "payments.debtors",
      "payment.record",
      "logistics.update_status",
      "receipt.scan",
      "receipt.review",
      "receipt.confirm",
      "receipt.correct",
      "receipt.cancel",
      "receipt.lookup",
      "receipt.list",
      "document_import.confirm",
      "messaging.send",
      "workspace.deliver",
      "computer.session.create",
      "computer.session.resume",
      "computer.navigate",
      "computer.observe",
      "computer.click",
      "computer.type",
      "computer.scroll",
      "computer.upload",
      "computer.control.take",
      "computer.control.release",
      "computer.checkpoint",
      "computer.suspend",
      "computer.close",
      "unknown.clarify"
    ]);
  });

  it("freezes risk, permission, confirmation, read-only, and MCP metadata", () => {
    expect(
      allToolNames.map((name) => {
        const definition = runtimeToolRegistry[name];
        return [
          name,
          definition.risk,
          definition.requiredPermission,
          definition.requiresConfirmation,
          definition.readOnly,
          definition.mcpExposable
        ];
      })
    ).toEqual([
      ["products.list", "low", "product:read", false, true, false],
      ["invoices.list", "low", "invoice:read", false, true, false],
      ["reports.summary", "low", "report:read", false, true, false],
      ["notifications.list", "low", "notification:read", false, true, false],
      ["compliance.review", "low", "compliance:read", false, true, false],
      ["network.route", "medium", "business:read", false, false, false],
      ["network.contacts.resolve", "low", "business:read", false, true, false],
      ["network.identity.list", "low", "business:read", false, true, false],
      ["network.identity.propose", "medium", "business:write", false, false, false],
      ["network.identity.confirm", "medium", "business:write", false, false, false],
      ["network.identity.reject", "low", "business:write", false, false, false],
      ["network.identity.unlink", "medium", "business:write", false, false, false],
      ["network.identity.add", "low", "business:write", false, false, false],
      ["commerce.search", "low", "business:read", false, true, false],
      ["commerce.checkout", "high", "business:read", true, false, false],
      ["product.create", "high", "product:write", false, false, false],
      ["product.update", "high", "product:write", true, false, false],
      ["product.delete", "critical", "product:write", true, false, false],
      ["product.stock_adjust", "high", "product:write", false, false, false],
      ["product.field.add", "medium", "product:write", true, false, false],
      ["product.field.remove", "high", "product:write", true, false, false],
      ["customer.create", "high", "customer:write", true, false, false],
      ["customer.update", "high", "customer:write", true, false, false],
      ["supplier.create", "high", "supplier:write", true, false, false],
      ["supplier.update", "high", "supplier:write", true, false, false],
      ["contacts.search", "low", "customer:read", false, true, false],
      ["supplier.contact.attach", "high", "supplier:write", true, false, false],
      ["purchase.record", "high", "import:write", true, false, false],
      ["purchase.price.change", "high", "product:write", true, false, false],
      ["purchase.history", "low", "import:read", false, true, false],
      ["sale.record", "high", "invoice:confirm", true, false, false],
      ["sales.history", "low", "invoice:read", false, true, false],
      ["route.record", "high", "logistics:write", true, false, false],
      ["route.history", "low", "logistics:read", false, true, false],
      ["procurement.submit", "high", "supplier:write", true, false, false],
      ["procurement.respond", "high", "supplier:write", true, false, false],
      ["procurement.quote.record", "high", "supplier:write", true, false, false],
      ["procurement.prepare", "medium", "import:write", false, false, false],
      ["invoice.draft", "high", "invoice:write", true, false, false],
      ["payments.debtors", "low", "payment:read", false, true, false],
      ["payment.record", "high", "payment:write", true, false, false],
      ["logistics.update_status", "high", "logistics:write", true, false, false],
      ["receipt.scan", "medium", "import:write", true, false, false],
      ["receipt.review", "low", "import:read", false, true, false],
      ["receipt.confirm", "high", "import:write", true, false, false],
      ["receipt.correct", "high", "import:write", true, false, false],
      ["receipt.cancel", "medium", "import:write", true, false, false],
      ["receipt.lookup", "low", "import:read", false, true, false],
      ["receipt.list", "low", "import:read", false, true, false],
      ["document_import.confirm", "high", "import:write", true, false, false],
      ["messaging.send", "high", "customer:write", true, false, false],
      ["workspace.deliver", "medium", "business:read", false, false, false],
      ["computer.session.create", "medium", "business:write", false, false, false],
      ["computer.session.resume", "medium", "business:write", false, false, false],
      ["computer.navigate", "medium", "business:write", false, true, false],
      ["computer.observe", "low", "business:write", false, true, false],
      ["computer.click", "high", "business:write", false, false, false],
      ["computer.type", "high", "business:write", false, false, false],
      ["computer.scroll", "low", "business:write", false, true, false],
      ["computer.upload", "high", "business:write", true, false, false],
      ["computer.control.take", "medium", "business:write", false, false, false],
      ["computer.control.release", "medium", "business:write", false, false, false],
      ["computer.checkpoint", "medium", "business:write", false, false, false],
      ["computer.suspend", "medium", "business:write", false, false, false],
      ["computer.close", "medium", "business:write", false, false, false],
      ["unknown.clarify", "low", "business:read", false, true, false]
    ]);
  });

  it("gives every tool a non-empty description usable for documentation and MCP exposure", () => {
    expect(allToolNames.length).toBeGreaterThan(0);
    for (const name of allToolNames) {
      const definition = runtimeToolRegistry[name];
      expect(definition.name).toBe(name);
      expect(definition.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("gives every tool a well-formed object input schema", () => {
    for (const name of allToolNames) {
      const schema = runtimeToolRegistry[name].inputSchema;
      expect(schema.type).toBe("object");
      expect(typeof schema.properties).toBe("object");
      for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        expect(["string", "number", "boolean", "array", "object"]).toContain(fieldSchema.type);
        expect(
          fieldSchema.description.trim().length,
          `${name}.${field} description`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("declares no tool MCP-exposable yet, matching the current MCP surface exactly", () => {
    // services/api/src/mcp/routes.ts does not call any of these RuntimeToolName tools directly -
    // it only exposes a separately curated read-only set plus the generic
    // grogoni.runtime_turn/grogoni.confirm_runtime_action pair, which route natural-language messages
    // through this same registry rather than naming a tool directly. If this test starts failing
    // because an entry flipped to true, that is a deliberate MCP-surface expansion that needs its
    // own review (adjusting mcp/routes.ts to actually call mcpSchemaForRuntimeTool for it), not an
    // accidental default.
    for (const name of allToolNames) {
      expect(runtimeToolRegistry[name].mcpExposable, name).toBe(false);
    }
  });

  it("never marks a read-only tool as requiring confirmation", () => {
    for (const name of allToolNames) {
      const definition = runtimeToolRegistry[name];
      if (definition.readOnly) {
        expect(definition.requiresConfirmation, name).toBe(false);
      }
    }
  });

  it("always requires confirmation for a critical-risk tool", () => {
    for (const name of allToolNames) {
      const definition = runtimeToolRegistry[name];
      if (definition.risk === "critical") {
        expect(definition.requiresConfirmation, name).toBe(true);
      }
    }
  });

  it("gives every tool a non-empty required permission", () => {
    for (const name of allToolNames) {
      expect(runtimeToolRegistry[name].requiredPermission.trim().length).toBeGreaterThan(0);
    }
  });

  it("adapts a canonical tool definition into a valid MCP tools/list entry shape", () => {
    const schema = mcpSchemaForRuntimeTool("product.create");
    expect(schema.name).toBe("grogoni.product.create");
    expect(schema.description).toBe(runtimeToolRegistry["product.create"].description);
    expect(schema.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["name", "unit"]),
      properties: {
        name: { type: "string" },
        unit: { type: "string" },
        quantity: { type: "number" }
      }
    });
    expect(schema.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
  });

  it("marks the MCP annotation destructiveHint only for critical-risk tools", () => {
    const critical = mcpSchemaForRuntimeTool("product.delete");
    expect(critical.annotations.destructiveHint).toBe(true);
    const readOnly = mcpSchemaForRuntimeTool("products.list");
    expect(readOnly.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it("omits a required array from the MCP schema when no field is required", () => {
    const schema = mcpSchemaForRuntimeTool("invoices.list");
    expect(schema.inputSchema).not.toHaveProperty("required");
  });
});
