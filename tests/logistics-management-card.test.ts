import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
const grogoni = readFileSync("apps/web/src/grogoni-application-shared.ts", "utf8");
const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
const sharedTypes = readFileSync("packages/shared-types/src/index.ts", "utf8");
const validation = readFileSync("services/api/src/cp2/domains/messaging/shared.ts", "utf8");

describe("logistics chat-invokable capability (Phase 4h)", () => {
  it("registers a logistics-management card in the generated-surface registry", () => {
    expect(registry).toContain('"logistics-management": (content) => {');
    expect(registry).toContain("<LogisticsManagementCard");
    expect(grogoni).toContain(
      'export const LogisticsManagementCard = lazy(() => import("./LogisticsManagementCard"));'
    );
  });

  it("carries the logistics-management variant in the typed message-content union, validated server-side", () => {
    expect(sharedTypes).toContain(
      '{ type: "logistics-management"; businessId: string; customerName?: string }'
    );
    expect(validation).toContain('case "logistics-management":');
  });

  it("opens the composer as soon as a message classifies as update_logistics, not after a successful tool execution", () => {
    // Same shape as payments: logistics.update_status never executes via the runtime tool - a
    // customer can have several open deliveries, so free text alone cannot say which one, or the
    // new status, to apply.
    expect(chatRuntime).toContain(
      'if (result.turn.plan.toolName === "logistics.update_status" && business !== null) {'
    );
    expect(chatRuntime).toContain("async function postLogisticsManagementCard(");
  });
});
