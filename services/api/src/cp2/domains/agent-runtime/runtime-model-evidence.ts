import type { RuntimeTurnSummary } from "@grogoni/shared-types";

export function runtimeModelEvidence(turn: RuntimeTurnSummary): RuntimeTurnSummary["model"] {
  const planned = turn.telemetry?.some(
    (event) => event.state === "intent.routed" && event.metadata.source === "business_task"
  );
  return planned ? null : (turn.model ?? null);
}

export function runtimeExecutedModelId(turn: RuntimeTurnSummary): string | null {
  const model = runtimeModelEvidence(turn);
  return model?.modelId ?? model?.providerModelId ?? null;
}
