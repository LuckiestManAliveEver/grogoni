import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const grogoni = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("products chat-invokable capability (Phase 4a)", () => {
  it("registers a product-management card in the generated-surface registry", () => {
    expect(registry).toContain('"product-management": (content) => {');
    expect(registry).toContain("<ProductManagementCard");
    // Lazy, and through the deploy-recovery loader (tests/lazy-module-recovery-coverage.test.ts).
    expect(grogoni).toMatch(
      /export const ProductManagementCard = lazy\(\s*\(\) =>\s*loadLazyModuleWithRecovery\(\s*ownerModuleKeys\.productManagementCard,\s*\(\) =>\s*import\("\.\/ProductManagementCard"\)/u
    );
  });

  it("carries the product-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "product-management"; businessId: string; productId?: string }'
    );
    expect(validation).toContain('case "product-management":');
  });

  it("posts the products card into the owner's own conversation after a successful product tool run", () => {
    expect(chatRuntime).toContain(
      "const productMutationToolNames: ReadonlySet<string> = new Set<RuntimeToolName>(["
    );
    expect(chatRuntime).toContain('"product.create"');
    expect(chatRuntime).toContain('"product.update"');
    expect(chatRuntime).toContain('"product.stock_adjust"');
    expect(chatRuntime).toContain(
      "productMutationToolNames.has(result.turn.plan.toolName) &&\n        result.turn.plan.executedAt !== null"
    );
    expect(chatRuntime).toContain("async function postProductManagementCard(");
  });
});
