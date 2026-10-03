# Audit: Hugging Face inference and dynamic model switching

Written before any implementation. Every claim below was verified by reading the cited file, running
the cited migration/grep, or calling the cited live API — not inferred from other docs. Several
existing docs in this repo are stale (see "Known doc drift" at the end); where a doc and the code
disagreed, this audit trusts the code and calls out the doc.

## 1. Agent architecture — exists, reusable, unaffected by this work

Two layers, unified by `docs/adr/ADR-collapse-harness-into-agent.md`:

- `AgentDefinition` (`packages/shared-types/src/index.ts:3987-4006`) — the catalog entity a business
  picks: personality, instructions, knowledge, tools, and a `runtimeAdapterId` (e.g. `"pi"`, `"grogoni"`).
  Stored in `cp2_agent_catalog`. Built-ins: `builtin:shopkeeper` (adapter `grogoni`) and
  `builtin:pi-assistant` (adapter `pi`, added by migration `096_agent_definition_runtime_adapter.sql`).
- `AgentRuntimeAdapter` (`services/api/src/agent-harness/agent-runtime-adapter.ts:40-65`) — the
  execution harness: `{id, canRun(), execute()}`, held in `AgentRuntimeAdapterRegistry`. Only two are
  registered (`services/api/src/agent-harness/default-agent-runtime-adapters.ts`): `grogoni`, `pi`.
- Selection is per-business (`PUT /businesses/:businessId/agent-profile`), via
  `QuickRuntimeSwitcher.tsx`. Not per-message, per-user, or per-model.

**This feature does not touch this layer.** A model change never changes `runtimeAdapterId`. Nothing
here needed extension.

## 2. Model registry — exists in two places, both reusable, extended (not replaced) by this change

- `runtimeModels` (`packages/shared-types/src/index.ts:1077-1111`) is the **closed, code-level
  registry that actually gets a live `ModelRuntimeAdapter`** at server boot
  (`services/api/src/index.ts:139-152`, keyed `${executionTarget}:${modelId}`). Today: 4 entries, all
  routed through the single `vercel` execution target.
- `aiModelRegistry` (`services/api/src/cp2/domains/agent-runtime/model-catalog.ts:78-243`) is the
  **catalog surfaced to the UI/activation API** (`AiModelSummary[]`, typed at
  `packages/shared-types/src/index.ts:971-1001`). It already models `source: "huggingface"` (a
  downloadable HF Hub GGUF file) and `source: "hosted"` (a Grogoni-run remote model) as distinct
  concepts, and already carries `runtimeAvailability: Partial<Record<ModelExecutionTarget, ...>>` for
  per-target configured/unconfigured state.
- Both registries needed a new entry for Qwen3-4B, not a new table. See Part B below for what changed
  and why the existing `provider`/`source` fields were sufficient.

## 3. Agent-model bindings — the named table is gone; the real mechanism is native runtime bindings

`cp2_agent_model_bindings` **does not exist** — it was archived (`065_retire_execution_fabric.sql`)
and dropped (`075_drop_dead_runtime_assignment_tables.sql`, `076_drop_legacy_agent_model_bindings.sql`).
Any reference to it (including in the original task brief) is describing retired architecture.

The live mechanism is the **native runtime binding graph**: `cp2_native_runtime_agents`,
`cp2_native_runtime_models`, `cp2_native_execution_hosts`, `cp2_native_model_installations`,
`cp2_native_runtime_bindings`, `cp2_native_runtime_binding_models` (migration
`063_native_runtime_bindings.sql`). Binding-to-model is an ordered role list (`primary` + ordered
`fallback`), with a DB-enforced deferred-constraint trigger guaranteeing exactly one enabled primary
(`063_native_runtime_bindings.sql:128-159`).

Resolver: `NativeRuntimeBindingStore.resolveRuntimeBinding()`
(`services/api/src/cp2/domains/native-runtime/store.ts`), precedence: (1) conversation's explicit
`runtimeBindingId`, (2) most recent active business/account binding, (3) platform default
(`builtin:grogoni-default-runtime:v1`). This resolver is unchanged by this work — it already implements
exactly the "explicit > conversation > preference > platform default" hierarchy the task asked for.

**Assessment**: fully reusable. This feature does not add a binding table; it adds a second live model
option that this existing resolver/activation path can point at.

## 4. Runtime instances / execution hosts — reusable, one enum change

`NativeExecutionHostSummary` (`packages/shared-types/src/index.ts:4640-4654`) already models a
credential _reference_ only — `063_native_runtime_bindings.sql:40-44` has a DB `CHECK` constraint that
rejects endpoints with embedded credentials, so raw secrets structurally cannot land in this table.

`ModelExecutionTarget` (`packages/shared-types/src/index.ts:1053-1059`) is `"vercel" | "backend" |
"remote-shop-device"`. **`docs/architecture/swappable-agent-model-runtime.md:59-60` is stale** — it
still lists the retired `browser-local`/`installed-app` targets. This audit does not add a fourth
execution target for Hugging Face: see Part A for why the existing `"vercel"` target is the correct
place for it (HF and llama.cpp already share it; they differ in provider, not in where they run).

## 5. Inference provider interfaces / adapters — the central finding

**A `ModelRuntimeAdapter` interface already exists, and Hugging Face is already a fully-implemented
backend behind it — but as an exclusive deployment-wide mode, not a concurrently selectable one.**

Interface: `services/api/src/inference/model-runtime.ts:62-71`.

```ts
export interface ModelRuntimeAdapter {
  readonly provider: string;
  readonly executionTarget: ModelExecutionTarget;
  canRun(context): Promise<ModelRuntimeAvailability>;
  healthCheck(context): Promise<ModelRuntimeHealthResult>;
  generate(input: { context; prompt }): Promise<ModelRuntimeGenerationResult>;
}
```

Today exactly one adapter factory exists: `createVercelModelAdapter()`
(`model-runtime.ts:205-295`, `provider: "llama.cpp"`, `executionTarget: "vercel"`). It is instantiated
once per entry in `runtimeModels` at boot (`services/api/src/index.ts:139-152`) and calls the
`services/ai-runtime` Vercel function's `/v1/inference` endpoint
(`createVercelInferenceClient`, same file).

`services/ai-runtime` (the Vercel function) already has a **complete, tested Hugging Face
implementation**: `services/ai-runtime/src/huggingface-runtime.ts` (201 lines) calls
`https://router.huggingface.co/v1/chat/completions`, streams SSE, parses `usage`, and classifies
errors (401/403 → auth failed, 404 → model not found, 429/5xx → retryable). It is wired into
`services/ai-runtime/src/vercel-handler.ts` behind a **single deployment-wide switch**:
`INFERENCE_PROVIDER=llama-cpp|huggingface` (`readVercelInferenceConfig`, `vercel-handler.ts:39-75`).
When `huggingface`, every request — regardless of which Grogoni model id it names — is routed to
whichever HF Hub model that id maps to in `HF_MODEL_MAP` (a JSON object env var). When `llama-cpp`,
every request downloads a GGUF artifact and runs it locally. **A single deployment can never serve
both at once**, and `parseRequest` (`vercel-handler.ts:300-362`) unconditionally requires an `artifact`
object on every request (even HF ones, where it's validated but unused) — a structural leftover of the
llama.cpp-only design.

Retired/dead code confirmed absent: `services/api/src/inference/openai-provider.ts` and
`cloud-fallback.ts` **do not exist** (removed by `068_remove_cloud_fallback.sql`). There is **no
OpenAI or Anthropic cloud provider adapter anywhere in this codebase** — only the Vercel-hosted
llama.cpp/HF pair and the deterministic non-LLM `grogoniclaw-local` fallback. Four docs and one
shared-types comment still cite the deleted files (see "Known doc drift").

**This is the one piece of real, non-cosmetic backend work this feature required**: making Hugging
Face a per-model routing choice inside the existing single `vercel` adapter/execution target, instead
of an exclusive-OR deployment flag — without breaking the llama.cpp path or requiring a redeploy to
switch. See Part A.

## 6. Native runtime handoff — exists, mature, unaffected

`docs/runtime/runtime-handoff.md` + migrations `083_runtime_handoff_protocol.sql`,
`085_runtime_transfers.sql`. A `RuntimeHandoff` is an immutable, portable task checkpoint (goal,
state, completed/pending actions, decisions, next action) independent of any specific model. Full REST
surface at `/v1/runtime/:taskId`, including `POST /swaps/model`. A Hugging Face model swap during an
active task goes through this exact endpoint like any other model swap — this feature adds no new
handoff mechanism and changes no handoff code.

## 7. Conversation state & message persistence — exists, reusable, one field flagged for reconciliation

Relational: `conversations`, `conversation_participants`, `conversation_messages`,
`grogoni_session_contexts` (migration `017_cp20_unified_session_conversations.sql`). CP2 JSON mirrors:
`cp2_conversations`, `cp2_conversation_messages`, etc. (same file). `conversations.runtime_binding_id`
/ `cp2_conversations.runtime_binding_id` (added by migration 063) is how a conversation pins itself to
a specific runtime binding.

**Flagged, not changed**: `grogoni_session_contexts.active_model_id` is a second, older per-session
"which model" field that predates the native-runtime-binding graph. This feature does not write to it
and does not treat it as authoritative — the binding's model is authoritative — but a future cleanup
should either retire this column or make it a read-only projection of the binding, so there is only
one source of truth for "which model is this session on."

## 8. Context assembly & token budgeting — exists, reusable, zero code changes needed

`contextCharacterBudgetForModel()` (`services/api/src/cp2/domains/agent-runtime/model-catalog.ts:259-272`)
already derives the retrieved-context character budget from a model's declared `contextWindow`
(`Math.floor(contextWindow * 4 * 0.25)`), falling back to 6,000 chars when a model has no declared
window. **Adding Qwen3-4B's real `contextWindow` to the registry is all this required** — the budgeting
function picks it up automatically; no new plumbing.

`resolveAgentContext()` (`services/api/src/cp2/agent-business-runtime.ts:380-483`) does the actual
greedy context packing against that budget. Unaffected.

## 9. Task classification & model routing — task classification exists; automatic _model_ routing does not

`RuntimeParserIntent` drives context-recipe/evidence selection (`docs/architecture/context-recipes.md`)
but is never consulted to pick a model. `runtime-model-routing.ts`
(`services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts`) only does primary→fallback
_failover_ on availability failure, not task-type-based selection.

**Out of scope for this change.** Automatic "use a bigger model for hard tasks" routing is a genuinely
new capability, not a reuse-and-extend of something that exists, and the task brief's Part D precedence
hierarchy (task override > conversation override > user preference > platform default) does not require
it — it requires that an _explicit_ task-level override be honored, which the existing binding/override
mechanism already supports. Logged as a named follow-up, not built here.

## 10. Tool permissions & authorization — exists, model-agnostic by construction, unaffected

Single governed path: `runtimeToolRegistry` (`packages/tool-core/src/index.ts`) →
`Cp2Store.createRuntimeTurn`/`executeRuntimeAction` (`services/api/src/cp2/store.ts`). Every tool
carries `risk`, `requiresConfirmation`, `readOnly`, `requiredPermission`. A model — whichever provider
produced it — can only _propose_ a tool call as structured text; the same authorization/confirmation
gate applies regardless of provider. This feature does not touch this path, by design: it must not,
since a swapped model must not get different tool authority than the one it replaced.

## 11. Existing inference-related DB migrations

98 migrations total. Directly relevant, chronological: `017` (conversations/sessions), `063` (native
runtime binding graph), `065`/`075`/`076` (retire old Fabric + `agent_model_bindings`), `067`/`069`/`070`
(provider-agnostic/zero-setup defaults), `071`/`072` (platform catalog, Pi + SmolLM2 default), `073`
(external registry connections — GitHub/HF discovery PATs), `074` (registry import lifecycle), `079`/`080`
(Vercel/GGUF artifact metadata), `083`-`085` (runtime handoff), `095`/`096` (harness→agent collapse).

**No existing migration creates anything Hugging-Face-inference-specific** — today's HF wiring is
entirely env-var-based on the `services/ai-runtime` side, with zero Postgres representation. This audit
finds no reason to add one: the model catalog is code (`runtimeModels`/`aiModelRegistry`), not a table,
and extending it does not require a migration. See Part A for the one new column this change _does_
add (to `cp2_external_registry_connections`, for real reasons, not cosmetic ones).

## 12. Backend inference env vars

Two services, two separate `HF_TOKEN`s with different purposes — a real naming collision worth
flagging:

- `services/api/.env.example`: `HF_TOKEN` is **optional**, used only for authenticated Hub _discovery_
  (raising rate limits / accessing gated repos when searching for importable models/agents). Not used
  for inference.
- `services/ai-runtime/.env.example`: `HF_TOKEN` is **required when `INFERENCE_PROVIDER=huggingface`**
  — this is the actual platform inference token, billing-relevant.
- No `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` exists anywhere in the repo (grep confirmed zero hits outside
  `node_modules`).
- `render.yaml:129-144` provisions both `HF_TOKEN` and the `PLATFORM_DEFAULT_*` vars as `sync: false`
  (set manually in the Render dashboard, not from the committed file) — meaning **this audit cannot
  see or infer the current production value of any of these**, and this feature's code changes must
  not assume a particular production value is or isn't already set.

## 13. User settings/preferences — business-scoped, not individual-account-scoped

Model preference today is `activeAiModels: Map<businessId, ActiveAiModelSummary>`
(`packages/shared-types/src/index.ts:1003-1008`), read/written throughout
`services/api/src/cp2/domains/agent-runtime/store.ts`. There is no separate `user_preferences` table
for an individual (non-business) account's model choice. Given Grogoni's merchant-tool framing throughout
the docs, "user" in the task brief maps to "business/shop owner" here — this audit treats it that way
rather than inventing a parallel per-account preference concept.

## 14. Unified chat interface — exists, has an idiomatic home for this feature already

`QuickRuntimeSwitcher.tsx` (`apps/web/src/QuickRuntimeSwitcher.tsx`) is the live agent+model picker: it
loads `GET /v1/platform/agent-catalog`, `GET /v1/ai-models`, `GET /businesses/:id/runtime/effective`,
and activates via `POST /api/agents/:agentId/models/:modelId/activate`. It filters models to
`runtimeAvailability.backend === "configured"`. **This is not drift**: `Cp2Store.listAiModels()`
(`services/api/src/cp2/domains/agent-runtime/store.ts:404-447`) computes that field dynamically per
request by asking `modelRuntimeAdapterResolver` whether a live adapter is actually registered for
`${platformDefaultRuntime.executionTarget}:${model.id}` — the `"backend"` key is, per an explicit code
comment at store.ts:431-434, "the frontend's stable field name for 'is a server-hosted adapter
configured', not the `ModelExecutionTarget` literal." So a model only ever shows as available in this
UI when a real, booted adapter exists for it — exactly the "don't label an unavailable model as
available" requirement, already enforced. `AgentModelPanel.tsx` is the advanced/detailed model browsing
panel. `ConnectedSourcesPanel.tsx` is the existing GitHub/HF personal-access-token connection UI.

## 15. Existing Hugging Face integration — confirmed extensive, three distinct roles

1. **Live inference provider** (`services/ai-runtime/src/huggingface-runtime.ts` +
   `vercel-handler.ts`) — real, tested, but an exclusive deployment mode (Part 5 above).
2. **Discovery/import adapter** (`services/api/src/cp2/huggingface-model-catalog.ts`,
   `huggingface-agent-catalog.ts`, `runtime-registry/huggingface-adapter.ts`) — finds _which_ HF
   models/agents exist via the HF Hub search API; does not run them.
3. **User-connected-account credential** (`POST /v1/external-connections/huggingface`, Part 16) —
   validated, encrypted, but **not read by the inference path at all** before this change.

**Live verification performed as part of this audit** (2026-09-24, via `GET
https://huggingface.co/api/models/{id}?expand=inferenceProviderMapping`, no HF token required for this
public endpoint):

| Model                                 | `inferenceProviderMapping`                                         | Verdict                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Qwen/Qwen3-4B`                       | `{"featherless-ai": {"status": "live", "task": "conversational"}}` | **Live** via HF Inference Providers, routed to the `featherless-ai` backend.                                                       |
| `Qwen/Qwen3-4B-Instruct-2507`         | live via `nscale` and `featherless-ai`                             | Live (not the requested exact ID; not registered).                                                                                 |
| `HuggingFaceTB/SmolLM3-3B`            | `{}` (empty)                                                       | **Not available** through hosted Inference Providers — repository exists, no serving backend is live for it.                       |
| `HuggingFaceTB/SmolLM2-1.7B-Instruct` | `{}` (empty)                                                       | **Not available** through hosted Inference Providers, despite being the model `HF_MODEL_MAP`'s own example maps `smollm2-360m` to. |

This confirms the task brief's own warning in the letter: a model repository existing on the Hub is
not evidence it is servable. Two of the three candidate models named in the task brief (SmolLM3-3B,
SmolLM2-1.7B-Instruct) are **not currently live** on HF's shared Inference Providers API — registering
them as selectable-for-inference would have been exactly the "silent substitution" the brief prohibits.
They are not registered as inference-capable in this change; see Part B/C.

## 16. User-owned provider credentials — exists, encrypted, extended (not rebuilt) by this change

`ExternalConnectionsDomain` (`services/api/src/cp2/domains/external-connections/store.ts`, 317 lines),
table from migration `073_external_registry_connections.sql`. `connect()` validates a PAT with one real
call (`huggingface.co/api/whoami-v2`) **before** persisting; tokens are encrypted with
`encryptOAuthToken`/`decryptOAuthToken` (`services/api/src/cp2/oauth.ts`, the same primitive used for
social-login OAuth); `disconnect()` clears (not flags) the encrypted column; `resolveToken()` is
internal-only, never exported from routes, returns `null` on any failure. This is exactly the right
primitive for user-owned inference credentials — see Part G/H for the one addition (a `scope` column)
this change made to let a Hugging Face connection be used for _inference_ billing, not just discovery,
without conflating the two.

## Known doc drift found during this audit (not part of this feature, flagged for a separate cleanup)

- `docs/architecture/swappable-agent-model-runtime.md:59-60` describes a 4-value `ModelExecutionTarget`
  enum (`backend`, `browser-local`, `installed-app`, `remote-shop-device`) that no longer matches
  `packages/shared-types/src/index.ts:1053` (`vercel`, `backend`, `remote-shop-device`).
- `packages/shared-types/src/index.ts:3688-3692`, `docs/runtime/vercel-inference-audit.md`,
  `docs/architecture/client-first-inference.md`, `docs/architecture/governed-tool-runtime.md`, and
  `docs/architecture/provider-neutral-runtime.md` all still cite `services/api/src/inference/
openai-provider.ts` and `cloud-fallback.ts` as if live. Both files were deleted by migration
  `068_remove_cloud_fallback.sql`. There is no cloud LLM-API provider in this codebase today.
- No drift found in `QuickRuntimeSwitcher.tsx`'s model filter — initially suspected, but it is
  intentional and documented (see Part 14).

## Policy note

`CLAUDE.md`'s "LLM access" section says: "When the software we build needs to call an LLM, do NOT use
an LLM API (Anthropic API, OpenAI API, any hosted inference endpoint) unless Julien explicitly
instructs it." This audit reads that as governing _tooling Claude Code builds for itself_ (evals,
internal agents), not Grogoni-the-product's own inference architecture, which has called hosted HF
inference in production since before this task began (`render.yaml`, `services/ai-runtime`). The task
instructions that produced this audit are themselves an explicit, detailed instruction to extend that
existing hosted-inference architecture, naming Hugging Face and `router.huggingface.co` specifically —
treated here as satisfying that exception. Flagged in the open so it can be corrected if that reading
is wrong.
