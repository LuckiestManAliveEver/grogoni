import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const grogoni = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("suppliers chat-invokable capability (Phase 4b)", () => {
  it("registers a supplier-management card in the generated-surface registry", () => {
    expect(registry).toContain('"supplier-management": (content) => {');
    expect(registry).toContain("<SupplierManagementCard");
    // Lazy, and through the deploy-recovery loader (tests/lazy-module-recovery-coverage.test.ts).
    expect(grogoni).toMatch(
      /export const SupplierManagementCard = lazy\(\s*\(\) =>\s*loadLazyModuleWithRecovery\(\s*ownerModuleKeys\.supplierManagementCard,\s*\(\) =>\s*import\("\.\/SupplierManagementCard"\)/u
    );
  });

  it("carries the supplier-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "supplier-management"; businessId: string; supplierId?: string }'
    );
    expect(validation).toContain('case "supplier-management":');
  });

  it("posts the suppliers card into the owner's own conversation after a successful supplier tool run", () => {
    expect(chatRuntime).toContain(
      "const supplierMutationToolNames: ReadonlySet<string> = new Set<RuntimeToolName>(["
    );
    expect(chatRuntime).toContain('"supplier.create"');
    expect(chatRuntime).toContain('"supplier.update"');
    expect(chatRuntime).toContain(
      "supplierMutationToolNames.has(result.turn.plan.toolName) &&\n        result.turn.plan.executedAt !== null"
    );
    expect(chatRuntime).toContain("async function postSupplierManagementCard(");
  });
});
