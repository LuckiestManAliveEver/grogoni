# Business Environment Evaluation

## Storage and Policy

New tasks pin `evaluationPolicyId` from the trusted manifest. The inventory policy is
`grogoni.inventory.outcomes.v1`. Legacy tasks without a pin and unsupported policies remain
inconclusive for scoring; they are not silently upgraded.

`evaluateBusinessTaskStep` extends the existing independent verifier. The resulting evaluation
and `AgentEvaluationEvent` are embedded in its native PostgreSQL report, committed together.
There is no second evaluation database, snapshot acknowledgement or model-judged success gate.
Stable report/event identities deduplicate unchanged evidence. A changed authoritative state
produces a new report. The reader chooses the latest report per step before extracting its
evaluation, so a missing or failed latest evaluation cannot fall back to an older success.

## Measurements

- Execution success requires all six independent categories to pass under a supported policy.
- Constraint violations distinguish a failed constraint check from missing evidence.
- Execution accuracy comes from authoritative outcome verification.
- Tool calls count recorded canonical `tool.executed` telemetry, not model requests.
- Latency is wall-clock task creation to verification, including approval and queue time.
- Model latency and token usage come only from actual model evidence. Deterministic steps have
  no model identity or model usage. Missing measurements are null, not zero.
- Human intervention counts a successful confirmation for the evaluated step, not every UI
  interaction or a claimed number of people involved.
- Tool efficiency is null until a supported reference strategy establishes a denominator.

These are step evaluations. A successful step alone does not establish completion of an entire
multi-step task; the environment lifecycle still requires every planned step to be verified.

## Immediate and Delayed Outcomes

A verified inventory read has an immediate verified outcome. Valid replenishment drafts have
immediate execution success, budget compliance and order accuracy, but business outcome remains
`PENDING`. Forecast accuracy and stockout reduction remain null: a prepared draft is not evidence
of supplier delivery or a prevented stockout. Reward remains null until a reviewed policy has
observable business-outcome evidence. No universal reward formula or online training is added.

## Existing API and Isolation

`GET /businesses/:businessId/agent-runtime/evaluations` keeps the existing evaluation summary and
adds `environmentOutcomes`, with up to 200 latest actor-owned step outcomes. Their existing event
shape also participates in recent event reporting. Event types distinguish runtime-turn scoring
from independent business-step scoring; the summary average is not a delayed business reward.
Both Node and Edge use the same native-journal reader. Reads require current business access and
are actor/business scoped. Database failures fail the request rather than silently reporting an
empty successful result. Account deletion and native task cleanup already remove the parent
verification reports and therefore these evaluations.

## Validation

Real PostgreSQL tests cover committed/deduplicated evaluation, missing policies, changed-source
inconclusiveness, exact actor/business isolation, rollback and inventory-draft pending rewards.
The existing HTTP test checks authentication before reads and asynchronous database-error
propagation. Model execution and parser-only regression tests remain in the existing runtime suite.
