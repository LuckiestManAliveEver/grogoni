# Model Template flywheel repository audit

Status: completed 2026-09-02. This is the pre-change architecture record for migration 081 and the
Model Templates domain.

## Architecture discovered

Grogoni already separated most runtime concepts correctly:

| Question                            | Existing answer                                                                                                                                                                       | Evidence                                                                                                                 | Disposition                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| What is a model?                    | A DB-hosted `AiModelSummary` catalogue entry, materialized `NativeRuntimeModelSummary`, and optional object-storage `ModelArtifact`                                                   | `agent-runtime/model-catalog.ts`, `native-runtime/store.ts`, `inference/model-artifact-store.ts`, migrations 071 and 079 | Reuse                                                  |
| What is an agent?                   | Identity, policy, skills, context, memory, evaluation policy, and an independently selected harness adapter                                                                           | `agent-runtime/shared.ts`, `agent-harness/*`, `cp2_agent_profiles`                                                       | Reuse                                                  |
| How are agent and model bound?      | The native graph links agent, ordered model roles, installation, and execution host; conversations reference the runtime binding                                                      | migration 063, `native-runtime/store.ts`, `native-runtime-routing.ts`                                                    | Extend with a template-version overlay; do not replace |
| How are model artifacts stored?     | PostgreSQL stores metadata and SHA-256; bytes live in object storage and use short-lived signed URLs                                                                                  | migration 079, `model-artifact-store.ts`, `ai-runtime/artifact-loader.ts`                                                | Reuse for large compiled expertise                     |
| How are model versions represented? | Catalogue/runtime models have identities, but no expertise-version lineage existed                                                                                                    | migrations 071/079                                                                                                       | Add template versions separately                       |
| Did `.grogoni.com` exist?                  | Only conceptually. No canonical schema, validator, exporter, or runtime contract existed                                                                                              | repository search before this change                                                                                     | Add                                                    |
| How is inference routed?            | Chat authorizes a turn, resolves native binding/model/host, builds context and prompt, calls `ModelRuntimeAdapter` through an `AgentRuntimeAdapter`, then validates tools server-side | `agent-runtime/store.ts`, `runtime-model-routing.ts`, `inference/model-runtime.ts`                                       | Reuse with one expertise prompt hook                   |
| Execution targets                   | Provider-neutral `vercel`, `backend`, and `remote-shop-device` targets in the existing native graph                                                                                   | `ModelExecutionTarget`, provider-neutral runtime docs                                                                    | Reuse; no new fabric                                   |
| Existing telemetry                  | Per-turn runtime telemetry and durable shop-scoped `AgentEvaluationEvent` aggregates; no suite/case/run report cards                                                                  | `RuntimeTelemetryEvent`, `cp2_agent_evaluation_events`                                                                   | Extend                                                 |
| Existing evaluation                 | Runtime outcome/feedback summaries and owner corrections, but no deterministic benchmark runner, baseline comparison, or regression gate                                              | `docs/agent-evaluation-feedback-loop.md`, `AgentRuntimeDomain`                                                           | Reuse signals; add lifecycle subsystem                 |
| Safe production data                | Bounded operational metadata and explicit owner corrections. Raw conversation storage is governed separately and is not training truth                                                | agent evaluation and privacy policies                                                                                    | Preserve; add explicit observation approval            |
| Tenant boundary                     | Browser or MCP principal authorizes against business membership and `BusinessPermission`; normalized tables carry business/account scope                                              | `requireAuthorizedActor`, migrations 039/061                                                                             | Reuse on every new route and row                       |
| Migration direction                 | Execution Fabric and legacy assignment tables were retired in migrations 065, 075, and 076; native bindings are authoritative                                                         | retirement migrations and boundary checks                                                                                | Never revive                                           |

## Reusable infrastructure

- `Cp2Store` remains the control-plane service and Postgres snapshot authority.
- `AgentRuntimeDomain` continues to own chat/runtime turns, prompt assembly, tools, and policy.
- `NativeRuntimeBindingStore` continues to select the swappable base model and execution host.
- `ModelRuntimeAdapter` and `AgentRuntimeAdapter` remain the only execution boundaries.
- `runtimeToolRegistry` remains the allowed tool namespace. A `.grogoni.com` manifest cannot invent a host
  tool.
- The migration runner, normalized persistence queue, Neon tables, object-storage artifact
  contract, telemetry conventions, and agent settings UI are reused.

## Infrastructure extended

- The prompt compiler now asks the Model Templates domain for the promoted expertise matching the
  authorized business and active agent. It validates the actually selected base model before
  appending compiled instructions.
- `Cp2Snapshot` and the Postgres normalized collection list include the fourteen new lifecycle
  collections from migration 081.
- Agent model settings now read report-card APIs. Evaluation arithmetic stays in the backend.
- Structured lifecycle telemetry contains only opaque IDs, counts, states, and metric values.

## Obsolete or dead architecture

- `cp2_execution_*` and legacy agent-model assignment paths are historical. Model Templates do not
  use them.
- `cp2_model_artifacts` from migration 066 is the legacy account chunk-upload store, not the
  object-storage runtime artifact table. New large compiled expertise must follow
  `cp2_runtime_model_artifacts`-style object pointers, not store binaries in JSONB or `bytea`.
- Existing owner corrections promoted directly into agent runtime rules remain valid, but they are
  not a replacement for reviewed dataset versions and reproducible improvement runs.

## Missing components before implementation

- A versioned manifest and archive layout.
- Source-versus-compiled expertise distinction.
- Template versions, runtime bindings, ancestry, and portable export.
- Suites, cases, runs, detailed results, multi-metric report cards, and promotion gates.
- Safe observations, reviewed corrections, immutable datasets, and leakage controls.
- Improvement strategy contracts and one honest supported strategy.
- A deterministic, offline vertical slice.

## Migration risks

1. The normalized snapshot writer upserts complete collections. Dataset immutability triggers must
   allow identical upserts while rejecting changed JSON.
2. Parent foreign keys differ by collection. `recordParentId` must map each new collection
   explicitly; a generic “first ID-like property” can attach an improvement run to its dataset
   instead of its parent template version.
3. Runtime model overrides can be incompatible. Resolution must validate the selected model and
   fail rather than silently omit expertise.
4. Evaluation suites can become training leakage. Used suites freeze, and evaluation cases cannot
   enter a `TRAINING` split.
5. Production text may contain secrets or prompt injection. Inputs are bounded, secret-shaped keys
   are redacted, suspicious instruction text is risk-flagged, and nothing trains without approval.
6. Prompt optimization can improve size while hurting correctness. Promotion compares the same
   frozen suite against the production baseline and blocks configured regressions.
7. Adapters are architecture-specific. The source instructions, rules, vocabulary, examples, and
   evaluations remain portable; an adapter descriptor must name its exact base and architecture.

## Resulting extension boundary

```text
Existing chat/runtime
  -> existing agent + native runtime binding
  -> promoted template version (new, tenant-scoped)
  -> source/compiled expertise (new)
  -> selected compatible catalogue model (existing, swappable)
  -> selected execution host + ModelRuntimeAdapter (existing)
```

No new orchestration service, inference endpoint, model provider dependency, or execution fabric
was introduced.
