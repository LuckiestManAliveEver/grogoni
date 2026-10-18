import type {
  RuntimeReportCard,
  RuntimeReportCardKey,
  RuntimeTurnSummary
} from "@grogoni/shared-types";
import { runtimeExecutedModelId, runtimeModelEvidence } from "./runtime-model-evidence.js";

/**
 * MUSE-adoption brief §16/§17: groups already-recorded runtime turns by the actual
 * (model, context recipe, runtime version) configuration that answered them, and computes the
 * comparable metrics the brief asks for - task success, grounded acceptance, abstention, tool-call
 * rate, latency, and token usage. Pure and read-only: it does not persist anything, gate a
 * promotion, or duplicate the Model Template flywheel's offline evaluate/gate/promote pipeline
 * (`services/api/src/cp2/domains/model-templates/store.ts`) - see
 * docs/architecture/runtime-evaluation.md.
 */
export function buildRuntimeReportCard(turns: RuntimeTurnSummary[]): RuntimeReportCard[] {
  const groups = new Map<string, { key: RuntimeReportCardKey; turns: RuntimeTurnSummary[] }>();
  for (const turn of turns) {
    const modelId = runtimeExecutedModelId(turn);
    const recipeId = recipeIdForTurn(turn);
    const key: RuntimeReportCardKey = { runtimeVersion: turn.runtimeVersion, modelId, recipeId };
    const groupKey = `${key.runtimeVersion}:${key.modelId ?? "none"}:${key.recipeId ?? "none"}`;
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, { key, turns: [turn] });
    } else {
      group.turns.push(turn);
    }
  }
  return [...groups.values()]
    .map(({ key, turns: groupTurns }) => reportCardForGroup(key, groupTurns))
    .sort(
      (left, right) =>
        right.key.runtimeVersion - left.key.runtimeVersion ||
        (left.key.modelId ?? "").localeCompare(right.key.modelId ?? "") ||
        (left.key.recipeId ?? "").localeCompare(right.key.recipeId ?? "")
    );
}

function recipeIdForTurn(turn: RuntimeTurnSummary): string | null {
  const event = turn.telemetry.find(
    (candidate) =>
      candidate.state === "grounding.accepted" || candidate.state === "grounding.rejected"
  );
  const recipeId = event?.metadata.recipeId;
  return typeof recipeId === "string" ? recipeId : null;
}

function reportCardForGroup(
  key: RuntimeReportCardKey,
  turns: RuntimeTurnSummary[]
): RuntimeReportCard {
  const sampleSize = turns.length;
  const successCount = turns.filter((turn) => turn.status === "completed").length;
  const abstentionCount = turns.filter(
    (turn) => turn.status === "clarifying" || turn.status === "blocked"
  ).length;

  const groundingEvents = turns.flatMap((turn) =>
    turn.telemetry.filter(
      (event) => event.state === "grounding.accepted" || event.state === "grounding.rejected"
    )
  );
  const groundedAcceptRate =
    groundingEvents.length === 0
      ? null
      : groundingEvents.filter((event) => event.state === "grounding.accepted").length /
        groundingEvents.length;

  const toolCallCount = turns.filter((turn) =>
    turn.telemetry.some((event) => event.state === "tool.executed")
  ).length;

  const latencies = turns
    .map((turn) => runtimeModelEvidence(turn)?.durationMs)
    .filter((value): value is number => typeof value === "number");
  const promptTokens = turns
    .map((turn) => runtimeModelEvidence(turn)?.promptTokens)
    .filter((value): value is number => typeof value === "number");
  const completionTokens = turns
    .map((turn) => runtimeModelEvidence(turn)?.completionTokens)
    .filter((value): value is number => typeof value === "number");
  const contextTokens = turns
    .flatMap((turn) => turn.telemetry.filter((event) => event.state === "context.plan.completed"))
    .map((event) => event.metadata.estimatedTokens)
    .filter((value): value is number => typeof value === "number");

  return {
    key,
    sampleSize,
    taskSuccessRate: sampleSize === 0 ? 0 : successCount / sampleSize,
    abstentionRate: sampleSize === 0 ? 0 : abstentionCount / sampleSize,
    groundedAcceptRate,
    toolCallRate: sampleSize === 0 ? 0 : toolCallCount / sampleSize,
    averageLatencyMs: average(latencies),
    averagePromptTokens: average(promptTokens),
    averageCompletionTokens: average(completionTokens),
    averageContextTokens: average(contextTokens)
  };
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
