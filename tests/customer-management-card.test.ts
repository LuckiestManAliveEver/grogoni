import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const soko = readFileSync("apps/web/src/soko-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("customers chat-invokable capability (Phase 4c)", () => {
  it("registers a customer-management card in the generated-surface registry", () => {
    expect(registry).toContain('"customer-management": (content) => {');
    expect(registry).toContain("<CustomerManagementCard");
    // Lazy, and through the deploy-recovery loader (tests/lazy-module-recovery-coverage.test.ts).
    expect(soko).toMatch(
      /export const CustomerManagementCard = lazy\(\s*\(\) =>\s*loadLazyModuleWithRecovery\(\s*ownerModuleKeys\.customerManagementCard,\s*\(\) =>\s*import\("\.\/CustomerManagementCard"\)/u
    );
  });

  it("carries the customer-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "customer-management"; businessId: string; customerId?: string }'
    );
    expect(validation).toContain('case "customer-management":');
  });

  it("posts the customers card into the owner's own conversation after a successful customer tool run", () => {
    expect(chatRuntime).toContain(
      "const customerMutationToolNames: ReadonlySet<string> = new Set<RuntimeToolName>(["
    );
    expect(chatRuntime).toContain('"customer.create"');
    expect(chatRuntime).toContain('"customer.update"');
    expect(chatRuntime).toContain(
      "customerMutationToolNames.has(result.turn.plan.toolName) &&\n        result.turn.plan.executedAt !== null"
    );
    expect(chatRuntime).toContain("async function postCustomerManagementCard(");
  });
});
