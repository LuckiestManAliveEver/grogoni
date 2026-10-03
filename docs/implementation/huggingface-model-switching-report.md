# Implementation report: Hugging Face inference and dynamic model switching

Date: 2026-09-24. Companion docs: `docs/architecture/huggingface-model-switching-audit.md` (what
existed before this work), `docs/architecture/huggingface-inference.md` (how the result works),
`docs/architecture/task-based-model-routing-proposal.md` (the one follow-up item scoped but not built).

## 0. Follow-up round: closing the three named gaps

The first pass of this feature (commit `1786fd6`) reported `DONE_WITH_CONCERNS` with three named
gaps. Asked explicitly to act on all three, this round:

1. **Wired the BYO Hugging Face credential into a live chat turn** (previously "plumbing built,
   not connected"). `AgentRuntimeStore.createRuntimeModelRoute` already threaded the calling
   `accountId` all the way to `resolveRuntimeModelProvider`; the missing piece was
   `resolveNativeRuntimeModelProvider` (`native-runtime-routing.ts`) actually consulting it. Fixed by
   adding `resolveOwnAccountCredential`, which reads a billing-mode preference off the **native
   runtime binding** (not the model row — see §4/the architecture doc for why the model row is the
   wrong place, a real design error caught and corrected during this round) and calls a synchronous
   injected credential resolver (`ExternalConnectionsDomain.resolveInferenceToken` is plain AES-GCM
   decryption, no I/O — the resolver's deliberate purity needed no compromise). Added the missing
   write path, `POST /api/agents/:agentId/model-binding/billing-mode`, which refuses to accept
   `"own-account"` on trust and requires a real, already-authorized connection first. Full unit +
   integration test coverage; see §11.
2. **Added the dedicated `AgentModelPanel.tsx` test file** that was named as missing. Covers confirm,
   cancel, and default-skips-confirmation, mirroring `QuickRuntimeSwitcher.tsx`'s coverage.
3. **Scoped (not built) task-based automatic model routing** in
   `docs/architecture/task-based-model-routing-proposal.md`, per the explicit "scope, don't build"
   instruction — it names a concrete recommended design, three open questions that need Julien's
   answer before building (route-key space, per-business vs. platform-default routes, cost-acceptance
   interaction), and an effort estimate. Not implemented, and the doc says so plainly.

A genuine bug was found and fixed while doing (1): the first pass's own architecture doc had proposed
storing the billing-mode preference on `NativeRuntimeModelSummary.configuration` — but that row is a
single shared catalog entry per model id, reused by every business that activates that model. Setting
it there would have leaked one business's "bill my own account" choice onto every other business using
the same model the moment more than one did. Caught before any code shipped it; the preference lives
on the binding instead, which is genuinely scoped to one (business, account, agent) triple.

## 1. Repository components reused (not rebuilt)

- Native runtime binding graph and its resolver (`NativeRuntimeBindingStore.resolveRuntimeBinding`,
  `services/api/src/cp2/domains/native-runtime/store.ts`) — the model-selection hierarchy the task
  asked for already existed here.
- Atomic model activation (`activateAgentModel`, `services/api/src/cp2/domains/agent-runtime/store.ts:653`)
  — per-agent activation lock, health-check-before-commit, audit trail, and the existing
  `CUSTOM_MODEL_COST_ACCEPTANCE_REQUIRED` cost-acceptance gate were reused unmodified.
- `ModelRuntimeAdapter` interface and `createVercelModelAdapter`
  (`services/api/src/inference/model-runtime.ts`) — extended with a `requiresArtifact` flag rather
  than replaced.
- Hugging Face inference call implementation (`services/ai-runtime/src/huggingface-runtime.ts`) —
  streaming, token usage, error mapping all reused; only the 402 case was added.
- `ExternalConnectionsDomain` (`services/api/src/cp2/domains/external-connections/`) — encrypted
  token storage, provider validation, and revocation reused as-is; extended with one new field and
  one new method for inference-billing authorization.
- Context/token budgeting (`contextCharacterBudgetForModel`), conversation persistence
  (`conversations`/`conversation_messages`), runtime handoff (`/v1/runtime/:taskId/swaps/model`), and
  the tool-authorization boundary (`packages/tool-core`) — all reused with zero code changes.
- `QuickRuntimeSwitcher.tsx` / `AgentModelPanel.tsx` — the existing model-switcher UI surfaces, both
  extended (cost confirmation added, provider/billing display added) rather than replaced.

## 2. Files created or modified

**New:**

- `docs/architecture/huggingface-model-switching-audit.md`
- `docs/architecture/huggingface-inference.md`
- `docs/implementation/huggingface-model-switching-report.md` (this file)
- `infra/db/migrations/097_external_connection_inference_authorization.sql` +
  `infra/db/rollbacks/097_external_connection_inference_authorization.down.sql`

**Modified:**

- `packages/shared-types/src/index.ts` — `RuntimeModelDefinition.requiresArtifact`, `qwen3-4b` entry
  in `runtimeModels`, `AiModelSummary.canonicalModelId`/`supportsToolCalling`/`supportsStructuredOutput`,
  `InferenceExecutionRequest.artifact` made optional + `providerCredential` added, `ModelRuntimeContext`
  (in `services/api/src/inference/model-runtime.ts`) gains `providerCredential`; fixed two stale
  doc-comments referencing deleted `openai-provider.ts`/`cloud-fallback.ts` files.
- `packages/shared-types/src/runtime-registry.ts` — `ExternalRegistryConnection.inferenceAuthorized`.
- `services/ai-runtime/src/vercel-handler.ts` — `resolveInferenceEngine()` (new, exported, unit
  tested), hybrid per-model routing, optional artifact, `providerCredential` passthrough,
  `HF_FREE_TIER_ONLY` config + process-lifetime budget latch, corrected ready-handler capability
  reporting.
- `services/ai-runtime/src/huggingface-runtime.ts` — HTTP 402 → `INFERENCE_BUDGET_EXHAUSTED`
  classification.
- `services/api/src/inference/model-runtime.ts` — `createVercelModelAdapter` gains `requiresArtifact`
  and credential passthrough; provider identity now `"remote-chat-completions"` for artifact-free
  models instead of the misleading hardcoded `"llama.cpp"`.
- `services/api/src/index.ts` — passes `requiresArtifact` from the registry into the adapter factory.
- `services/api/src/cp2/domains/agent-runtime/model-catalog.ts` — `qwen3-4b` catalog entry.
- `services/api/src/cp2/domains/external-connections/{store,shared,routes}.ts`,
  `services/api/src/cp2/{store,postgres-store}.ts` — `inferenceAuthorized` field end-to-end (in-memory
  store, Postgres load/save, view projection), `authorizeInference()`/`resolveInferenceToken()`
  domain methods, `POST /v1/external-connections/:id/inference-authorization` route.
- `apps/web/src/QuickRuntimeSwitcher.tsx` — merchant-funded-model cost confirmation gate, provider/
  billing display.
- `apps/web/src/AgentModelPanel.tsx` — the same cost-confirmation gate applied to its independent
  activation call site (same pre-existing gap, same fix).
- `.env.example`, `services/ai-runtime/.env.example` — documented the new/changed variables.
- `docs/architecture/swappable-agent-model-runtime.md` — corrected a stale execution-target enum
  found during the audit.
- Tests: `services/api/src/inference/model-runtime.test.ts`, `tests/vercel-inference-service.test.ts`,
  `tests/external-connections.test.ts`, `tests/quick-runtime-switcher.test.tsx`,
  `tests/platform-catalog.test.ts` (updated pinned catalog list).

## 3. Database changes

One additive migration: `097_external_connection_inference_authorization.sql` adds
`inference_authorized boolean not null default false` to `cp2_external_registry_connections`. No
existing table was dropped, renamed, or had a column removed. No user, conversation, model binding,
or runtime-handoff data is touched. Rollback (`097_..._down.sql`) drops the column. No model catalog
migration was needed — `runtimeModels`/`aiModelRegistry` are code, not tables.

## 4. Model registry changes

`qwen3-4b` registered in both `runtimeModels` (gets a live adapter at boot) and `aiModelRegistry`
(catalog-visible, activatable), `enabled: true`, `recommended: true`, `requiresArtifact: false`,
`canonicalModelId: "Qwen/Qwen3-4B"`, `contextWindow: 32_768`. Not registered: `SmolLM3-3B`,
`SmolLM2-1.7B-Instruct` — live-verified as **not currently available** through HF's shared Inference
Providers API (empty `inferenceProviderMapping`, checked 2026-09-24), matching the task brief's own
warning against registering a Hub repository as inference-capable without hosted-provider
verification.

## 5. Hugging Face connectivity status

**Live-verified against the real Hugging Face API** (`GET
https://huggingface.co/api/models/{id}?expand=inferenceProviderMapping`, 2026-09-24, no token
required for this public read):

| Model                                 | Result                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Qwen/Qwen3-4B`                       | **Live** — `inferenceProviderMapping: {"featherless-ai": {"status": "live", "task": "conversational"}}`. |
| `HuggingFaceTB/SmolLM3-3B`            | Not live — empty mapping.                                                                                |
| `HuggingFaceTB/SmolLM2-1.7B-Instruct` | Not live — empty mapping, despite being `.env.example`'s own pre-existing `HF_MODEL_MAP` example value.  |

**Not independently verified in this session**: an actual authenticated chat-completions round trip
against `router.huggingface.co` with a real `HF_TOKEN` — no token was available in this environment,
and the task brief explicitly prohibits running billable integration tests without authorization. The
opt-in integration-test pattern already exists in this repo's conventions (mocked unit tests here;
`tests/live-render-model-runtime.test.ts` gated behind `RUN_LIVE_MODEL_RUNTIME_TEST=true` is the
established precedent for this kind of real-provider check) — a live Qwen3-4B round trip should be
run manually once an HF token is available, following that same opt-in pattern, before relying on it
in production.

## 6. Free-tier and billing restrictions

Documented in full in `docs/architecture/huggingface-inference.md` §7. Summary: HF free accounts get
$0.10/month credit (verified against HF's own pricing docs); this repository adds an application-side
`HF_FREE_TIER_ONLY` latch that stops after one confirmed HTTP 402, but this is **not** a substitute
for a provider-side spending cap, which only the administrator can set in the HF billing dashboard.
This limitation is stated in the code's own doc comments, not just here.

## 7. Model-switching behavior

- Selection persists server-side via the existing native-runtime-binding graph — the frontend never
  reports success optimistically; `QuickRuntimeSwitcher`/`AgentModelPanel` only update local state
  from the confirmed `AgentModelActivationResult` response.
- A merchant-funded model (anything but the platform-included `smollm2-360m`) now requires explicit
  confirmation before the activation request is even sent, in both UI surfaces. **This closes a real
  pre-existing gap**: both surfaces were already sending `costResponsibility: "merchant"` to the
  activation endpoint unconditionally, with no confirmation step at all, before this change.
- Switching to a model whose provider is unconfigured or unavailable fails the pre-activation health
  check and never activates, per the pre-existing `activateAgentModel` flow — nothing new was needed
  here, but Qwen3-4B is now a real exercise of that path when HF isn't configured.
- Concurrent activation requests for the same agent are rejected with `409 MODEL_ACTIVATION_CONFLICT`
  by the pre-existing per-agent lock, unmodified by this work.

## 8. Conversation-continuity behavior

Unaffected by design: a model swap changes which `ModelRuntimeAdapter` a turn is routed to, never the
conversation record, its history, its `runtime_binding_id`, or the agent identity. Context budgeting
picks up a newly-registered model's `contextWindow` automatically (§8 of the audit). No new
conversation-memory system was introduced for Hugging Face — none was needed.

## 9. Runtime handoff behavior

Unmodified. A model swap mid-task uses the pre-existing `POST /v1/runtime/:taskId/swaps/model`
endpoint and the pre-existing `RuntimeHandoff` checkpoint mechanism. This feature adds no new handoff
code and changes no handoff behavior.

## 10. Security measures

- Platform HF token (`ai-runtime`'s `HF_TOKEN`) never leaves that service; the wire request between
  `services/api` and `services/ai-runtime` is server-to-server only, authenticated by the pre-existing
  shared bearer (`GROGONI_INFERENCE_SERVICE_TOKEN`), and never touches a browser.
- User-connected HF tokens: encrypted at rest (`encryptOAuthToken`), validated against the real HF API
  before persistence, resolved only server-side, never returned to a browser in full, never logged.
  `resolveInferenceToken` additionally requires an explicit, separately-authorized
  `inferenceAuthorized` flag before returning a usable token — connecting an account for discovery
  never implicitly grants inference-billing use of that same token.
- Account isolation: every `ExternalConnectionsDomain` method checks `record.accountId ===
session.account.id`; verified by a new test asserting a 404 (not a silent no-op) when one account
  tries to authorize another account's connection for inference.
- `providerCredential` in the wire contract is resolved server-side only and never accepted from an
  untrusted client input — it flows from `services/api`'s own resolution of the business's
  authorization, never from a request body a browser could shape.

## 11. Tests executed and their actual results

Full monorepo suite (`npx vitest run`), after the follow-up round:

```
Test Files  299 passed | 8 skipped (307)
     Tests  1653 passed | 95 skipped (1748)
```

Zero failures. Full monorepo typecheck (`pnpm typecheck`, every package and service): clean.

Follow-up round added:

- `tests/agent-model-panel.test.tsx` — new file, 3 tests: confirm/cancel/default-skips-confirmation
  for `AgentModelPanel.tsx`'s activation flow, closing the gap named below in the first pass.
- `tests/native-runtime-execution-target-resolution.test.ts` — 4 new tests: forwards a resolved
  own-account credential into the adapter context, never resolves one when `billingMode` is absent,
  never resolves one when the caller omits `accountId`/`resolveInferenceCredential` (backward
  compatibility for every existing caller), degrades to the platform credential (never fails the
  turn) when `billingMode` is `"own-account"` but the account has no usable connection.
- `tests/agent-model-billing-mode.test.ts` — new file, 5 tests: rejects `"own-account"` with no
  authorized connection (409), accepts it once connected+authorized and **the preference survives a
  model re-activation** (the regression test for the shared-model-row bug caught in §0), reverting to
  `"platform"` always succeeds, rejects when no model was ever activated (409), rejects an invalid
  `billingMode` value (400), rejects unauthenticated requests (401).

New/changed test coverage added by this work:

- `services/api/src/inference/model-runtime.test.ts` — 6 new tests: `requiresArtifact: false` skips
  all artifact I/O, provider identity distinct from `"llama.cpp"`, wire request omits `artifact`,
  `providerCredential` forwarded when present / omitted when absent, and a regression test proving
  the pre-existing artifact-backed path is byte-for-byte unchanged.
- `tests/vercel-inference-service.test.ts` — 14 new tests: hybrid concurrent routing (GGUF and HF
  models served by the same deployment in the same test), `resolveInferenceEngine` unit coverage (5
  cases), HF-vs-platform-token precedence, 402 classification, `HF_FREE_TIER_ONLY` latch behavior
  (trips after one 402, blocks the next request without calling HF again; does nothing when unset).
- `tests/external-connections.test.ts` — 4 new tests: default-false authorization on connect,
  authorize/revoke round trip with `resolveInferenceToken` gating, cross-account rejection (404), and
  rejection on a disconnected connection (409).
- `tests/quick-runtime-switcher.test.tsx` — 3 new tests: confirmation required before a merchant-
  funded switch (and no request fires before confirming), cancellation leaves the prior model active
  with zero calls, returning to the platform default never asks for confirmation. **A genuine,
  pre-existing test-isolation bug was found and fixed while writing these**: `apps/web/src/
api-request-cache.ts` caches `GET` responses in a module-level `Map` that persists across tests in
  the same file; shop-independent paths (`/v1/ai-models`, `/v1/platform/agent-catalog`) were being
  served from an earlier test's stubbed response. Fixed by calling the existing
  `clearApiRequestCache()` export in `beforeEach`. This is a latent gap in the pre-existing two tests
  in that file too (they never happened to assert on the polluted state), not something this feature
  introduced.
- `tests/platform-catalog.test.ts` — updated the exact-match bootstrap-catalog id list to include
  `qwen3-4b`.

**Not run**: a real, billable Hugging Face API round trip (see §5) — correctly out of scope without
explicit authorization and a real token.

## 12. Existing functionality affected

None, by design and by verification:

- The existing exclusive `INFERENCE_PROVIDER=huggingface` mode's tests pass unmodified — its behavior
  is byte-for-byte preserved.
- The existing artifact-backed llama.cpp path's tests pass unmodified.
- `costResponsibility`/`platformSharedModelId` billing-default logic is untouched — Qwen3-4B computes
  as merchant-funded through the exact same pre-existing formula every other non-default model uses.
- No route was removed, renamed, or had its response shape changed in a breaking way — every new
  field (`inferenceAuthorized`, `canonicalModelId`, `supportsToolCalling`, `supportsStructuredOutput`)
  is additive.
- A completely unrelated, uncommitted, in-progress fulfillment-dispatch change was present in this
  shared working tree for both rounds of this session (not made by this work). It was never edited,
  but the second round surfaced two concrete risks of a shared checkout worth recording: (a) another
  process switched the working tree's checked-out branch mid-session (visible in `git reflog`), which
  transiently made this session's own committed changes appear to have vanished from disk until
  switching back — nothing was actually lost, but real debugging time went into confirming that; (b)
  that same branch churn left `packages/shared-types/dist` built from a different branch's source,
  producing spurious `@grogoni/shared-types` typecheck failures in unrelated files
  (`fulfillment/dispatch.ts`) until `pnpm --filter @grogoni/shared-types build` was re-run. Both are
  reported here as operational findings about this environment, not defects in the shipped feature.

## 13. Outstanding limitations

1. `HF_FREE_TIER_ONLY`'s latch is per-process, not distributed — stated as a limitation in both the
   code and the architecture doc, not just here.
2. `supportsToolCalling`/`supportsStructuredOutput` on the Qwen3-4B catalog entry are conservatively
   `false` because the featherless-ai-routed endpoint's actual behavior for `tools`/`response_format`
   was not verified against a live token in this session — flip them only after that verification.
3. Task-based automatic model routing is scoped, not built — see
   `docs/architecture/task-based-model-routing-proposal.md` for the recommended design and the three
   open questions that need an answer before building it.
4. The BYO-credential billing mode has a backend API
   (`POST /api/agents/:agentId/model-binding/billing-mode`) but no frontend control yet in
   `QuickRuntimeSwitcher.tsx`/`AgentModelPanel.tsx` — a business can only set it via a direct API call
   today, not through the chat UI.
5. If an account's own-account credential becomes unresolvable after being authorized (the connection
   is later revoked or removed), a turn silently continues under the platform credential rather than
   failing — an accepted tradeoff for availability, not an oversight, but worth surfacing to a
   business somewhere (e.g. a "billing fell back to platform" notice) in a future pass.
6. `grogoni_session_contexts.active_model_id` vs. the native-runtime-binding's own model selection as two
   possibly-overlapping sources of truth (flagged in the audit) was not reconciled — out of scope for
   this feature, named as a separate follow-up.

## 14. Deployment requirements

No new service, no new deployment target. To activate Hugging Face inference on an existing
deployment:

1. On the Render (`services/api`) side: no required changes. `HF_TOKEN` there remains optional
   (discovery only).
2. On the Vercel (`services/ai-runtime`) side: set `HF_TOKEN` (the platform's real HF inference
   token) and `HF_MODEL_MAP` (at minimum `{"qwen3-4b":"Qwen/Qwen3-4B"}`) via the Vercel dashboard/CLI.
   Leave `INFERENCE_PROVIDER` unset or `llama-cpp` to get the hybrid concurrent mode described in
   §3 of `huggingface-inference.md`; keep `MODEL_ARTIFACT_ALLOWED_HOSTS` configured as it already is
   for the existing GGUF path. Optionally set `HF_FREE_TIER_ONLY=true`.
3. To make Qwen3-4B the platform default (optional, administrator decision): set
   `PLATFORM_DEFAULT_MODEL_ID=qwen3-4b` on the Render deployment (existing env var, `sync: false` in
   `render.yaml` — set manually in the dashboard).
4. Run migration `097_external_connection_inference_authorization.sql` (additive, no downtime;
   rollback available).
5. Restart/redeploy `services/api` and `services/ai-runtime` to pick up the code changes.

No frontend deployment step beyond the normal build/deploy of `apps/web` — no new environment
variables are needed there, and no client bundle ever receives a credential.

## Completion status

**DONE_WITH_CONCERNS.** The concurrent-provider architecture, Qwen3-4B registration with verified live
availability, dynamic switching with a real cost-confirmation gate on both UI surfaces (each with its
own test file), credential-scope separation, free-tier safeguards, and now the live per-turn
BYO-credential wiring are implemented, tested (1653 passing, 0 failing, full typecheck clean), and
documented. Task-based automatic routing was explicitly scoped rather than built, per instruction. The
concerns are exactly the six items in §13 — none of them block correct operation of what shipped; each
is a named, bounded follow-up (a frontend control, a distributed rate-limit latch, an unverified
capability flag, a scoped-not-built feature, an accepted degrade-to-platform tradeoff, and a
pre-existing dual-source-of-truth this feature did not create). Nothing in this report claims any of
them is closed.
