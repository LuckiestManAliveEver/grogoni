# Runtime evaluation / report card

## Existing systems this does not duplicate

Two real evaluation systems already existed before this change:

1. **Per-turn telemetry**: `AgentEvaluationEvent`/`AgentEvaluationSummary`
   (`docs/agent-evaluation-feedback-loop.md`) - outcome, score, latency, corrections, satisfaction,
   per turn.
2. **The Model Template flywheel's report card**: `TemplateReportCard`/`getReportCard`
   (`services/api/src/cp2/domains/model-templates/store.ts`,
   `docs/architecture/model-template-flywheel.md`) - a genuine evaluate → gate → promote pipeline
   with versioned lineage, but scoped to comparing **Model Template versions** in an offline
   evaluation run.

Neither compares the brief's `P = f(M, C, T, R)` at the granularity of _live runtime turns as they
actually executed_ - which model, which context recipe, which runtime version actually answered a
given group of turns. That is the one narrow gap this change closes, without building a second
evaluate/gate/promote pipeline (explicitly out of scope per brief §16: "do NOT implement autonomous
production prompt mutation yet").

## What was added

`buildRuntimeReportCard` (`services/api/src/cp2/domains/agent-runtime/report-card.ts`) is a **pure,
read-only aggregation** over already-recorded `RuntimeTurnSummary` data - no new persistence, no new
telemetry beyond what this change already added for other reasons (`context.plan.completed`,
`grounding.accepted`/`.rejected`):

```ts
interface RuntimeReportCardKey {
  runtimeVersion: number;
  modelId: string | null; // turn.model.modelId, or null for a fully deterministic turn
  recipeId: string | null; // from the turn's own grounding telemetry, or null if none matched
}

interface RuntimeReportCard {
  key: RuntimeReportCardKey;
  sampleSize: number;
  taskSuccessRate: number;
  abstentionRate: number; // clarifying + blocked / sampleSize
  groundedAcceptRate: number | null; // null if this group had no grounding-policy recipe
  toolCallRate: number;
  averageLatencyMs: number | null;
  averagePromptTokens: number | null;
  averageCompletionTokens: number | null;
  averageContextTokens: number | null;
}
```

Turns are grouped by the literal `(runtimeVersion, modelId, recipeId)` tuple their own telemetry
already recorded, so `M + C + T + R` combinations that actually ran can be compared without
re-instrumenting anything.

Model attribution comes from the turn's execution trace, never the shop's configured model.
Parser-only turns therefore have a null model ID. Server-planned business-task steps also have
null model attribution and null model latency/token usage, including historical records with
configuration metadata attached. These deterministic samples are not model benchmarks.
The existing evaluation-event pipeline uses the same attribution rule.

The historical `taskSuccessRate` field measures completed runtime turns, not independently
verified multi-step business outcomes. It must not be interpreted as evidence of supplier
delivery, prevented stockouts, or any other delayed business reward.

## Access

`Cp2Store.runtimeReportCard({ sessionId, businessId })` (session-authorized, `business:read`, same
pattern as `getAgentEvaluationSummary`), exposed read-only at
`GET /businesses/:businessId/agent-runtime/report-card`.

## What this intentionally does not do

- **No gating or promotion.** This is a read; nothing here decides a configuration is "better" or
  changes what runs next. That judgment, and any automated response to it, belongs to a future,
  separately-scoped change built on top of this data - matching the brief's own instruction not to
  build autonomous recipe mutation in this pass.
- **No new dataset/benchmark.** The report card summarizes real production traffic, not a curated
  eval set - the nightly LLM-judged eval (`services/api/scripts/run-ai-eval.ts`) and the Model
  Template flywheel's evaluation suites remain the place for that.
- **`recipeId` can be `null`.** A turn resolved by a fully deterministic path (context script,
  hashtag invocation) or an intent with no `ContextRecipe` never emits a grounding telemetry event,
  so its recipe is unknown to this aggregation by construction, not a bug - it is still counted in
  `sampleSize` and every other metric.
