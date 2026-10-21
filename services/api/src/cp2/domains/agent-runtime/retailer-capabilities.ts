import type { RuntimePlannedAction } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import type { AgentRuntimeDomainDeps } from "./store.js";

export async function openRetailerWebsite(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    conversationId?: string;
    action: RuntimePlannedAction;
    now: Date;
  }
): Promise<unknown> {
  if (!deps.executeComputerCapability) {
    throw new Cp2Error(
      503,
      "computer_runtime_provider_unconfigured",
      "Connect a browser runtime to open retailer websites."
    );
  }
  const url = new URL(String(input.action.input.url));
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Cp2Error(
      400,
      "external_website_url_invalid",
      "Use an HTTPS retailer URL without credentials."
    );
  }
  const execute = (toolName: RuntimePlannedAction["toolName"], values: Record<string, unknown>) =>
    deps.executeComputerCapability!({
      sessionId: input.sessionId,
      businessId: input.businessId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      action: { ...input.action, toolName, input: values },
      now: input.now
    });
  let browserSessionId = input.action.input.sessionId;
  if (typeof browserSessionId !== "string" || !browserSessionId) {
    const session = (await execute("computer.session.create", {
      externalSurfaceId: url.origin,
      externalSurfaceType: "web",
      externalSurfaceProvider: url.hostname
    })) as { id: string };
    browserSessionId = session.id;
  }
  const observation = await execute("computer.navigate", {
    sessionId: browserSessionId,
    url: url.href,
    semanticIntent: "Inspect retailer products and prepare a checkout without payment."
  });
  return {
    sessionId: browserSessionId,
    websiteUrl: url.href,
    observation,
    paymentProcessed: false
  };
}
