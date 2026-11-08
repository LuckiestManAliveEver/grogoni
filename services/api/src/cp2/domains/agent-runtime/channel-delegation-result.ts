import type {
  RuntimeChannelDelegation,
  RuntimePlannedAction,
  RuntimeToolName,
  RuntimeTurnSummary
} from "@grogoni/shared-types";
import type { AgentRuntimeDomainDeps } from "./domain-deps.js";

/**
 * How the shop owner resolved a write that an external channel participant (WhatsApp Linked
 * Devices) requested under a delegated tool grant. `failed` means the owner approved but execution
 * was blocked (for example the grant was revoked between proposal and approval).
 */
export type ChannelDelegationOutcome = "executed" | "failed" | "rejected";

export interface ChannelDelegationResolution {
  businessId: string;
  /** The originating delegated turn: the one that asked the owner for approval. */
  turnId: string;
  delegation: RuntimeChannelDelegation;
  toolName: RuntimeToolName;
  outcome: ChannelDelegationOutcome;
  /** The owner (or staff member) who approved or rejected. */
  resolvedBy: string;
}

/**
 * The proposal turn a pending action came from. A delegated turn is unique per
 * (business, source message, grant) because createRuntimeTurn deduplicates on exactly that key,
 * and the action id is carried unchanged from proposal to confirmation.
 */
export function originatingDelegatedTurn(
  turns: Iterable<RuntimeTurnSummary>,
  businessId: string,
  action: RuntimePlannedAction
): RuntimeTurnSummary | undefined {
  const delegation = action.channelDelegation;
  if (!delegation) return undefined;
  for (const turn of turns)
    if (
      turn.businessId === businessId &&
      turn.plan.id === action.id &&
      turn.sourceMessageId === delegation.sourceMessageId &&
      turn.plan.channelDelegation?.grantId === delegation.grantId &&
      turn.plan.channelDelegation.channelId === delegation.channelId
    )
      return turn;
  return undefined;
}

/**
 * Tell the originating channel how the owner resolved a delegated action. Never throws: the owner's
 * approval or rejection has already been committed, and a channel delivery problem must not turn a
 * successful owner action into an error response. Every non-delivery is audited instead.
 */
export async function reportChannelDelegationResolution(
  deps: Partial<
    Pick<AgentRuntimeDomainDeps, "deliverChannelDelegationResult" | "recordAuditEvent">
  >,
  turns: Iterable<RuntimeTurnSummary>,
  input: {
    businessId: string;
    action: RuntimePlannedAction;
    outcome: ChannelDelegationOutcome;
    resolvedBy: string;
    now: Date;
  }
): Promise<void> {
  const delegation = input.action.channelDelegation;
  if (!delegation || !deps.deliverChannelDelegationResult) return;
  const origin = originatingDelegatedTurn(turns, input.businessId, input.action);
  const audit = (reason: string, turnId: string) =>
    deps.recordAuditEvent?.({
      type: "runtime.channel_delegation_result_undelivered",
      aggregateType: "runtime_turn",
      aggregateId: turnId,
      actorId: input.resolvedBy,
      occurredAt: input.now.toISOString(),
      payload: {
        businessId: input.businessId,
        channelId: delegation.channelId,
        grantId: delegation.grantId,
        outcome: input.outcome,
        reason
      }
    });
  if (!origin) {
    audit("originating_turn_not_found", input.action.id);
    return;
  }
  try {
    await deps.deliverChannelDelegationResult({
      businessId: input.businessId,
      turnId: origin.id,
      delegation,
      toolName: input.action.toolName,
      outcome: input.outcome,
      resolvedBy: input.resolvedBy
    });
  } catch {
    audit("delivery_failed", origin.id);
  }
}

/** Confirmation path: the stored confirmation turn carries the approved plan and its outcome. */
export function reportConfirmedChannelDelegation(
  deps: Parameters<typeof reportChannelDelegationResolution>[0],
  turns: Iterable<RuntimeTurnSummary>,
  confirmed: RuntimeTurnSummary
): Promise<void> {
  return reportChannelDelegationResolution(deps, turns, {
    businessId: confirmed.businessId,
    action: confirmed.plan,
    outcome: confirmed.status === "completed" ? "executed" : "failed",
    resolvedBy: confirmed.actorId,
    now: new Date(confirmed.createdAt)
  });
}
