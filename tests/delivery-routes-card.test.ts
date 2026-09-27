import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const card = readFileSync("apps/web/src/DeliveryRoutesCard.tsx", "utf8");
const logisticsSurface = readFileSync("apps/web/src/LogisticsSurface.tsx", "utf8");
const ownerWorkspace = readFileSync("apps/web/src/OwnerWorkspace.tsx", "utf8");
const routes = readFileSync("services/api/src/cp2/domains/commercial-records/routes.ts", "utf8");

describe("delivery routes card (permanent surface, no chat wiring)", () => {
  it("is a self-contained card that fetches and mutates its own data from businessId alone", () => {
    expect(card).toContain(
      "export default function DeliveryRoutesCard(props: { businessId: string })"
    );
    expect(card).toContain('import { getJson, patchJson, postJson } from "./api-helpers"');
    expect(card).toContain('import { useAsyncActions } from "./hooks/useAsyncActions"');
    expect(card).toContain(
      'import { useApiMutationRevision } from "./hooks/useApiMutationRevision"'
    );
    expect(card).toContain('import { getUserFacingErrorMessage } from "./user-facing-error"');
  });

  it("wires the exact provider-neutral route endpoints the backend exposes", () => {
    expect(card).toContain("const routesPath = `/businesses/${props.businessId}/routes`");
    expect(card).toContain("postJson<DeliveryRouteSummary>(routesPath");
    expect(card).toContain("patchJson<DeliveryRouteSummary>(`${routesPath}/${route.id}`");
    expect(card).toContain("getJson<DeliveryRouteSummary[]>(`${routesPath}/history`)");

    expect(routes).toContain('"/businesses/:businessId/routes"');
    expect(routes).toContain('"/businesses/:businessId/routes/:routeId"');
    expect(routes).toContain('"/businesses/:businessId/routes/history"');
  });

  it("imports the shipped DeliveryRouteSummary/DeliveryRouteStatus types instead of redefining them", () => {
    expect(card).toContain(
      'import type { DeliveryRouteStatus, DeliveryRouteSummary } from "@soko/shared-types"'
    );
  });

  it("is mounted permanently inside the logistics ShellView (LogisticsSurface), not a chat-invoked card", () => {
    expect(logisticsSurface).toContain('import DeliveryRoutesCard from "./DeliveryRoutesCard"');
    expect(logisticsSurface).toContain("<DeliveryRoutesCard businessId={props.businessId} />");
    expect(logisticsSurface).toContain("businessId: string;");
  });

  it("receives businessId from OwnerWorkspace's logistics case, the only change made there", () => {
    expect(ownerWorkspace).toContain(
      "<Screens.LogisticsSurface\n          businessId={businessId}"
    );
  });

  it("does not add any new chat/NLU capability wiring for delivery routes", () => {
    const registry = readFileSync("apps/web/src/generated-surface-registry.tsx", "utf8");
    const chatRuntime = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
    expect(registry).not.toContain("DeliveryRoutesCard");
    expect(chatRuntime).not.toContain("DeliveryRoutesCard");
    expect(chatRuntime).not.toContain("route.record");
    expect(chatRuntime).not.toContain("route.history");
  });
});
