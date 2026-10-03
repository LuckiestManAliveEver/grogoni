import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const grogoni = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("imports chat-invokable capability (Phase 4f)", () => {
  it("registers an import-management card in the generated-surface registry", () => {
    expect(registry).toContain('"import-management": (content) => {');
    expect(registry).toContain("<ImportManagementCard");
    expect(grogoni).toContain(
      'export const ImportManagementCard = lazy(() => import("./ImportManagementCard"));'
    );
  });

  it("carries the import-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "import-management"; businessId: string; importJobId?: string }'
    );
    expect(validation).toContain('case "import-management":');
  });

  it("opens the review card for document_import.confirm, which already resolves and executes from chat unlike the other domains", () => {
    expect(chatRuntime).toContain(
      'if (result.turn.plan.toolName === "document_import.confirm" && business !== null) {'
    );
    expect(chatRuntime).toContain("async function postImportManagementCard(");
    expect(chatRuntime).toContain("const importJobId = result.turn.plan.input.importJobId;");
  });
});
