# MUSE-adoption audit (Phase 1)

Date: 2026-09-21

This is a read-only audit, produced before any implementation in this change. It classifies every
capability requested in the MUSE-adoption brief as `EXISTS`, `PARTIAL`, `MISSING`, `CONFLICTING`, or
`OBSOLETE`, anchored to exact files. It builds on, and does not duplicate, three audits already in
this repository:

- [`context-semantic-runtime-audit.md`](context-semantic-runtime-audit.md) — the context-retrieval
  pipeline (evidence selection, budgeting, authorization).
- [`grogoni-execution-fabric-audit.md`](grogoni-execution-fabric-audit.md) — the now-retired Execution
  Fabric and why it must not be resurrected.
- [`../agent-runtime-vs-research-standards-audit.md`](../agent-runtime-vs-research-standards-audit.md)
  — a prior, independent comparison of this runtime against the ReAct/Reflexion/MemGPT/GEPA/METR
  research literature. It already names the single largest gap this change closes: _"Memory has no
  lifecycle... `docs/agent-evaluation-feedback-loop.md` states outright that 'automatic retention
  cleanup and reusable-workflow promotion are not yet background jobs.'"_ Retention cleanup has since
  shipped (`agent-owner-correction-retention-runner.ts`); **reusable-workflow promotion — i.e. a real
  experience/recall store — has not**, and is this change's primary target.

## Executive summary

Grogoni already implements the large majority of what the MUSE-adoption brief asks for, under
different names, as real, tested, invoked code — not aspirational documentation. This is the same
conclusion the three audits above independently reached for their own narrower scopes. Concretely:

- The **target execution loop** in the brief (canonical event → task classification → context
  planning → evidence resolution → … → outcome recording → experience extraction → recall) already
  exists end-to-end as `Cp2Store.createRuntimeTurn` →
  `AgentRuntimeDomain.executeRuntimeTurn` → `parseMerchantCommand` (classification) →
  `retrieveAgentContext` (context planning + evidence resolution, with an already-live "recall"
  retrieval slot) → `assembleAgentInferenceMessage` (recipe compilation) → native runtime resolution
  (agent+model+host) → `createRuntimeModelRoute` (inference) → `executeRuntimeAction` (tool
  execution) → `validateRuntimeToolInput`/`parseRuntimeModelOutput` (result validation) →
  `createRuntimeVerification` (verification) → `RuntimeHandoffDomain.checkpointAfterTurn`
  (handoff/checkpoint) → `recordAgentEvaluationEvent` (outcome recording).
- The **permanent rule** ("Grogoni owns state/identity/authorization/commerce semantics and execution
  policy; models reason; tools act; evidence grounds; experience improves future context") is already
  the repo's own stated invariant, verified independently by both background audits in this change and
  by `governed-tool-runtime.md`'s "one canonical tool registry, one execution pipeline" finding.
- The **one genuine, clearly-scoped gap** is: the type system, telemetry vocabulary, prompt-assembly
  wiring, and retention-policy fields for a **recall/experience subsystem all already exist and are
  wired up to render into every prompt** (`AgentContextSourceType.recall`,
  `RuntimeTelemetryState`'s `recall.*` states, `AgentMemoryPolicy.reusableWorkflowMemoryEnabled`, the
  `<relevant_recall>` block in `assembleAgentInferenceMessage`) — **but nothing ever writes a
  `recall`-type record**. `context/agent/recall.md` is a hand-authored _specification_ of the record
  shape, not data any code path loads (confirmed: zero TypeScript references to that file). This is a
  stubbed-out slot, not a missing design — filling it is this change's highest-leverage work and
  directly implements MUSE-adoption brief sections 8, 9, and 15.
- A second, smaller gap: there is no explicit, reusable **deterministic grounding gate** for
  evidence-dependent read intents (e.g. "how many packets of milk do I have"). A narrow, different
  "oracle" check exists (`findRuntimeUnknownEntityReferenceError`,
  `runtime-entity-lookup.ts`) for _mutation_ tool inputs (does this customer/product name exist before
  proposing a write) — but nothing checks, before the model answers a _read_ question, that
  `retrieveAgentContext` actually returned authoritative evidence of the type the task needs.
- A third, smaller gap: context recipes (brief section 7) are real but implicit — `intentContextTypes`
  (a plain lookup table) and `RuntimeModelTemplateRecipe` (a _different_, model-template-scoped
  "recipe") are two partial, unversioned analogs. Formalizing one versioned `ContextRecipe` registry
  that both the grounding gate and `retrieveAgentContext` read from closes this without duplicating
  either existing mechanism.
- Everything else the brief asks for — runtime handoff/continuity, provider-neutral inference, bounded
  tool execution, outcome recording, MCP (inbound direction), tenant isolation, fail-closed
  authorization — **already exists**, is already tested, and must not be rebuilt. The one **explicit
  non-goal** carried forward from this audit is outbound MCP (Grogoni acting as an MCP _client_ against
  external servers) — see "Explicitly not adopted" below.

## Capability classification

| #   | Brief capability                | Status                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Evidence-oriented context graph | `PARTIAL`                                     | `AgentContextSource`/`RetrievedAgentContextItem` (`packages/shared-types/src/index.ts:4011,4039`) already carry `sourceId`, `type` (12-value domain enum), `sensitivity`, `freshnessTimestamp`, `accessRules`, and `retrievalMetadata.sourceRecordId` (a provenance pointer back to the canonical business record — catalogue/customer/order rows are never duplicated, only referenced). Missing: an explicit `confidence` field and a typed `provenance.resolver` distinction between "read from a canonical business record" vs. "owner-authored free text" vs. "extracted from OCR." `ProductCaptureField<T>` (`shared-types/src/index.ts` ~1386) already has the `source`/`confidence` shape this should reuse for OCR-derived evidence.                                                                                                                                                                                                                         |
| 2   | Task-specific working context   | `EXISTS`                                      | `retrieveAgentContext` (`services/api/src/cp2/agent-business-runtime.ts:275`) builds exactly this per turn: filtered by authorization, narrowed by `intentContextTypes`, scored by relevance, packed into `contextCharacterBudgetForModel`. Ephemeral (recomputed every turn, never persisted as a blob) — matches the brief's "should normally be ephemeral" requirement exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Deterministic grounding         | `PARTIAL`                                     | `findRuntimeUnknownEntityReferenceError` (`services/api/src/cp2/domains/agent-runtime/runtime-entity-lookup.ts`) grounds _mutation_ tool inputs (entity-name existence) before a confirmation token is minted — the brief's "oracle" pattern, already built, per `agent-runtime-vs-research-standards-audit.md`. Missing: an equivalent deterministic check for _read_ intents that abstains (rather than lets the model guess) when `retrieveAgentContext` returns no evidence of the type the task needs.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | Structured experience memory    | `MISSING` (scaffolded)                        | `AgentContextSourceType` includes `"recall"` (shared-types:3854); `contextSourcesForRuntime` (`runtime-context.ts:92-103`) already filters/retains `recall`-type sources by `AgentMemoryPolicy.reusableWorkflowMemoryEnabled` and `retentionDays`; `assembleAgentInferenceMessage` (`agent-business-runtime.ts:204-233`) already renders a `<relevant_recall>` block, explicitly subordinate to authoritative context ("Recall is historical guidance only... always override it"); `RuntimeTelemetryState` already declares `recall.candidate_generated`, `.candidate_rejected`, `.deduplicated`, `.persisted`, `.retrieved`, `.applied`, `.persistence_failed` (shared-types:3507-3513). **None of these telemetry states are ever emitted** (repo-wide grep for `"recall.` in `services/api/src` returns zero hits) and **no code ever constructs a `recall`-type `AgentContextSource`**. This is the single largest, most clearly-scoped gap in the entire audit. |
| 5   | Runtime continuity/handoff      | `EXISTS`                                      | `RuntimeHandoff`/`RuntimeTaskHead`/`RuntimeTaskInstance`/`RuntimeExecutionEvent` (`packages/shared-types/src/runtime-handoff.ts`), `RuntimeHandoffDomain` (`services/api/src/cp2/domains/runtime-handoff/store.ts`, 2078 lines), migrations 083-085/087. Immutable checkpoint chain, causal ancestry for offline merge, execution fencing, full REST+MCP surface (`docs/architecture/runtime-handoff-protocol.md`). This is already a complete, production implementation of MUSE-adoption brief section 10 — extend, never replace.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | Outcome feedback                | `EXISTS`                                      | `AgentEvaluationEvent`/`AgentEvaluationEventType` (shared-types:4137-4171) already covers intent classification, context retrieval, tool selection/execution, policy compliance, corrections, sales, abandonment, escalation, latency, model failure, hallucination, invalid discount, satisfaction, owner feedback — `outcome: "success" \| "partial" \| "failure" \| "blocked"`. Reused as-is (see "Outcome taxonomy mapping" below) rather than adding a parallel enum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7   | Provider-neutral inference      | `EXISTS`                                      | Native runtime graph (`cp2_native_runtime_agents/models/execution_hosts/bindings`, migration 063+), `NativeRuntimeBindingStore`, `ModelRuntimeAdapter` (`services/api/src/inference/model-runtime.ts:46`). Provider SDK specifics never leak past the adapter boundary; execution targets (`backend`/`remote-shop-device`) are provider-agnostic (`docs/architecture/native-agent-model-runtime.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | Bounded tool execution          | `EXISTS` (by a different, stricter mechanism) | No multi-step model→tool→model loop exists at all (one plan, one policy gate, one execution per turn — `governed-tool-runtime.md`, deliberate), so "prevent unbounded loops" is satisfied structurally rather than by a call-count budget. `maxRuntimeTurnsPerSession = 20` bounds session-level action count; `withRuntimeDeadline` bounds I/O; `validateRuntimeToolInput` validates before execution; `findRuntimeUnknownEntityReferenceError` validates referenced entities exist. No literal `maxToolCalls`/`maxIterations` config exists because there is no loop for it to bound.                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | Bidirectional MCP               | `PARTIAL`                                     | Grogoni→caller (server) direction: `EXISTS`, thoroughly (`services/api/src/mcp/routes.ts`, JSON-RPC 2.0, tenant-scoped bearer tokens, same governed pipeline as REST — `grogoni.runtime_turn` calls `Cp2Store.createRuntimeTurn` directly, no parallel path). Caller→external-MCP-server (client) direction: `MISSING`. See "Explicitly not adopted."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10  | Systematic runtime evaluation   | `PARTIAL`                                     | Two real, distinct systems already exist: (a) per-turn `AgentEvaluationEvent`/`AgentEvaluationSummary` telemetry (`docs/agent-evaluation-feedback-loop.md`), and (b) the Model Template flywheel's `getReportCard`/`TemplateReportCard` (`services/api/src/cp2/domains/model-templates/store.ts:552`, `docs/architecture/model-template-flywheel.md`) — a genuine evaluate→gate→promote loop with versioned lineage, scoped to model-template prompt optimization. Missing: a report card at the _granularity the brief asks for_ (comparing M+C+T+R combinations at the runtime-turn level, not just the model-template level).                                                                                                                                                                                                                                                                                                                                      |

## Detailed findings by brief section

### §3 Evidence graph — `PARTIAL`

The brief's illustrative `EvidenceNode` interface maps onto `AgentContextSource` +
`RetrievedAgentContextItem` closely, field by field:

| Brief field             | Existing equivalent                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`                | `AgentContextSourceType` (`catalogue`\|`inventory`\|`customer`\|`supplier`\|`receipt`\|`order`\|`policy`\|`document`\|`conversation`\|`context_script`\|`owner_note`\|`recall`) |
| `entityType`/`entityId` | `type` + `retrievalMetadata.sourceRecordId`                                                                                                                                     |
| `value`                 | `retrievalMetadata.content`                                                                                                                                                     |
| `source`/`provenance`   | **missing** — no typed provenance object today                                                                                                                                  |
| `observedAt`            | `freshnessTimestamp`                                                                                                                                                            |
| `confidence`            | **missing**                                                                                                                                                                     |
| `authorizationScope`    | `accessRules: { audiences, requiredPermission, customerVisible }`                                                                                                               |

No graph database is needed and none is proposed — Postgres JSONB envelope tables are the existing,
correct substrate (`cp2_agent_context_sources`, `039_agent_business_runtime.sql`), matching the
brief's explicit instruction.

**Recommended action**: add `provenance: { resolver: "canonical_record" | "owner_authored" |
"ocr_extraction" | "model_recall" ...; sourceType: string }` and `confidence: number | null` to
`RetrievedAgentContextItem` (the already-narrowed, per-turn view — not the wider persisted
`AgentContextSource`, to avoid a schema migration for a field most existing sources can derive
statically). Canonical records (catalogue/inventory/customer/order — anything with a
`sourceRecordId`) get `confidence: 1` and `resolver: "canonical_record"` by construction. OCR/receipt
paths reuse `ProductCaptureField`'s existing `source`/`confidence` shape rather than inventing a
second one.

### §4/§5 Working context graph and token-budgeted assembly — `EXISTS`

Already exactly matches the brief's non-negotiable invariant ("context must be intentionally
selected rather than accumulated until the window fills"): `retrieveAgentContext` narrows by intent,
scores by relevance, and packs into `contextCharacterBudgetForModel`'s per-model character budget,
always keeping the top match even if it alone exceeds budget. The brief's diagnostic shape
(`candidateNodes`, `selectedNodes`, `rejectedNodes`, `estimatedTokens`, `tokenBudget`) is **not**
currently recorded — `model.prompt_built` telemetry today only records `retrievedContextCount`,
`retrievedContextTypes`, `intent`. This is a small, additive gap (see "Diagnostics" below).

### §6 Grounding gate — `PARTIAL`

See row 3 above. `createRuntimeVerification` (`services/api/src/cp2/domains/agent-runtime/shared.ts`)
is deterministic (role/confirmation/shape checks) but does not check evidence sufficiency for read
intents. The brief's exact example ("How many packets of milk do I have?" with no resolvable
inventory evidence) has no code path today that forces abstention — the model is only ever told,
via a fixed instruction, "when confidence is below the configured boundary, ask or escalate instead
of guessing" (`compileAgentInstructions`'s `outputRules`), which is a _model-obeyed_ convention, not
a _deterministic_ gate. This is the brief's own stated non-negotiable ("the model must not decide
whether mandatory evidence exists") and is a real gap.

### §7 Context recipes — `PARTIAL`

Two partial, non-duplicative existing mechanisms, neither of which is what the brief asks for:

- `intentContextTypes: Record<RuntimeParserIntent, AgentContextSourceType[] | null>`
  (`agent-business-runtime.ts:252`) — a plain lookup table, not versioned, no token budget or
  grounding policy attached per entry.
- `RuntimeModelTemplateRecipe` (shared-types:3558) — versioned and named "Recipe," but scoped to
  Model-Template prompt compilation (`allowedTools`, `contextRequirements`, `outputSchema`,
  vocabulary snapshots), not evidence requirements or a grounding policy.

Neither should be deleted or forked. The recommended action is a new, small `ContextRecipe` registry
(`grogoni.<taskType>@<version>`) that both existing mechanisms can be read as specializations of:
`intentContextTypes` becomes a derived view (`recipe.requiredEvidence ∪ recipe.optionalEvidence`),
and the recipe's `groundingPolicy` field is what the new grounding gate (§6) reads.

### §8/§9/§15 Experience memory, recall, refinement — `MISSING` (scaffolded)

See row 4 above — this is the audit's central finding. The brief's `RuntimeExperience` interface
(`situation`, `recipeId`/`recipeVersion`, `evidenceRefs`, `toolSequence`, `resultType`,
`verificationResult`, `outcome`, `lesson`) has no existing analog to conflict with or duplicate; it is
genuinely new, additive persistence. It must integrate with, not replace:

- The already-wired `recall` `AgentContextSourceType` and its retention/enablement filtering
  (`runtime-context.ts:92-103`).
- The already-wired `<relevant_recall>` prompt block (`agent-business-runtime.ts:204-233`), which
  already treats recall as advisory and subordinate to authoritative context — the new store must
  produce records that render correctly into this _existing_ block, not add a second one.
- The already-declared `recall.*` `RuntimeTelemetryState` values, which should finally be emitted
  real events instead of never firing.
- `AgentOwnerCorrection`'s promotion pattern (`candidate`-like `active`/`disabled` status, immutable
  audit trail, promotion bumps `runtimeVersion`) as the direct structural template for the brief's
  `candidate → validated → deprecated` lesson lifecycle (§15), so experience promotion doesn't
  reinvent a lifecycle that already has a working, tested precedent one file away.

### §14 Outcome recording — `EXISTS`; taxonomy mapping documented, not changed

The brief's outcome states (`successful | adjusted | rejected | failed | unknown`) do not need a
parallel enum. `AgentEvaluationEvent.outcome` (`success | partial | failure | blocked`) already
covers this ground and is the system every other Grogoni surface (owner UI, retention runner, model
template flywheel) already reads. Mapping used by the new experience extractor introduced in this
change: `successful → success`, `adjusted → partial`, `rejected/unauthorized → blocked`,
`failed → failure`; `unknown` has no existing equivalent and is intentionally not synthesized —
extraction simply does not produce an experience record when outcome cannot be determined, rather
than inventing a placeholder value for an enum that doesn't have one.

### §17 Evaluation / report card — `PARTIAL`

`TemplateReportCard`/`getReportCard` already implements the brief's report-card shape (model, model
revision via `baseModelId`, agent via template ownership, recipe/version via `templateVersionId`,
metrics, deltas, evaluation-run linkage) — but only for the Model Template optimization loop, whose
unit of comparison is a _template version_, not a live runtime turn's actual (agent, model, recipe,
tools, runtime) tuple. Building a second, full evaluate/gate/promote pipeline at turn granularity is
out of scope for this change (that pipeline is a large, standalone system, correctly scoped
separately per "P = f(M,C,T,R)... Recipe evolution... lay the foundation... do NOT implement
autonomous production prompt mutation yet"). What this change adds instead is a read-only
**aggregation view** over already-recorded `AgentEvaluationEvent` and `RuntimeTurnSummary` data,
grouped by the actual (agentId, runtimeVersion, modelId, recipeId) tuple — the foundation the brief's
§16/§17 ask for ("record enough execution metadata to evaluate this later"), without building the
gated-promotion machinery a second time.

## Explicitly not adopted

- **Outbound MCP client (Grogoni calling external MCP servers).** Confirmed `MISSING` — no MCP client
  SDK usage, no external-MCP-server connection concept exists anywhere in the repo (the adjacent
  GitHub/HuggingFace registry-import pipeline, `073_external_registry_connections.sql`, is a
  PAT-based artifact importer, not an MCP protocol client). This is a real gap against brief §13, but
  building it safely (a new trust boundary: authenticating to a third party's tool surface, mapping
  its tool schemas through Grogoni's own authorization/policy/audit pipeline without ever letting an
  external server bypass tenant isolation) is large, security-sensitive, net-new surface area with no
  existing scaffold to extend — unlike every other gap in this audit, there is no stubbed slot, wired
  telemetry, or half-built store to complete. Per the brief's own definition-of-done framing
  ("distinguish intentional non-goal from code incomplete"), this is called out here as an
  **intentional non-goal for this change**, not attempted partially. A future change should scope it
  on its own, starting from `governed-tool-runtime.md`'s "one governed execution path" invariant:
  any inbound call from an external MCP-connected agent must still pass through
  `runtimeToolRegistry`/`enforceAgentPolicy`/confirmation gating exactly like every existing surface —
  it should not get a parallel authorization path.
- **A second graph database or vector database.** Not proposed; not needed. Postgres JSONB envelope
  tables remain the substrate for the new experience store, matching every other CP2 domain.
- **Autonomous production recipe/prompt mutation.** The Model Template flywheel already has a
  human-gated version of this (`optimizePromptExpertise`); the new `ContextRecipe` registry and
  report-card aggregation in this change are deliberately read-only/versioned-by-hand, per brief §16's
  explicit instruction not to build autonomous mutation yet.
- **A parallel Muse runtime, orchestration layer, or `MuseRuntime`/`MuseAgentRuntime` class.** Per the
  brief's own non-negotiable. Every addition in this change is a new field, a new small pure function,
  or a new additive CP2 domain store following the exact structural conventions of
  `agent-owner-correction`/`AgentEvaluationEvent`, composed into the existing `Cp2Store`, not a
  parallel execution path.

## Reuse-before-add ledger

| New capability this change adds                      | Extends (does not replace)                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetrievedAgentContextItem.provenance`/`.confidence` | `AgentContextSource`/`retrieveAgentContext`                                                                                                                                                                            |
| `ContextRecipe` registry                             | `intentContextTypes` (becomes a derived view); does not touch `RuntimeModelTemplateRecipe`                                                                                                                             |
| `evaluateGrounding` deterministic gate               | `createRuntimeVerification`, called from the same `executeRuntimeTurn` pipeline, before model dispatch for evidence-dependent intents only                                                                             |
| `RuntimeExperience` store + extraction + promotion   | The already-declared `recall` `AgentContextSourceType`, the already-wired `<relevant_recall>` prompt block, the already-declared `recall.*` telemetry states, and `AgentOwnerCorrection`'s promotion-lifecycle pattern |
| Context-selection diagnostics                        | The existing `model.prompt_built` `RuntimeTelemetryEvent` (no new event taxonomy)                                                                                                                                      |
| Runtime report-card aggregation                      | Reads existing `AgentEvaluationEvent`/`RuntimeTurnSummary` data; does not touch `TemplateReportCard`/`getReportCard`                                                                                                   |

## Native runtime architecture (for reference; do not resurrect the Execution Fabric)

The Execution Fabric (`060_execution_fabric_entities.sql`) is fully retired
(`065_retire_execution_fabric.sql`), enforced by an automated CI gate
(`scripts/check-retired-runtime-references.mjs`) that fails the build if any of
`cp2_model_preferences`/`cp2_runtime_hosts`/`cp2_runtime_model_installations`/
`cp2_agent_model_assignments`/`cp2_browser_inference_assignments`/`cp2_agent_model_bindings` appear
in production source outside two explicitly allowlisted guard-constant files. Every change in this
implementation resolves agents/models/runtimes exclusively through the current native runtime graph
(`cp2_native_runtime_agents/models/execution_hosts/bindings`, `NativeRuntimeBindingStore`,
`docs/architecture/native-runtime-bindings.md`) and the Runtime Handoff Protocol
(`RuntimeHandoffDomain`, `docs/architecture/runtime-handoff-protocol.md`). No new table, store, or
resolution path introduced in this change bypasses either.

## What happens next

Phases 2-14 of this change (evidence provenance, context recipes, grounding gate, experience/recall
store, diagnostics, report-card aggregation, tests, documentation) are scoped directly from the gaps
identified above — nothing else. See the per-capability documents added alongside this audit:
`context-runtime.md`, `evidence-graph.md`, `context-recipes.md`, `experience-memory.md`,
`runtime-grounding.md`, `runtime-evaluation.md`.
