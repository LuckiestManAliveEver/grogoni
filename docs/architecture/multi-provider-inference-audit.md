# Multi-provider inference — repository audit (Phase 0)

This audit was written before any code for the multi-provider inference router was added. It
records what the repository already had, what the new layer reuses, and where the brief's
suggested shapes had to be adapted to decisions the repository already made. The implementation
report is [multi-provider-inference-implementation.md](./multi-provider-inference-implementation.md).

## 1. What already exists

| Concept in the brief      | Existing implementation                                                                                                                                                                                                                                                                                                  | Verdict                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `agents`                  | `cp2_native_runtime_agents` (`NativeRuntimeAgentSummary`), plus the business-facing `AgentDefinition` catalog (`cp2_agent_catalog`). Agent engines are `AgentRuntimeAdapter`s (`pi`, `grogoni`) selected by `configuration.runtimeAdapterId`.                                                                            | Reuse. No new agent table.                                                                      |
| `models` / model registry | Two layers: the DB-hosted catalog `cp2_model_catalog` (`AiModelSummary`, operator-editable through `PUT /v1/platform/model-catalog/:id`, served by `GET /v1/ai-models`) and the per-shop runtime graph `cp2_native_runtime_models`. `runtimeModels` in `@grogoni/shared-types` lists models the Vercel adapter can load. | Reuse and extend `AiModelSummary` / `cp2_model_catalog`. No new model table.                    |
| `agent_model_bindings`    | `cp2_native_runtime_bindings` + `cp2_native_runtime_binding_models` (primary/fallback/auxiliary roles). The legacy `cp2_agent_model_bindings` table was dropped (migration 076). Conversations reference a binding id, never a model.                                                                                    | Reuse. Model switching already keeps the binding id stable.                                     |
| `runtime_instances`       | `cp2_runtime_task_instances` (Runtime Handoff Protocol, migrations 083–085).                                                                                                                                                                                                                                             | Reuse unchanged.                                                                                |
| `execution_hosts`         | `cp2_native_execution_hosts` and `cp2_native_model_installations`.                                                                                                                                                                                                                                                       | Reuse. Remote API providers run on a `backend` host.                                            |
| Execution targets         | `ModelExecutionTarget = "vercel" \| "backend" \| "remote-shop-device"`. `browser-local`/`installed-app` were **retired** by ADR-device-independent-runtime-and-registry-discovery.md and are guarded by `scripts/check-retired-device-model-references.mjs`.                                                             | Keep the native vocabulary. See §3.1.                                                           |
| Inference abstraction     | `ModelRuntimeAdapter` (`canRun` / `healthCheck` / `generate`) in `services/api/src/inference/model-runtime.ts`, registered in a map keyed `` `${executionTarget}:${modelId}` `` in `services/api/src/index.ts`. The only production adapter is `createVercelModelAdapter`.                                               | Reuse as the integration seam. The new router is exposed to agents as a `ModelRuntimeAdapter`.  |
| Agent → model call path   | `createRuntimeModelRoute` (`agent-runtime/runtime-model-routing.ts`) → `resolveNativeRuntimeModelProvider` (`native-runtime-routing.ts`) → `runtimeProviderFromAdapter` → `adapter.generate`. No agent branches on a vendor.                                                                                             | Reuse. No agent code changes are needed.                                                        |
| Tool calling              | Models return one JSON object (`{"type":"tool","toolName",...}`) parsed by `parseRuntimeModelOutput` (`@grogoni/tool-core`). Proposals then go through validation, authorization, confirmation and the canonical tool executor.                                                                                          | Reuse. Provider-native tool calls are normalized back into this exact JSON shape.               |
| Approval engine           | `requiresConfirmation` on `RuntimeToolDefinition`, enforced in `createRuntimeTurn`.                                                                                                                                                                                                                                      | Untouched. Providers never execute tools.                                                       |
| Runtime handoff           | `RuntimeHandoffDomain`, `POST /v1/runtime/:taskId/swaps/model` materializes a native binding with a checkpoint.                                                                                                                                                                                                          | Untouched. Provider-backed models are ordinary catalog models, so handoff swaps work unchanged. |
| Credentials / BYOK        | `ExternalConnectionsDomain` (`cp2_external_registry_connections`, migration 073/097): GitHub and Hugging Face tokens, AES-256-GCM encrypted with `encryptOAuthToken`, never returned to clients, inference use gated by an explicit `inferenceAuthorized` flag plus the binding's `billingMode: "own-account"`.          | Reuse the encryption helpers and the "separate authorization" principle. See §3.3.              |
| Tenant model              | A tenant is a business (`businessId` / `shopId`). A person has a `user` and an `account` (`session.account.id`); external connections are account-scoped. Business permissions come from `requireAuthorizedSession(session, businessId, permission)`.                                                                    | Tenant credential = business; user credential = account.                                        |
| Local inference           | The retired browser-local architecture was removed. What survives is the explicit, opt-in **offline assistant** (`apps/web/src/webllm-runtime.ts`, `@grogoni/offline-runtime`) and the `remote-shop-device` owner-node broker.                                                                                           | Represent local models as client-executed; the server never runs or forwards them. See §3.1.    |
| Normalized errors         | `RuntimeInferenceErrorCategory` + `normalizeInferenceErrorCode` in shared-types; `ModelRuntimeError(code, message, retryable)`.                                                                                                                                                                                          | Reuse. New codes are registered in the same category map.                                       |
| Frontend model selector   | `QuickRuntimeSwitcher.tsx` (composer) and `AgentModelPanel.tsx` read `GET /v1/ai-models` and activate through `POST /api/agents/:agentId/models/:modelId/activate`. The switcher hardcoded `executionTarget: "vercel"`.                                                                                                  | Reuse. Remove the hardcoded target so provider-backed models activate on their real target.     |
| Settings UI               | Settings is a set of `SettingsGroup` cards in the owner workspace; `ConnectedSourcesPanel` / `McpAccessTokensPanel` are the closest precedent for a credential list.                                                                                                                                                     | Add an "AI providers" card in the same style.                                                   |
| Metrics                   | `@grogoni/observability` (`createMetrics`, `timeModelRequest`, bulkhead/circuit-breaker gauges).                                                                                                                                                                                                                         | Extend with inference counters/histograms.                                                      |
| Resource controls         | `@grogoni/resource-control` bulkhead + circuit breaker around Vercel generation.                                                                                                                                                                                                                                         | Reuse per provider.                                                                             |
| SSRF policy               | Only `services/computer-runtime/src/network-policy.ts` (navigation policy for the browser worker). It misses CGNAT, IPv4-mapped IPv6, `0.0.0.0/8` and redirect handling, and lives in a different deployable.                                                                                                            | Write a stricter endpoint policy for provider base URLs in `services/api`.                      |
| Persistence pattern       | Most CP2 state is an in-memory snapshot persisted as a whole; fulfillment (`cp2/domains/fulfillment/service.ts`) is the precedent for a Postgres-authoritative module with its own pool.                                                                                                                                 | Follow the fulfillment precedent: repositories with a memory and a Postgres implementation.     |

## 2. Direct vendor calls found

None. `services/api/src/inference/openai-provider.ts` and the `openai-fast` catalog entries were
already deleted (see provider-neutral-runtime.md), and no agent adapter names a vendor. Hugging Face
inference runs inside `services/ai-runtime` behind the Vercel adapter and is out of scope for this
change; it keeps working exactly as before.

## 3. Decisions where the brief meets existing constraints

### 3.1 Execution target vocabulary

The brief's `ModelDefinition.executionTarget` lists `browser-local | installed-app |
remote-inference | remote-shop-device`. The repository's native graph deliberately allows only
`vercel | backend | remote-shop-device`, and re-adding the retired values to
`ModelExecutionTarget` would reopen server-side device model assignment that an ADR removed.

Decision: the provider layer gets its own `InferenceExecutionTarget` with the brief's four values,
kept separate from the native graph's target, and one mapping:

| `InferenceExecutionTarget` | Native `ModelExecutionTarget` | Who executes                                                        |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `remote-inference`         | `backend`                     | Render calls the provider's HTTPS API                               |
| `remote-shop-device`       | `remote-shop-device`          | Existing owner-node broker (unchanged)                              |
| `browser-local`            | none                          | Client only (offline WebLLM runtime); the server refuses to forward |
| `installed-app`            | none                          | Client only (native app); the server refuses to forward             |

A binding can never materialize a server-side host for the local targets, which keeps the ADR's
guarantee. The router treats a local-target model as `LOCAL_EXECUTION_REQUIRED` and **never** sends
it to a cloud provider, which is what brief §7 requires.

### 3.2 Model registry

`cp2_model_catalog` stays the only registry. `AiModelSummary` gains one optional `inference`
block (provider id, provider model id, inference execution target, capability flags, max output
tokens, enabled flag, pricing). Catalog rows without it behave exactly as before. Operators add
provider-backed models with the existing catalog `PUT`, with no code change.

### 3.3 Credentials

`cp2_external_registry_connections` is limited to GitHub/Hugging Face by a check constraint, and it
is keyed one-per-(account, provider), with no tenant scope. Provider API keys need tenant and
user scopes, revocation timestamps, key versions and verification state. A new
`inference_provider_credentials` table is added. It reuses the same AES-256-GCM helpers and key
(`OAUTH_TOKEN_ENCRYPTION_KEY`), so there is still one secret-encryption subsystem. The existing
Hugging Face BYOK path is untouched.

### 3.4 Provider SDKs

The repository has no OpenAI or Anthropic SDK dependency any more. The adapters call the official
documented REST APIs (`/v1/chat/completions`, `/v1/models`, Anthropic `/v1/messages`) with `fetch`
instead of adding SDK dependencies, for three reasons:

- Every outbound request can go through one SSRF-guarded fetch wrapper with `redirect: "manual"`.
- No new supply-chain surface is added to the Render API.
- OpenAI, Z.ai, llama.cpp, vLLM and similar servers share one OpenAI-compatible client.

## 4. Reuse summary

- Agent/binding/model/host graph: unchanged.
- `ModelRuntimeAdapter` is the only integration seam. The router is exposed as a routed adapter
  registered for `backend:<modelId>`.
- `AiModelSummary` and `cp2_model_catalog` are extended, not replaced.
- Encryption helpers are shared with OAuth tokens and external connections.
- Error categories are registered in the existing `normalizeInferenceErrorCode` map.
- Metrics are added to `@grogoni/observability`.
- Model switching reuses `POST /api/agents/:agentId/models/:modelId/activate` and the handoff
  swap endpoints.

## 5. Added (minimum required)

- `inference_providers` table: provider configuration.
- `inference_provider_credentials` table: encrypted BYOK and managed credential metadata.
- `inference_runs` table: usage telemetry without prompts.
- `inference_budgets` table: tenant/user/provider limits.
