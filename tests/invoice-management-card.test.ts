import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const grogoni = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("invoices chat-invokable capability (Phase 4d)", () => {
  it("registers an invoice-management card in the generated-surface registry", () => {
    expect(registry).toContain('"invoice-management": (content) => {');
    expect(registry).toContain("<InvoiceManagementCard");
    expect(grogoni).toContain(
      'export const InvoiceManagementCard = lazy(() => import("./InvoiceManagementCard"));'
    );
  });

  it("carries the invoice-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "invoice-management"; businessId: string; customerName?: string }'
    );
    expect(validation).toContain('case "invoice-management":');
  });

  it("opens the composer as soon as a message classifies as create_invoice, not after a successful tool execution", () => {
    // Unlike products/suppliers/customers (which post their card only after executedAt !== null),
    // invoice.draft never executes via the runtime tool - free text cannot specify product,
    // quantity, and price reliably. The trigger here is unconditional on toolName alone.
    expect(chatRuntime).toContain(
      'if (result.turn.plan.toolName === "invoice.draft" && business !== null) {'
    );
    expect(chatRuntime).toContain("async function postInvoiceManagementCard(");
    expect(chatRuntime).toContain("const customerName = result.turn.plan.input.customerName;");
  });
});
