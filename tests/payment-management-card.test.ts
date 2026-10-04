import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const grogoni = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("payments chat-invokable capability (Phase 4e)", () => {
  it("registers a payment-management card in the generated-surface registry", () => {
    expect(registry).toContain('"payment-management": (content) => {');
    expect(registry).toContain("<PaymentManagementCard");
    // Lazy, and through the deploy-recovery loader (tests/lazy-module-recovery-coverage.test.ts).
    expect(grogoni).toMatch(
      /export const PaymentManagementCard = lazy\(\s*\(\) =>\s*loadLazyModuleWithRecovery\(\s*ownerModuleKeys\.paymentManagementCard,\s*\(\) =>\s*import\("\.\/PaymentManagementCard"\)/u
    );
  });

  it("carries the payment-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "payment-management"; businessId: string; customerName?: string }'
    );
    expect(validation).toContain('case "payment-management":');
  });

  it("opens the composer as soon as a message classifies as record_payment, not after a successful tool execution", () => {
    // Same shape as invoices: payment.record never executes via the runtime tool - a customer can
    // have several open invoices, so free text alone cannot say which one to pay down.
    expect(chatRuntime).toContain(
      'if (result.turn.plan.toolName === "payment.record" && business !== null) {'
    );
    expect(chatRuntime).toContain("async function postPaymentManagementCard(");
  });
});
