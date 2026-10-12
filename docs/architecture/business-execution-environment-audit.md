# Business Execution Environment: Repository Audit (Phase 0)

Date: 2026-10-11
HEAD audited: `84060f77` (main), plus uncommitted Railway daemon work in the tree that this audit does not touch.
Scope: Phase 0 of the "Business Execution Environment" brief. Read-only. No application, database
or frontend code changed.

Method: every claim below was traced in code, not taken from docs. Where a doc disagrees with the
code, the code wins and the drift is listed in section 12. Paths are repo-relative.
Abbreviations: `AR` = `services/api/src/cp2/domains/agent-runtime`, `TC` = `packages/tool-core/src`,
`ST` = `packages/shared-types/src/index.ts`, `ABR` = `services/api/src/cp2/agent-business-runtime.ts`.

Two findings were also checked against a real Postgres 16 database (section 6.4). Everything else is
static tracing with file:line evidence.

---

## 1. Summary

Grogoni already has the components an environment layer would build on: one capability registry,
one post-policy dispatcher, a confirmation gate, a role model, context recipes, a grounding gate,
an experience store, template evaluation and a durable handoff/event log. None of them needs to be
rebuilt.

What it does not have is the execution model the brief assumes. Five gaps decide the plan:

1. **One tool call per turn.** A runtime turn produces exactly one `RuntimePlannedAction`
   (`ST:4122-4132`). There is no multi-step plan, no step dependencies, no loop that feeds a tool
   result back to the model. `packages/execution-planner` is an untracked `dist/` remnant of the
   retired Execution Fabric with no importers.
2. **No post-execution verification.** "Verification" (`createRuntimeVerification`,
   `AR/shared.ts:298-317`) is a pre-execution authorization check. After dispatch, the handler's
   return value is trusted and nothing re-reads the authoritative record.
3. **Confirmations are not durable, and on the primary deployment they cannot work.** Pending
   actions live in an in-memory `Map` (`AR/store.ts:284`) with no expiry and are never part of the
   snapshot. Supabase Edge, which serves `grogoni.com`, builds a fresh store per request
   (`services/api/src/edge-domain-routes.ts:103`), so a confirmation token minted on one request is
   never found on the next. Every confirmation-gated agent action fails there.
4. **Success can be acknowledged before the write is durable** (Render/Node path only). Proven for
   `/buy/checkout` against real Postgres: the request itself never queues a save; the order reaches
   Postgres only when a later save captures it, which on Render happens within about 60s via the
   notification runner (section 6.4). A crash or redeploy inside that window loses it. Edge commits
   inside the request and is not affected.
5. **The acceptance scenario has no domain backing.** There is no purchase-order entity, no
   supplier price catalogue, no stockout forecast and no budget logic (section 7).

The brief's own rule applies: "Do not introduce a separate autonomous planning engine unless the
audit proves that the current implementation cannot support structured multistep execution."
The audit shows this: it can't. Section 10 lists the decisions Julien needs to make before Phase 1.

---

## 2. Current architecture (as traced)

### 2.1 One runtime turn, end to end

| #   | Hop                                                                                                                                              | Where                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /businesses/:businessId/runtime/turns`; body = `runtimeSessionId, conversationId, message, confirmationToken` (no idempotency key)         | `AR/routes.ts:996-1015`, `AR/runtime-turn-request.ts:4`                                                        |
| 2   | `createRuntimeTurn`: `business:read`, per-conversation lock (in-process `Set`), then `executeRuntimeTurn`, then fenced checkpoint                | `AR/store.ts:2113-2133`, `services/api/src/cp2/domains/runtime-handoff/store.ts:185-196`                       |
| 3   | Readiness gate (409 `agent_runtime_not_ready`), model resolution, `buildShopAgentRuntime`, template instructions, runtime session (20 turns max) | `AR/store.ts:2161-2339`, `AR/shared.ts:202`                                                                    |
| 4   | Deterministic proposers first (imports, messaging, network, commerce, receipts, products, `parseMerchantCommand`)                                | `AR/store.ts:2363-2401`, `AR/planning.ts`                                                                      |
| 5   | Context: `resolveAgentContext`, top 6 items, character budget; grounding evaluation                                                              | `AR/store.ts:2402-2421`, `ABR:392-489`                                                                         |
| 6   | Model call only if no deterministic proposal: `createRuntimeModelRoute`, adapter `grogoni` or `pi`, one `model.complete`                         | `AR/runtime-model-routing.ts:52-387`, `services/api/src/agent-harness/default-agent-runtime-adapters.ts:10-14` |
| 7   | `parseRuntimeModelOutput` → exactly one `tool`/`clarification`/`response`; native tool calls take the first allowed call only                    | `TC/parsers/model-output.ts:10-104`, `services/api/src/inference/providers/routed-model-adapter.ts:232-236`    |
| 8   | Resolve `runtimeToolRegistry[toolName]`; `roleCan(context.role, requiredPermission)`                                                             | `AR/store.ts:2567-2568`                                                                                        |
| 9   | Policy: unknown-entity check, `enforceAgentPolicy` (skills, restricted actions, catalogue, discount, credit, substitution)                       | `AR/store.ts:2580-2588`, `ABR:581-625`                                                                         |
| 10  | Confirmation decision; token = `randomUUID()`; `createRuntimePlan` + `createRuntimeVerification`; pending action into memory `Map`               | `AR/store.ts:2598-2661`                                                                                        |
| 11  | `executeRuntimeCapability` if `safe_to_execute && verification.ok`                                                                               | `AR/store.ts:2671-2691`, `AR/capabilities.ts:38-509`                                                           |
| 12  | Domain operation via injected `deps.*` (each re-checks the user's permission)                                                                    | `services/api/src/cp2/store.ts:1368+`                                                                          |
| 13  | `storeRuntimeTurn`: memory Maps + audit event + sampled evaluation event                                                                         | `AR/store.ts:3582-3672`                                                                                        |
| 14  | Response text from deterministic `createRuntimeResponse`                                                                                         | `AR/shared.ts:354-425`                                                                                         |

### 2.2 Persistence modes (both are deployed)

- **Node API** (Render, `render.yaml`): one in-memory `Cp2Store`, persisted by a
  Proxy that queues a whole-snapshot diff save after any method named in `mutatingMethodNames`
  (`services/api/src/cp2/postgres-store.ts:211-451`, Proxy `:1222-1294`, save `:831-910`,
  transaction `:2743-2813`).
- **Supabase Edge** (Vercel rewrites `/api/*`, `vercel.json`): **the primary production path.**
  `docs/deployment/supabase-edge-api.md:23-24, 33, 279-281` attaches `grogoni.com` to Vercel; the
  web app, the production checker, MCP and Android (`apps/android/app/build.gradle.kts`) use
  `https://grogoni.com/api`. `render.yaml` still lists `grogoni.com`, but keeps `api.grogoni.com`
  as a "temporary compatibility alias" for legacy clients. Per request, one Postgres
  transaction that takes advisory locks, builds a fresh store, loads the scoped snapshot, runs
  the route and saves before replying (`services/api/src/edge-domain-routes.ts:90-313`).
- **Postgres-native domains**: fulfillment (`withFulfillmentTransaction`,
  `cp2/domains/fulfillment/transaction.ts:48-81`), daemon queue (`services/api/src/daemon/task-store.ts`),
  inference runs (`services/api/src/inference/providers/postgres-repositories.ts`).

Any environment state added later has to work under both modes. That rules out in-memory-only
state for anything that spans requests.

---

## 3. Evidence matrix

Classifications: IMPLEMENTED, PARTIALLY_IMPLEMENTED, MISSING, DUPLICATED, DEPRECATED.

### 3.1 Environment registry: MISSING

- **Source:** none. Grep `environment` in runtime code finds only `AgentSkillBinding.executionEnvironment`
  (`server | browser_worker | native`), which is validated (`AR/shared.ts:831-840`) and never enforced,
  and an unrelated `"android-device"` label in messaging metadata.
- **Existing behavior:** the closest groupings are context recipes (`contextRecipeRegistry`,
  `ABR:284-376`: id `grogoni.<intent>@1`, required/optional evidence, tools, grounding policy) and
  Shop Hub modules on each tool definition (`hub` field in `TC/contracts/runtime.ts:216-241`).
- **Missing:** a first-class, versioned grouping of capabilities, observation schema, verification
  policy and evaluation policy.
- **Required change:** a registry in `packages/tool-core` next to `runtimeToolRegistry`, whose
  manifests reference tool names (type-checked against `RuntimeToolName`) and never declare
  permissions of their own. Extend recipes; don't fork them.
- **Tests:** none exist. Needed: manifest validation, capability-reference integrity,
  "manifest cannot widen permissions".
- **Security:** a manifest must only narrow. It must not carry `requiredPermission` or
  `requiresConfirmation` overrides that loosen the registry.

### 3.2 Environment lifecycle: PARTIALLY_IMPLEMENTED (for other units of work)

- **Source:** runtime sessions (`active | closed`, `ST:4161`); handoff task instances
  (`STARTING|READY|RUNNING|DEGRADED|FAILED|STOPPED`, `packages/shared-types/src/runtime-handoff.ts:138-139`);
  `resume` / `cancelExecution` (`runtime-handoff/store.ts:1195-1235, 1946-1960`); computer sessions with
  `suspendSession` / `resumeSession` and `AWAITING_APPROVAL` (`cp2/domains/computer-runtime/store.ts:296-305, 461-490`).
- **Existing behavior:** checkpoint, resume, rollback, merge and fencing exist for conversation
  tasks. Task-instance status is set with no transition validation (`setTaskInstanceHandoff`,
  `runtime-handoff/store.ts:1835-1858`). `DEGRADED`, `FAILED` and `STARTING` are never written.
- **Missing:** an initialize → observe → act → verify → evaluate → close lifecycle for a business task.
  A model turn that is awaiting approval cannot be suspended and resumed across a restart.
- **Required change:** a task record that composes with the existing handoff `taskId` and
  execution-event log rather than a parallel lifecycle.
- **Tests:** `tests/runtime-handoff-protocol.test.ts`, `runtime-handoff-domain-unit.test.ts`,
  `runtime-handoff-persistence.test.ts` (Postgres).

### 3.3 Environment state / observation: PARTIALLY_IMPLEMENTED

- **Source:** `resolveAgentContext` (`ABR:392-489`), `buildRuntimeContext` (`services/api/src/cp2/store.ts:10975-10999`),
  `runtime-context.ts:210-266`; read capabilities `products.list`, `invoices.list`,
  `reports.summary`, `notifications.list` (`AR/core-read-capabilities.ts:15-39`).
- **Existing behavior:** context is authorization-filtered (audience/status/deleted, `ABR:413-419`),
  recipe-filtered, scored by unversioned term overlap (`ABR:420-440`), capped at 6 items (`AR/store.ts:2406`)
  and a character budget (`AR/model-catalog.ts:391-408`). Untrusted text is capped at 4000 chars and
  sanitized (`ABR:637-656`).
- **Missing:** a stable, timestamped, versioned observation with provenance that can be
  reproduced later. Retrieved source ids and the assembled prompt are not persisted (only counts,
  `ST:3841`); `GroundingDecision.evidenceIds` is computed and dropped. There is no `stateVersion`
  for business records.
- **Required change:** persist observation provenance (source ids + record `updatedAt`) on the task.
  Reuse the context runtime as the producer.
- **Security:** customer/supplier/receipt sources have `content: null` (`runtime-context.ts:210-223`),
  which is good for minimization and must be preserved.

### 3.4 Task specification: MISSING

- **Source:** none. `task` has three unrelated meanings today: handoff `taskId` (= conversation id),
  daemon tasks (`grogoni_daemon_tasks`), and template `tasks` (parser intents).
- **Missing:** objective, constraints, allowed capabilities, success criteria and execution mode
  as a structured, persisted object.
- **Required change:** a `BusinessTask` contract in `packages/shared-types`, keyed to the existing
  handoff `taskId` so checkpoints and execution events attach without a new identifier scheme.

### 3.5 Execution through capabilities: IMPLEMENTED (single step), MISSING (multi step)

- **Source:** `executeRuntimeCapability` (`AR/capabilities.ts:38-509`); only two callers,
  auto-execute (`AR/store.ts:2684`) and confirm (`AR/store.ts:2905`).
- **Existing behavior:** one canonical post-policy dispatcher, 62 registered tools
  (`TC/contracts/runtime.ts:96`, grouped in `TC/domains/*.ts`). Every path reaches domain methods
  under the invoking user's session, so domain-level permission checks repeat.
- **Missing:** multi-step execution, dependencies, per-step expected output. The pi adapter runs
  with `tools: []` (`services/api/src/agent-harness/pi-agent-runtime-adapter.ts:37`).
- **Required change:** a bounded step loop that calls `executeRuntimeCapability` per step and
  pauses at each confirmation (Decision D1).
- **Tests:** `tests/runtime-capability-execution.test.ts`, `capability-architecture.test.ts`,
  `runtime-hallucinated-entity-reference.test.ts`.

### 3.6 Verification (post-execution): MISSING

- **Source:** `createRuntimeVerification` (`AR/shared.ts:298-317`) checks rate limit, role, validation
  errors and confirmation **before** execution. Grep `postcondition|read.?back|re-?read|verifyWrite|reconcil|assertPersisted|postExecution`
  under `services/api/src/cp2` hits fulfillment lock-then-recheck (`fulfillment/dispatch.ts:1038`,
  `corridors.ts:258`), the intake reconciler, order/payment reconciliation in domain code, and a
  model-binding re-read (`AR/store.ts:845`). None of them runs after `executeRuntimeCapability`.
- **Existing behavior:** the handler result is trusted and the turn is marked executed
  (`AR/store.ts:2685-2698, 2905-2928`).
- **Grounding gap:** `evaluateGrounding` (`ABR:507-535`) applies only to `unknown.clarify` and only
  `require_evidence` for 4 read intents (`ABR:323-354`). A model "response" becomes
  `unknown.clarify` with `valid()` and its text is returned verbatim with status `completed`
  (`TC/parsers/model-output.ts:91-104`, `AR/shared.ts:424`). Only the prompt rule at `ABR:149`
  stops a model saying "done" for an action that never ran.
- **Required change:** a verification step after dispatch that re-reads the authoritative record
  through the domain read path and records structural, authorization, constraint, execution,
  persistence and outcome checks separately. Extend `RuntimeVerification`; don't fork it.

### 3.7 Evaluation: PARTIALLY_IMPLEMENTED (three disconnected mechanisms)

- **Live report card** (`AR/report-card.ts:16-104`, route `AR/routes.ts:881`): groups turns by
  (runtimeVersion, modelId, recipeId); success, abstention, groundedAcceptRate, toolCallRate,
  latency, tokens. It is computed on read and not stored. There is no cost and no
  human-intervention rate. `toolCallRate` counts `blocked` executions.
- **Per-turn `AgentEvaluationEvent`** (`AR/store.ts:3610-3673`, table `cp2_agent_evaluation_events`):
  records `profile.modelId`, the **configured** model, not the model that actually ran
  (`turn.model.modelId`), so fallback turns are attributed to the wrong model.
  `evaluationPolicy.retainDays` is validated (`AR/shared.ts:893`) but never enforced.
- **Model-template evaluation** (`cp2/domains/evaluation/service.ts:38-150`,
  `model-templates/store.ts:404-534`): frozen suites, deterministic matchers, candidate vs baseline,
  promotion gate. In production the executor defaults to `executeDeterministicRuleExpertise`
  (keyword match, no model, `estimatedCost: 0`) because `templateExecutor` is never passed to
  `createCp2Store` (`services/api/src/index.ts:649`). JUDGE cases throw `JUDGE_EVALUATOR_UNAVAILABLE`.
- **Scripts:** `pnpm eval:ai` (6 rubric scenarios, one model from env, judged via `claude -p`,
  threshold 0.8, `.github/workflows/ai-eval.yml` is `workflow_dispatch` only); `pnpm eval:daemon-live`.
- **Missing:** per-task evaluation records, per-environment reward definitions, delayed outcomes.
- **Required change:** one evaluation record per task that reuses `cp2_agent_evaluation_events`
  semantics (fixed to record the actual model) instead of a fourth mechanism.

### 3.8 Experience memory: PARTIALLY_IMPLEMENTED (with correctness defects)

- **Source:** `AR/experience.ts`, `nextRuntimeExperienceState` (`AR/shared.ts:1052-1127`), trigger at
  `AR/store.ts:2705-2717`, migration `088_runtime_experiences.sql`, retention runner
  (`runtime-experience-retention-runner.ts`, wired `services/api/src/index.ts:486-487`).
- **Existing behavior:** one trigger, `fallbackUsed && status === "completed" && verification.ok`.
  Lesson key `fallback:${intent}:${fallbackReason}`; `fallbackReason` is always the constant
  `"retryable-execution-failure"` (`AR/runtime-model-routing.ts:101`). Promotion at
  corroboration count 2 (`AR/shared.ts:1038`). Validated rows become advisory `<recall>`
  context (`runtime-context.ts:245-266`, `ABR:210-250`).
- **Defects (confirmed in code):**
  - Corroboration is not independent. No distinct actor, session, input or time-window check.
    Two identical messages from one user promote a lesson. The comment at `AR/experience.ts:32`
    says "independent"; the code doesn't enforce it. `tests/muse-adoption-runtime.test.ts:235-255`
    asserts promotion with only `turnId` changing.
  - The trigger never checks `modelRoute.trace.status === "available"`. `fallbackUsed` is
    `fallbackIndex > 0` (`AR/runtime-model-routing.ts:100`), which also holds when routing simply
    picks a `role === "fallback"` binding model (`AR/native-runtime-routing.ts:110-115`). The recorded
    lesson ("the configured fallback model completed the request") can be false.
  - `verificationResult: "ok"` and `outcome: "successful"` are hardcoded (`AR/shared.ts:1111-1112`).
  - `evidenceRefs` from later corroborations are not merged; `sourceTurnId` is overwritten
    (`AR/shared.ts:1081`).
  - `recall.candidate_generated`, `recall.deduplicated` and `recall.persisted` are emitted
    (`AR/shared.ts:1086-1124`, via `AR/experience.ts:76-78`). `recall.candidate_rejected`,
    `recall.retrieved`, `recall.applied` and `recall.persistence_failed` (`ST:3826-3831`) are declared
    and never emitted, so there is no trace of when recall was actually used in a turn.
- **Required change:** fix independence and the trigger condition before adding new triggers.
  New triggers must be fed by verification results (3.6), not by turn status.
- **Privacy:** scoping is correct. `business_id NOT NULL` with an FK (`088:13-37`) and retrieval
  filters `shopId === businessId` (`AR/experience.ts:81-90`).

### 3.9 Context recipes: PARTIALLY_IMPLEMENTED

- **Source:** `contextRecipeRegistry` (`ABR:284-376`).
- **Existing behavior:** ids and versions exist (all `@1`). The recipe id is recorded only in
  grounding telemetry metadata (`AR/store.ts:2439`) and on experiences.
- **Missing:** reproducibility (see 3.3). There are no recipes for procurement or replenishment.
- **Required change:** persist recipe id + version + source ids per task; add recipes per environment.

### 3.10 Model evaluation across equivalent tasks: MISSING

- **Source:** none. `run-ai-eval.ts` takes one model from env. Template evaluation compares
  template versions, not runtime models, and in production calls no model at all.
- **Required change:** the Phase 8 harness, driving the real `createRuntimeTurn` against a
  fixture business on an isolated database, once per model binding.
- **Constraint:** model calls go through the sanctioned OpenRouter path (see memory
  `openrouter-llm-api-approved`), or local Claude Code per CLAUDE.md for judging.

### 3.11 Environment isolation (tenant): IMPLEMENTED on the main path, with two gaps

- **Source:** principal resolution `requireBrowserAuthorizedSession` (`services/api/src/cp2/store.ts:10546-10571`),
  MCP `requireMcpBusinessAccess` (`:10469-10500`) with token shop binding, `roleCan`
  (`packages/business-core/src/domains/roles.ts:270-272`). Runtime role = invoking user's membership
  role (`services/api/src/cp2/store.ts:10975-10991`). An agent cannot exceed the user: tool gate at
  `AR/store.ts:2568` and every domain method re-checks.
- **No RLS** (grep `ROW LEVEL SECURITY|CREATE POLICY` in migrations: none). Scoping is entirely
  application code.
- **Gap 1, computer runtime direct route:** `/v1/computer/sessions/:id/actions`
  (`cp2/domains/computer-runtime/routes.ts:153-166`) authorizes with `requireAnySession` +
  `requireMembership` only (`computer-runtime/store.ts:505-525`). There is no `roleCan`, though the
  registry says computer tools need `business:write` (`TC/domains/computer.ts:47`). Sessions and
  profiles are bound to the caller's account (`ownedSession`/`ownedProfile`, `computer-runtime/store.ts:511-525`),
  so a member cannot take over someone else's session. The client also chooses `actor`, defaulting
  to `"agent"`. **Latent today:** no deployment injects a computer worker (`services/api/src/index.ts:245-261`,
  `services/api/src/edge-store-dependencies.ts:44-55`; only `cp2/routes.ts:269-282` reads
  `COMPUTER_RUNTIME_URL`, and only when no store is passed), so the store falls back to
  `unavailableComputerWorkerClient` (`services/api/src/cp2/store.ts:1715`) and session creation throws
  `COMPUTER_RUNTIME_PROVIDER_UNCONFIGURED`. Once a worker is wired, a `view_only` or `driver` member
  could create and drive their own business-tagged computer session, which the registry forbids.
  `render.yaml` does deploy a `grogoni-computer-runtime` service, but the API never connects to it:
  the Node API passes its own store into route registration, so `COMPUTER_RUNTIME_URL` is not read.
- **Gap 2, execution events:** the event record has no `businessId` (`runtime-handoff/store.ts:1877-1887`);
  `business_id` is nullable in `087`. Events are not tenant-scoped in the database.
- **Tests:** `tests/business-write-permission.test.ts`, `agent-session-authentication.test.ts`,
  `computer-runtime-security.test.ts` (does not cover the role gap), `edge-scoped-postgres.test.ts`.

### 3.12 Environment versioning: PARTIALLY_IMPLEMENTED

- **Source:** `AgentRuntimeVersion` (`ST:4579-4590`, bumped at `AR/store.ts:534, 629, 902, 1074, 1516, 1581, 1748`);
  model-template versions with gated promote/rollback (`model-templates/store.ts:993-1104`);
  native agent `runtimeContractVersion` checked on binding (`native-runtime/store.ts:622, 782`).
- **Missing:** capability contracts are unversioned (`RuntimeToolDefinition` has no version).
  In-flight work is not pinned: `PendingRuntimeAction` has no version (`AR/shared.ts:122-127`)
  and confirmation runs against the **current** runtime version (`AR/store.ts:2347-2359`).
- **Required change:** pin `environmentVersion` + `runtimeVersion` on the task at creation.

### 3.13 Environment extensibility: MISSING (by design for now)

- **Source:** tools are compiled into `TC/registry/index.ts:24`. The `.grogoni.com` agent manifest
  (`docs/agents/grogoni-agent.schema.json`) and portable agent importer (`AR/portable-agent-importer.ts`)
  cover agents, not environments.
- **Required change:** first-party, code-defined manifests only in this program. External
  environments are out of scope per the brief.

### 3.14 Related primitives (not in the brief's table, needed by later phases)

| Primitive                                | Status  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval binding to exact action + args  | PARTIAL | Runtime token maps by reference to the stored action (`AR/store.ts:2788-2814`), with no hash, no expiry and no durable storage. The get-to-delete window is one microtask for synchronous tools; `messaging.send` and `commerce.checkout` also dedupe on `action.id` keys. A double-submit can execute twice only for a confirmation-gated tool with an async dependency that records no idempotency key before its first await (`messaging.send` is async but records its key first; that leaves `computer.upload`, `TC/domains/computer.ts:89-92`, which has no deployed worker), but the absence of an atomic claim makes that a latent hazard for every async tool added later. Computer approvals do it properly: FNV-1a hash of `{toolName,input}`, 10-min expiry, single use (`TC/computer-policy.ts:39-78`, `computer-runtime/store.ts:527-578`). |
| Confirm path re-checks                   | PARTIAL | Confirm re-runs `roleCan` only, not `enforceAgentPolicy` or entity checks (`AR/store.ts:2815-2837`). It executes as `requireSessionIdForUser` = the user's **most recent** non-revoked session, not the caller's (`AR/store.ts:2906, 3570-3576`), and drops `conversationId`. The caller's own session has already passed the PIN-verified browser gate (`services/api/src/cp2/store.ts:10552`), so this is wrong attribution and a spurious failure when the newest session is expired or unverified, not privilege gain.                                                                                                                                                                                                                                                                                                                                |
| Idempotency on consequential tools       | PARTIAL | Keys only for `messaging.send`, `commerce.checkout` (`runtime-checkout:${action.id}`), `workspace.deliver`, and model-supplied `externalSourceId` on `purchase.record`/`sale.record`/`route.record`. None for product, stock, invoice, payment, logistics. Checkout dedup is an in-memory scan with no DB unique index (`057_buy_checkout.sql`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Resource limits                          | PARTIAL | 1 tool/turn, 20 turns/session, 120s agent timeout, prompt 128 KiB, HTTP 300/min/IP, MCP 120/min/token. Skill `quotaPerHour` is validated, never enforced. `boundModelRuntimeAdapter` (bulkhead + circuit breaker, `services/api/src/inference/model-runtime.ts:397`) has no non-test callers. No lock for turns without `conversationId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Dry-run / simulation mode                | MISSING | grep `dryRun                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | dry_run | simulat | previewOnly`: only the unrelated `simulateFailedPinCheck` (`services/api/src/cp2/store.ts:1072`). `readOnly` on tool definitions is telemetry metadata only (`AR/store.ts:2629`). |
| Telemetry carrying model/latency durably | PARTIAL | Per-turn telemetry is rich (`AR/store.ts:2245-2701`), but durable execution events carry only `{toolName, risk}` from telemetry (`AR/store.ts:2275`) plus `actionId` on the direct writes, never model id, latency or tokens and are written only when `conversationId` is set (`:2266`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Prompt-injection handling                | PARTIAL | System/user separation and tagging (`ABR:219-261`); regex line redaction (`ABR:26-27`). It does not escape `</context>` tag breakout, it redacts the merchant's own legitimate text, and conversation history is not sanitized (`services/api/src/inference/model-runtime.ts:496-531`). Client-authored `author:"agent"` messages are accepted (`messaging/routes.ts:604`) and fed back to the model as `assistant` turns (`messaging/store.ts:3303-3333`).                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 4. Components to reuse (do not rebuild)

| Brief concept                              | Reuse                                                                                                                  | Location                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Capability registry                        | `runtimeToolRegistry`, `RuntimeToolName`                                                                               | `TC/registry/index.ts:24`, `TC/contracts/runtime.ts`                                       |
| Dispatcher                                 | `executeRuntimeCapability`                                                                                             | `AR/capabilities.ts:38`                                                                    |
| Agent runtime / turn                       | `createRuntimeTurn`, `ShopAgentRuntime`                                                                                | `AR/store.ts:2113`, `ST:4561`                                                              |
| Authorization                              | `roleCan`, membership, MCP principal                                                                                   | `packages/business-core/src/domains/roles.ts`, `services/api/src/cp2/store.ts:10469-10591` |
| Policy                                     | `enforceAgentPolicy`                                                                                                   | `ABR:581-625`                                                                              |
| Approval gate                              | `runtimeRequiresConfirmation` + pending action (to be made durable); computer-approval hashing pattern                 | `AR/store.ts:2598-2661`; `TC/computer-policy.ts`                                           |
| Observation                                | `resolveAgentContext`, recipes, grounding                                                                              | `ABR:284-535`                                                                              |
| Experience                                 | `RuntimeExperience` lifecycle and store                                                                                | `AR/experience.ts`, `AR/shared.ts:1038-1127`                                               |
| Evaluation                                 | `cp2_agent_evaluation_events`, report card, template `EvaluationService` matchers                                      | `AR/report-card.ts`, `cp2/domains/evaluation/service.ts`                                   |
| Durable task identity, events, checkpoints | handoff `taskId`, `cp2_runtime_execution_events` (append-only, unique `(task_id, sequence_number)`), `withIdempotency` | `runtime-handoff/store.ts`, migrations `083`, `087`                                        |
| Transactional idempotency                  | `runIdempotent` + `fulfillment_idempotency_records`                                                                    | `fulfillment/transaction.ts:133-183`, `090:113`                                            |
| Model selection                            | `NativeRuntimeBindingStore` (single source of binding truth)                                                           | `native-runtime/store.ts:503-596`                                                          |
| Real-DB test lane                          | `pnpm test:postgres` (`scripts/run-postgres-tests.mjs`, env `CP2_POSTGRES_TEST_DATABASE_URL`), CI Postgres service     | `.github/workflows/ci.yml:12-60`                                                           |

---

## 5. Duplication audit

| Candidate                                                                                                                                                                                           | Verdict                            | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool registries: `runtimeToolRegistry` vs `fulfillmentMcpTools` (43 tools, `services/api/src/mcp/fulfillment-tools.ts:172`)                                                                         | DUPLICATED (legitimate target)     | Fulfillment is Postgres-native with its own retry contracts and is exposed only over MCP. No agent-runtime capability reaches it. An environment for logistics would need these routed through the canonical registry first.                                                                                                                                                                                                                                        |
| Dispatchers: canonical vs MCP direct tools (`send_message`, `prepare/confirm_checkout`, handoff tools, `services/api/src/mcp/routes.ts:610-798`)                                                    | DUPLICATED                         | MCP checkout has its own in-memory `pendingCheckouts` confirmation (10-min expiry) separate from runtime confirmation. Same operation, two approval systems.                                                                                                                                                                                                                                                                                                        |
| Dispatchers: canonical vs computer-runtime HTTP (`computer-runtime/routes.ts:153-166`)                                                                                                              | DUPLICATED, with a security gap    | See 3.11 Gap 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Customer catalogue turn (`createCustomerCatalogueRuntimeTurn`, `AR/store.ts:1952`)                                                                                                                  | Legitimate                         | Public storefront, hard-coded `view_only`, `products.list` only.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Offline `LocalProvider` executor (`packages/offline-runtime/providers/local-provider.ts:45-59`)                                                                                                     | Legitimate target                  | Executes user-initiated offline mutations, not agent actions. `registerLocalHandoffHost` has no callers (dead).                                                                                                                                                                                                                                                                                                                                                     |
| Planners: `AR/planning.ts`, `AR/offline-order-planning.ts`, `packages/execution-planner`                                                                                                            | Not duplicates; last is DEPRECATED | `planning.ts` = deterministic single-tool proposers. `offline-order-planning.ts` = SMS order text parser. `execution-planner` = untracked `dist/` of the retired Execution Fabric (commit `2424644f`), no importers. Should be deleted from disk.                                                                                                                                                                                                                   |
| Model catalogs (8 sources: `aiModelRegistry`, `inferenceRouterSeedModels`, `cp2_model_catalog`, `runtimeModels`, Ollama live, GitHub/HF catalogs, `cp2_native_runtime_models`, `OPENROUTER_MODELS`) | DUPLICATED (catalog layer only)    | Binding resolution is single-sourced (`NativeRuntimeBindingStore`). Catalog merging is layered and confusing but not on the environment critical path. Out of scope.                                                                                                                                                                                                                                                                                                |
| Frontend owner-node inference (`apps/web/src/hooks/useChatRuntimeState.ts:533-606`)                                                                                                                 | Legitimate (text only)             | Picks its own model and bypasses binding resolution, but only when no server tool is needed and it executes nothing.                                                                                                                                                                                                                                                                                                                                                |
| Experience stores: `RuntimeExperience` vs `agentOwnerCorrections`                                                                                                                                   | Not duplicates                     | Corrections are owner-authored; experiences are system-derived.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Dead or retired infra still in code                                                                                                                                                                 | DEPRECATED                         | ZeroClaw ids/env (`services/api/src/agent-harness/retired-agent-runtimes.ts:8-16`, `services/api/src/config.ts:92-94`), `apps/web/src/inference/local-inference-response.ts` (imported only by `tests/ai-providers-panel.test.tsx`), `createAgentRuntimeDecision` (`apps/web/src/agent-command-engine.ts:81`, never called), stale "Luna retired" comment (`AR/model-catalog.ts:80-85`), "local-only, no API keys" comment (`inference-providers/routes.ts:17-18`). |

---

## 6. Persistence audit

### 6.1 Classification

| Class                            | Examples                                                                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Memory only, never persisted | `pendingRuntimeActions` (`AR/store.ts:284`); offline order-intent replay cache (`services/api/src/cp2/offline-runtime.ts:28, 114-122`); Node-mode MCP sessions, `pendingCheckouts`, OAuth codes (`services/api/src/mcp/routes.ts:41-49`); turn locks |
| (b) Async (Node snapshot Proxy)  | Every listed method: `adjustProductStock`, `createPurchase`, `createSale`, `createInvoice`, `confirmInvoice`, `recordPayment`, `createSupplier`, `createRuntimeTurn`, handoff ops                                                                    |
| (c) Sync before response         | All Edge routes; fulfillment ops; daemon enqueue/claim/settle                                                                                                                                                                                        |
| (d) DB transaction               | Snapshot save (`postgres-store.ts:2755-2779`, advisory lock); fulfillment (`transaction.ts:60-64`, retries on 40001/40P01/55P03); Edge request; daemon claim CTE                                                                                     |
| (e) DB-enforced idempotency      | Fulfillment `runIdempotent`, outbox `(business_id, event_key)`, order intake `(business_id, invoice_id)`, daemon `idempotency_key`, execution events `(task_id, sequence_number)`                                                                    |
| (e') Memory-only "idempotency"   | Unified checkout key scan, `createSale` `externalSourceId` scan, message `messageByClientId` (the unique index in `031` is on the legacy table the store no longer writes)                                                                           |

### 6.2 Where success is acknowledged before durability (Node mode)

1. **Flush deadline fallthrough.** Non-GET responses await `flush()` for 8s
   (`services/api/src/app.ts:633-668`). On timeout, `/sync/push` and `/sync/order-intents` fails and `/v1/runtime/*` returns 503
   `RUNTIME_PERSISTENCE_PENDING`. **Every other route, including `/businesses/:id/runtime/turns`,
   returns the success payload anyway** (`app.ts:236-258`). The runtime-turn route is not under `/v1/runtime/`.
2. **Unlisted mutating methods.** The Proxy queues a save only for names in `mutatingMethodNames`.
   Route-reachable mutations missing from it: `createUnifiedCheckout` (`/buy/checkout`),
   `pushOfflineOrderIntents` (`/sync/order-intents`), `createStatusBroadcast`,
   `recordStatusBroadcastReply`, `createProductCaptureJob`, `confirmProductCaptureJob`,
   `createRuntimeTurnForMcp` (MCP `runtime_turn` **and** `confirm_runtime_action`),
   `createCheckoutForMcp`, `sendMessageForMcp`, `cancelRuntimeExecution`, `recordMessageHandoff`,
   `performComputerAction`, `decideComputerApproval`, `claim/completeDeviceInferenceJob`,
   `createPassword`, `changeAccountPin`, `renameGrogoniId`, `deliverFulfillmentNotification`,
   `purgeExpiredRuntimeExperiences` (runner only, not route-reachable). Their own request never queues a save; their writes reach
   Postgres when a later save snapshots them. On Render that is bounded at about 60s by the
   notification delivery runner (on unless `ENABLE_NOTIFICATION_DELIVERY_RUNNER=false`,
   `services/api/src/index.ts:441-452`; interval `cp2/notification-delivery-runner.ts:4`), which calls
   the listed `deliverPendingMessageNotifications` (`postgres-store.ts:316`), or sooner by any other
   listed mutation. `tests/postgres-persistence-boundary.test.ts:5-35` asserts a fixed list of
   22 names is present, but nothing checks that every mutating method is listed.
3. **Fire-and-forget side effects:** fulfillment intake `queueMicrotask` (`services/api/src/cp2/store.ts:4891-4918`,
   with a reconciler backstop), SMS replies `.catch(() => undefined)` (`messaging/store.ts:1331-1380`),
   push via `setImmediate` (`services/api/src/cp2/store.ts:12385`).
4. **Cross-store ordering:** the fulfillment outbox commits `delivered_at` in Postgres
   (`fulfillment/service.ts:964-971`) while the message it delivered sits in memory unsaved (row 2).
5. **Sync journal** is written in a second transaction after the business commit; its failure is
   returned, not thrown (`postgres-store.ts:2800-2808`).

### 6.3 Edge-mode consequence for the agent runtime (primary deployment)

`registerCp2Routes` (which includes the agent-runtime routes) is mounted per request on a fresh
store (`edge-domain-routes.ts:103, 209`), hydrated from `loadTransactionalCp2Snapshot`.
`pendingRuntimeActions` is referenced only by purge paths (`services/api/src/cp2/store.ts:11904, 12208`)
and never by `snapshot()` or `hydrateSnapshot()`; only MCP maps are persisted to
`cp2_edge_protocol_state` (`edge-domain-routes.ts:285-298`). So a `confirmationToken` minted on
request N is absent on request N+1 and the confirm fails with `runtime_confirmation_not_found`
(`AR/store.ts:2790-2795`). This follows directly from the code. It was not executed end to end:
`tests/edge-runtime-postgres.test.ts` covers jobs and rate limits only, and no test drives a runtime
confirmation through Edge. That regression test is the first item of Phase 0.5.

### 6.4 Verified against real Postgres

Environment: throwaway `postgres:16-alpine` container, all 115 migrations, `tests/cp2-postgres-store.test.ts`.
`DATABASE_URL` from `.env` was not used.

- Baseline: `tests/cp2-postgres-store.test.ts`: **59/59 pass**, including
  "persists status broadcasts and unified checkout orders … across store restarts".
- Probe 1 (temporary copy of that test, deleted afterwards), row count in `unified_checkouts` for
  the new checkout: `{"immediately":0,"afterFlush":1}`. It persisted, but only after the response.
- Probe 2, same, with the save queue drained before the checkout:
  `{"immediately":0,"afterFlush":0,"after5s":0}`. After restart the test's own assertion fails
  (`expected [] to deeply equal ArrayContaining{…}`).

Conclusion: `/buy/checkout` orders are not persisted by their own request. The existing test passes
only because a save queued by an earlier request in the same test captures the in-memory state.
The probe ran without the background runners. In the deployed Render process the notification
runner saves within about 60s (6.2 item 2), so the loss window is a crash or a graceful redeploy
(`close()` re-saves only after a recorded failure, `postgres-store.ts:945-968`) inside that minute.
Render auto-deploys on commits to `main` that touch its `buildFilter` paths (nearly all API work), so the window recurs on every API deploy; actual loss frequency has not been measured. MCP
`runtime_turn`/`confirm_runtime_action` are not reliably saved by their own request either: every MCP
POST calls the listed `authenticateMcpAccessToken` (`mcp/routes.ts:149`), but that save can take its
snapshot before the turn's awaited model call finishes, so whether it captures the turn is a race. Edge commits inside the
request transaction and is not affected. Probe outputs: `/tmp/business-env-audit/probes/README.md`.

---

## 7. Acceptance-scenario feasibility (KES 15,000 replenishment)

| Step                              | Status      | Evidence                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Resolve environment             | MISSING     | No registry (3.1).                                                                                                                                                                                                                                                                                                                                           |
| 2 Verify permissions              | IMPLEMENTED | `roleCan` + domain re-checks.                                                                                                                                                                                                                                                                                                                                |
| 3 Compile structured task         | MISSING     | One proposal per turn (3.4, 3.5).                                                                                                                                                                                                                                                                                                                            |
| 4 Inventory + sales data          | PARTIAL     | `products.list`, `reports.summary`, `invoices.list`. The inventory movement ledger (`cp2_inventory_movements`) is not exposed as a capability. `sales.history` filters by customer only (`commercial-records/store.ts:981-1002`), and SaleRecords are only created by `sale.record` or its HTTP route (`commercial-records/routes.ts:222`), not by invoices. |
| 5 Stockout risk (3 days)          | MISSING     | Grep `stockout                                                                                                                                                                                                                                                                                                                                               | velocity      | days_of_cover           | forecast | replenish | reorder`: none in domain code. Only low-stock rule is `quantity <= 2` (`services/api/src/cp2/store.ts:11428`). |
| 6 Supplier information            | PARTIAL     | No `suppliers.list` capability. `SupplierSummary` has no products or prices (`ST:2114-2128`). Supplier-specific prices exist only as history (`purchase.history`; `listPurchasePriceHistory` is HTTP-only). Grep `supplierProduct                                                                                                                            | supplierPrice | supplierCatalog`: none. |
| 7 Purchase recommendations        | MISSING     | Deterministic work with no code (CLAUDE.md: script, not model arithmetic).                                                                                                                                                                                                                                                                                   |
| 8 Budget + quantity validation    | MISSING     | Grep `budget` hits only discovery, phonebook, inference, context character, HTTP latency and DB pool budgets; no purchase or spend budget. `roundMoney` exists twice (`packages/business-core/src/shared/money.ts`, not exported; `services/api/src/cp2/money.ts:6`). No money/currency value type for business amounts.                                     |
| 9 Prepare purchase orders         | MISSING     | Grep `purchase_?order` (case-insensitive) across `services/api/src`, `packages/*/src`, `apps/web/src`: **0 hits**. `purchase.record` records a completed purchase and does not add stock (`commercial-records/store.ts:746-870`). `commerce.checkout` buys from GroGoni storefronts, has no budget and no link to local suppliers.                           |
| 10 Approval before submission     | PARTIAL     | Per-action token exists. No batch approval of a multi-line plan, no expiry, not durable (3.14, 6.3).                                                                                                                                                                                                                                                         |
| 11 Verify resulting records       | MISSING     | 3.6.                                                                                                                                                                                                                                                                                                                                                         |
| 12 Persist execution + evaluation | PARTIAL     | Turns persist async; evaluation events record the wrong model (3.7).                                                                                                                                                                                                                                                                                         |
| 13 Record experiences             | PARTIAL     | Only the fallback trigger, with defects (3.8).                                                                                                                                                                                                                                                                                                               |
| 14 Present in chat                | PARTIAL     | Plain "Confirm" button only (`apps/web/src/ChatSurface.tsx:834-843`), no reject, no argument display, no tool-call card. Result cards are posted by the client as `author:"agent"` messages (`useChatRuntimeState.ts:799-876`).                                                                                                                              |

Also relevant: `product.stock_adjust` runs **without confirmation**, treats `quantity` as absolute
although its schema says "New quantity or quantity delta" (`TC/domains/products.ts:64-81`,
`AR/capabilities.ts:186-190`), and has no idempotency key. A single "increase X by 10" sets stock
to 10, even though validation prompts for a "quantity change" (`packages/tool-core/src/validation/runtime.ts:324`).

Conclusion: steps 5, 7, 8 and 9 need a **procurement domain** that doesn't exist. That's new
business capability, not environment plumbing (Decision D2).

---

## 8. Security risks (ranked)

| #   | Severity     | Risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                                 |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S2  | Medium       | Confirm path executes under the user's most recent session, not the caller's (wrong audit attribution; confirm fails if that newest session is expired or not PIN-verified), and skips `enforceAgentPolicy`, so a policy tightened between proposal and confirm is not applied. The caller itself is PIN-gated first (`services/api/src/cp2/store.ts:10552`), so no privilege gain was found. On an MCP confirm, non-MCP-aware deps such as `createUnifiedCheckout` (`requirePinVerifiedSession`, `commerce/store.ts:1021`) run under the user's newest browser session, so an MCP confirm can complete a `commerce.checkout` the MCP auto-execute path could not | `AR/store.ts:2815-2837, 2906, 3570-3576`                                 |
| S3  | Medium       | Confirmation tokens never expire and are not durable; no atomic claim, so double execution becomes possible for any async confirmation-gated tool (latent: the only one, `computer.upload`, has no deployed worker) since the web client confirms without `conversationId` and gets no lock (`useChatRuntimeState.ts:1382`)                                                                                                                                                                                                                                                                                                                                       | `AR/store.ts:2788-2943`                                                  |
| S4  | Medium       | Write tools gated by `business:read`: `commerce.checkout`, `network.route`, `workspace.deliver`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `TC/domains/commerce.ts:26-27`, `network.ts:13-14`, `workspace.ts:11-12` |
| S5  | Medium       | `product.stock_adjust` auto-executes with absolute semantics and no idempotency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | section 7                                                                |
| S6  | Medium       | Prompt injection: tag breakout not escaped; history unsanitized; client-authored agent messages become `assistant` history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 3.14                                                                     |
| S7  | Medium       | Unknown-intent model text returned verbatim as `completed`; only a prompt rule prevents false "done" claims                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 3.6                                                                      |
| S8  | Medium       | Experience promotion from non-independent repeats; recall can carry false lessons into every later prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 3.8                                                                      |
| S1  | Low (latent) | Computer runtime direct route skips `roleCan`. No computer worker is deployed today, so nothing is reachable; once one is wired, a `view_only`/`driver` member could create and drive their own business-tagged browser session (account binding prevents takeover of others'). Client chooses `actor`                                                                                                                                                                                                                                                                                                                                                            | 3.11 Gap 1                                                               |
| S9  | Low          | Execution events have no `business_id`; no RLS anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 3.11 Gap 2                                                               |
| S10 | Low          | Skill `quotaPerHour`, `binding.permissions` validated but not enforced; no live bulkhead on inference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 3.14                                                                     |

## 9. Persistence risks (ranked)

| #   | Severity                | Risk                                                                                                                                                                                                                                                                                                                                                                                                 | Evidence                                                 |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| P2  | High (availability)     | Confirmations cannot be redeemed on Edge, the primary deployment (token never survives the request), and are lost on restart on Render                                                                                                                                                                                                                                                               | 6.3                                                      |
| P1  | High (Render path only) | Unlisted mutating methods (checkout, order intents) are acknowledged before any save is queued, and MCP runtime turns only with a racy save; a crash or redeploy within about 60s loses them                                                                                                                                                                                                         | 6.2 item 2, proven in 6.4                                |
| P3  | High                    | Offline order-intent (and Telegram channel order, `createChannelOrder`, `services/api/src/cp2/store.ts:7221-7263`) replay cache in memory only: in Node mode a device retry after a restart can duplicate an invoice; on Edge the cache is rebuilt per request (`edge-domain-routes.ts:103`), so any retry after a committed response that never reached the device duplicates it, no restart needed | `services/api/src/cp2/offline-runtime.ts:28-30, 114-122` |
| P4  | Medium                  | 8s flush deadline returns success for runtime turns and every non-`/v1/runtime` route                                                                                                                                                                                                                                                                                                                | 6.2 item 1                                               |
| P5  | Medium                  | Memory-only idempotency for checkout, sales, messages                                                                                                                                                                                                                                                                                                                                                | 6.1 (e')                                                 |
| P6  | Low                     | Outbox/message ordering; sync journal in a second transaction                                                                                                                                                                                                                                                                                                                                        | 6.2 items 4-5                                            |

Rule for every later phase: **environment task state is Postgres-native and written in an awaited
transaction**, following the fulfillment and daemon pattern, never the snapshot Proxy. That holds
identically in Node and Edge modes and makes "completed only after durable" enforceable.

---

## 10. Decisions needed from Julien before Phase 1

**D1. Multi-step execution.** The runtime is one-tool-per-turn.

- (a) _Recommended:_ add a bounded step loop inside the existing turn pipeline. Each step goes
  through steps 8-14 of section 2.1 unchanged; the loop pauses (durably) at each confirmation.
  No new planner package. The plan is produced by the model and validated deterministically
  against the environment's allowed capabilities.
- (b) Deterministic environment "recipes" (fixed step graphs per task type, model only fills
  arguments). More predictable and cheaper, but less general.
- (c) Keep single-step turns and chain them via chat. No new code, but no task-level verification
  or evaluation is possible.

**D2. Procurement domain.** The acceptance scenario needs purchase orders, supplier prices, a
stockout forecast and budget allocation, none of which exist.

- (a) _Recommended:_ a new `procurement` CP2 domain, **Postgres-native** (fulfillment pattern):
  `purchase_orders` (draft → approved → submitted → received → cancelled) + lines + a
  supplier price list, with deterministic forecast and budget-allocation functions in
  `packages/business-core` and tests. Receiving a PO posts an inventory movement.
- (b) Model it on top of `purchase.record` + `commerce.checkout`. Less code, but there's no draft
  state and no budget, and it inherits P1.
- (c) Drop procurement from the acceptance scenario and use an inventory-only scenario
  (stock count reconciliation) for the first environment.

**D3. Fix-first scope.** In order of real traffic: P2 (Edge confirmations), P3 (order-intent replay),
P1 (Render path), then S2-S3 (Medium). S1 is latent hardening that must land before any computer
worker is deployed. These affect production today, independent of environments.

- (a) _Recommended:_ a "Phase 0.5" hardening change before Phase 1: durable, expiring,
  hash-bound, atomically claimed confirmations; computer route `roleCan`; confirm-path session and
  policy fixes; `mutatingMethodNames` coverage test + the missing names; experience independence.
- (b) Fold each fix into the phase that first depends on it.

**D4. Confirm the deployment picture.** The repo says Supabase Edge serves `grogoni.com` and
Render is a legacy alias (section 2.2). Does Render still receive meaningful traffic? If not,
P1 can be deferred and Phase 1+ integration tests target Edge only.

---

## 11. Proposed implementation plan (pending D1-D4)

| Phase        | Smallest change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Main files                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 0.5 (if D3a) | First, an Edge regression test that proposes then confirms a gated action across two requests (fails on HEAD). Then: durable confirmations table (`runtime_pending_actions`: token hash, action hash, actor, session, expires_at, claimed_at) with atomic claim; computer route `roleCan`; confirm path uses caller session + re-runs policy; `mutatingMethodNames` coverage test; durable order-intent replay keys (P3); experience independence + trigger fix; eval event records actual model | `AR/store.ts`, `AR/shared.ts`, `postgres-store.ts`, `computer-runtime/store.ts`, new migration `113_*` |
| 1            | `BusinessEnvironmentManifest` + state machine (pure, deterministic transition table) in `packages/shared-types` + `packages/tool-core/src/environments/`                                                                                                                                                                                                                                                                                                                                         | new files; `TC/registry/index.ts`                                                                      |
| 2            | `business_tasks` table (Postgres-native, keyed to handoff `taskId`, pinned versions); task compiler validates model-proposed plans against manifest                                                                                                                                                                                                                                                                                                                                              | new migration; new `AR/environment-*.ts`                                                               |
| 3            | Step loop (D1) + observation provenance persisted; idempotency key per step = `task:step`                                                                                                                                                                                                                                                                                                                                                                                                        | `AR/store.ts`, `AR/capabilities.ts` (keys only)                                                        |
| 4            | Post-dispatch verification via domain read path, six check categories                                                                                                                                                                                                                                                                                                                                                                                                                            | `AR/shared.ts` (`RuntimeVerification` extension)                                                       |
| 5            | Task evaluation record + per-environment metric definitions                                                                                                                                                                                                                                                                                                                                                                                                                                      | reuse `cp2_agent_evaluation_events`                                                                    |
| 6            | Experience triggers fed by verification                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `AR/experience.ts`, `AR/shared.ts`                                                                     |
| 7            | Register `grogoni.retail.inventory@1` as ACTIVE; others DRAFT until their contracts exist                                                                                                                                                                                                                                                                                                                                                                                                        | `TC/environments/`                                                                                     |
| 8            | Benchmark harness on isolated DB, real `createRuntimeTurn`, ≥2 bindings via OpenRouter                                                                                                                                                                                                                                                                                                                                                                                                           | `scripts/`, `tests/environments/`                                                                      |
| 9            | Execution card in chat using `generated-surface-registry.tsx`; reject button; argument display                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/web/src/`                                                                                        |
| 10           | Invariant suite (authz, isolation, approval binding, replay safety)                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/`                                                                                               |

**Migrations expected:** pending actions (0.5), business tasks + steps + verifications +
evaluations (2-5), procurement tables (D2a), `business_id` backfill on execution events (S9).
Each one additive; no destructive change to existing tables.

**Test requirements:** every phase adds gate tests (deterministic, <2s) and, where state is
persisted, `CP2_POSTGRES_TEST_DATABASE_URL` tests in the `pnpm test:postgres` lane. Regression tests
to write first, each failing on current HEAD: the drained-queue checkout probe (6.4), confirmation
double-submit, confirmation across Edge requests, `view_only` computer action (needs an injected fake worker, since none is deployed), experience promotion
from identical repeats, `stock_adjust` delta semantics.

---

## 12. Doc vs code drift found

| Doc                                                                          | Claim                                                                            | Code                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture/experience-memory.md:18-19, 60-64`                        | trigger is "the primary model failed and an authorized fallback model completed" | also fires when routing simply picks a `role === "fallback"` binding model (`AR/native-runtime-routing.ts:110-115`) and never checks the fallback's own status. The "independent corroborations" claim is in the code comment `AR/experience.ts:32`, not the doc |
| `docs/architecture/runtime-evaluation.md:67`                                 | nightly AI eval                                                                  | `ai-eval.yml` is `workflow_dispatch` only                                                                                                                                                                                                                        |
| `docs/architecture/model-template-evaluation.md`                             | does not state which executor runs in production (reads as model evaluation)     | default executor is keyword matching, no model (`model-templates/store.ts:453`)                                                                                                                                                                                  |
| `docs/architecture/context-recipes.md:14`                                    | `intentContextTypes`                                                             | no longer exists                                                                                                                                                                                                                                                 |
| `docs/architecture/durable-execution-audit.md` §1                            | "every surface converges" on one pipeline                                        | MCP checkout, fulfillment MCP tools and computer HTTP route do not                                                                                                                                                                                               |
| `AR/model-catalog.ts:80-85` (comment)                                        | Luna retired                                                                     | Luna is the platform default                                                                                                                                                                                                                                     |
| `services/api/src/cp2/domains/inference-providers/routes.ts:17-18` (comment) | local-only, no API keys                                                          | OpenRouter server key path is live                                                                                                                                                                                                                               |
| Brief §3                                                                     | `docs/architecture/runtime-handoff.md`                                           | actual file is `docs/runtime/runtime-handoff.md`                                                                                                                                                                                                                 |
| `render.yaml:30-35` vs `docs/deployment/supabase-edge-api.md:23-24`          | both claim `grogoni.com`                                                         | DNS attachment per the newer deploy doc (commit `8c886555`) is Vercel → Edge                                                                                                                                                                                     |

---

## 13. Gate status at audit time (baseline on HEAD `84060f77`)

This audit changed no application code. Baseline gates were run on the working tree so later
phases can tell pre-existing failures from regressions:

| Gate                                                        | Result                                                                                                               | Time |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---- |
| `pnpm typecheck`                                            | pass                                                                                                                 | 58s  |
| `pnpm check:boundaries`                                     | pass                                                                                                                 | 1s   |
| `pnpm check:api-routes`                                     | pass                                                                                                                 | 9s   |
| `pnpm test`                                                 | pass: 360 files, 2346 tests passed, 190 skipped (Postgres-gated tests skip without `CP2_POSTGRES_TEST_DATABASE_URL`) | 304s |
| `tests/cp2-postgres-store.test.ts` on throwaway Postgres 16 | pass: 59/59                                                                                                          | 72s  |

`pnpm build` was not run: it is a deploy-time step and nothing here changes build inputs.
Skipped tests are not counted as verification. Gate logs: `/tmp/business-env-audit/gates/`. Postgres
run and probe outputs: `/tmp/business-env-audit/probes/README.md`.
