import type { RuntimeSessionSummary, RuntimeTurnSummary } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import type { AgentRuntimeDomainDeps } from "./domain-deps.js";
import type { PendingRuntimeAction } from "./shared.js";
import { reportChannelDelegationResolution } from "./channel-delegation-result.js";

export interface RuntimeApprovalRejection {
  sessionId: string | null;
  businessId: string;
  runtimeSessionId: string;
  conversationId?: string;
  confirmationToken: string;
  now?: Date;
}

export async function rejectRuntimeApproval(
  deps: Pick<AgentRuntimeDomainDeps, "requireAuthorizedSession" | "runtimeApprovalStore"> &
    Partial<Pick<AgentRuntimeDomainDeps, "deliverChannelDelegationResult" | "recordAuditEvent">>,
  sessions: Map<string, RuntimeSessionSummary>,
  pending: Map<string, PendingRuntimeAction>,
  input: RuntimeApprovalRejection,
  turns: Iterable<RuntimeTurnSummary> = []
): Promise<{ status: "REJECTED" }> {
  const now = input.now ?? new Date();
  const actor = deps.requireAuthorizedSession(
    input.sessionId,
    input.businessId,
    "business:read",
    now
  );
  const session = sessions.get(input.runtimeSessionId);
  const unavailable = () =>
    new Cp2Error(
      404,
      "runtime_confirmation_not_found",
      "Runtime confirmation was not found or is no longer available."
    );
  if (
    !session ||
    session.businessId !== input.businessId ||
    session.userId !== actor.user.id ||
    !Number.isFinite(now.getTime()) ||
    input.confirmationToken.length > 200
  )
    throw unavailable();
  let action: PendingRuntimeAction["action"];
  if (deps.runtimeApprovalStore) {
    action = await deps.runtimeApprovalStore.reject({
      token: input.confirmationToken,
      businessId: input.businessId,
      actorId: actor.user.id,
      runtimeSessionId: session.id,
      conversationId: input.conversationId ?? null,
      now
    });
  } else {
    const proposal = pending.get(input.confirmationToken);
    if (
      !proposal ||
      proposal.businessId !== input.businessId ||
      proposal.actorId !== actor.user.id ||
      proposal.sessionId !== session.id ||
      proposal.conversationId !== (input.conversationId ?? null) ||
      Date.parse(proposal.expiresAt) <= now.getTime()
    )
      throw unavailable();
    pending.delete(input.confirmationToken);
    action = proposal.action;
  }
  // The rejection is committed above, so a single rejection reports at most once.
  await reportChannelDelegationResolution(deps, turns, {
    businessId: input.businessId,
    action,
    outcome: "rejected",
    resolvedBy: actor.user.id,
    now
  });
  return { status: "REJECTED" };
}
