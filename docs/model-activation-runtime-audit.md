# Model activation runtime audit

## Scope and finding

The repository already had most of the individual pieces needed for local-first inference, but
they did not form one authoritative end-to-end path.

The exact broken link was between model selection and the server chat runtime:

- The canonical catalogue in `Cp2Store` listed `qwen2.5-0.5b-android` as an available local model.
- The owner UI treated the agent profile's `modelId` as an active backend selection when no
  installed model was attached.
- Installed-model assignments were scoped to `businessId + deviceId` and duplicated into browser
  storage. They represented device readiness, not one active model for an agent.
- `cp2_active_ai_models` represented only an optional OpenAI fallback.
- Production's `runtimeModelProviderResolver` knew only configured OpenAI models.
- `createRuntimeTurn` rewrote an unavailable requested model to `grogoniclaw-local`, and an unavailable
  provider fell through to the deterministic command parser.

Consequently, an “Active” badge did not prove that a model was verified, persisted as the agent's
primary model, resolved by chat, or used for inference.

The 2026-08-14 follow-up audit found that the forward path described below had since been wired
through `cp2_agent_model_bindings`, but its reverse path was still split: the UI's existing
`removeModelFromAgent` deleted only a device-scoped `agentModelAssignment`. There was no API or
store operation to remove a server/backend binding. In addition,
`getActiveAgentModelBinding` fell back to the newest failed or inactive diagnostic record when no
active binding existed. That made the endpoint's contract and reload UI ambiguous. The repair adds
one authorized, idempotent canonical unbind operation, makes the GET return only an active verified
binding, and drives the backend model card's “Remove from agent” state from that response.

## Exact architecture trace

| Stage                        | File and function                                                                                          | Input → output                                                                       | Persistent state                                                       | Failure boundary                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1. Marketplace rendering     | `apps/web/src/GrogoniApplication.tsx` — `AgentProfileSurface`, `serverBackendModels.map`                   | `AiModelSummary[]` plus `activeAgentModelBinding` → model cards and action labels    | Read only                                                              | Empty registry/search result; backend state load failure                                    |
| 2. Use click                 | `GrogoniApplication.tsx` — `activateServerBackendModel`                                                    | Canonical catalogue `model.id` → activation task                                     | None                                                                   | Offline/busy guard                                                                          |
| 3. Request construction      | `GrogoniApplication.tsx` — `postJson`; `apps/web/src/lib/api.ts` — `apiFetch`/`performFetch`               | `agentId`, `shopId`, `modelId`, target, policy, permissions → credentialed JSON POST | None                                                                   | Timeout, 401 refresh failure, non-2xx `ApiRequestError`                                     |
| 4. Activation API            | `services/api/src/cp2/routes.ts` — `POST /api/agents/:agentId/models/:modelId/activate`                    | Parsed path/body → `store.activateAgentModel`                                        | None directly                                                          | Invalid body or store `Cp2Error`                                                            |
| 5. Authentication            | `services/api/src/cp2/store.ts` — `requireAuthorizedSession`                                               | Session cookie, shop, `membership:manage` → authenticated session                    | Session/membership read                                                | `auth_required`, expired session, membership/permission failure                             |
| 6. Agent resolution          | `store.ts` — `requireBusinessAgent`                                                                        | Owned `businessId` and requested `agentId` → `BusinessAgentProfileSummary`           | Agent profile read/default resolution                                  | `AGENT_NOT_FOUND`                                                                           |
| 7. Registry resolution       | `store.ts` — `requireCanonicalAiModel`; `packages/shared-types/src/index.ts` — `runtimeModels`             | Catalogue ID → canonical model/runtime definition                                    | Registry is code-defined                                               | `MODEL_NOT_FOUND`, disabled/incompatible target                                             |
| 8. Runtime eligibility       | `store.ts` — `requireModelRuntimeAdapter`; `services/api/src/inference/model-runtime.ts` — `healthCheck`   | Binding candidate → real readiness and inference probe                               | Failed attempt/audit diagnostic only; active binding unchanged         | `RUNTIME_UNAVAILABLE`, `MODEL_NOT_INSTALLED`, identity mismatch, timeout, probe failure     |
| 9. Binding persistence       | `store.ts` — `activateAgentModel`; `services/api/src/cp2/postgres-store.ts` — mutation proxy/snapshot save | Passed health result → one active `AgentModelBindingSummary`                         | `cp2_agent_model_bindings`, agent profile/runtime version, audit event | Activation conflict or persistence failure; prior active binding remains on probe failure   |
| 10. Runtime session          | `store.ts` — `createRuntimeTurn`/`createRuntimeSession`                                                    | Chat request without `runtimeSessionId` → lazy per-user runtime session              | `cp2_runtime_sessions` at chat time                                    | Foreign/expired session, turn limit                                                         |
| 11. Chat submission          | `GrogoniApplication.tsx` — `sendChatDraft`; `routes.ts` — `POST /v1/messages`                              | Conversation message plus agent request → `createAgentConversationMessage`           | User message and eventual assistant message                            | Invalid conversation/auth/content                                                           |
| 12. Agent runtime            | `store.ts` — `createAgentConversationMessage` → `createRuntimeTurn`                                        | Shop/message/history → compiled business-agent turn                                  | Runtime turn, telemetry, messages                                      | `AGENT_MODEL_NOT_CONFIGURED` after unbind; recoverable error guidance                       |
| 13. Model/provider selection | `store.ts` — `resolveActiveRuntimeModelId`, `resolveRuntimeModelProvider`                                  | Agent profile → active verified binding → adapter-backed provider                    | Binding read                                                           | Missing adapter yields `AGENT_MODEL_UNAVAILABLE`; fallback requires saved permission/policy |
| 14. Inference                | `store.ts` — `createRuntimeModelRoute`; `model-runtime.ts` — adapter `generate`                            | Existing context/personality/instructions/history/tools → typed completion           | Runtime telemetry                                                      | Provider exception, unavailable/malformed response, non-qualifying fallback                 |
| 15. Response                 | `store.ts` — policy/tool handling and `storeRuntimeTurn`; `routes.ts` response                             | Parsed response/tool proposal → persisted assistant response and runtime trace       | Conversation message, runtime turn, telemetry/audit                    | Policy/confirmation/tool validation remains authoritative                                   |

Canonical removal follows `GrogoniApplication.removeServerBackendModelFromAgent` →
`DELETE /api/agents/:agentId/model-binding` → `Cp2Store.removeAgentModelBinding` → mark the active
row inactive, revise the profile/runtime version, persist through the existing Postgres snapshot
transaction, return `{ binding: null }`, and refetch/render from the same GET source. Activation does
not create or require a `runtimeSessionId`; runtime sessions remain lazy conversation operational
state.

## Existing architecture audited

### Registry and persistence

- The canonical model catalogue is `aiModelRegistry` in `services/api/src/cp2/store.ts`.
- Installed GGUF records use `InstalledAgentModelSummary` and
  `cp2_installed_agent_models`.
- Legacy device assignments use `AgentModelAssignmentSummary` and
  `cp2_agent_model_assignments`.
- Agent identity, personality, instructions, skills, and the legacy model ID live in
  `BusinessAgentProfileSummary`.
- Normalized CP2 snapshots are persisted by `services/api/src/cp2/postgres-store.ts`.

### Ownership

- A business owns one current business agent profile.
- Membership checks are enforced through `requireAuthorizedSession`.
- Model operations require `membership:manage`; chat requires `business:read`.
- Installed models are additionally bound to account, user, and device.

### UI and feature flags

- `AgentProfileSurface` owns model installation, testing, assignment, and route controls.
- Browser inference is controlled at build time by
  `VITE_BROWSER_LOCAL_INFERENCE_ENABLED`.
- Native bridge, owner-node, and cloud fallback permissions are explicit client settings.
- Browser models download only after explicit enablement.

### Runtime and chat

- `/v1/messages` persists a user message and invokes `createAgentConversationMessage`.
- `createAgentConversationMessage` invokes `createRuntimeTurn`.
- `createRuntimeTurn` builds the shop runtime, retrieves context, compiles instructions and
  personality, asks the model for a typed response/tool proposal, enforces tool policy and
  confirmation, and persists one assistant message.
- `RuntimeModelProvider` was the pre-existing server adapter boundary.
- The browser has provider-neutral routing for browser WebGPU/WASM, installed-app llama.cpp,
  owner-node, and cloud fallback.

### Existing adapters

- OpenAI: server-side Responses API provider with allowlist, timeout, budget, and circuit breaker.
- Browser local: explicit lazy download with capability and cache checks.
- Installed app: web bridge contract through `window.GrogoniAgentModelRuntime`; ordinary browsers
  reject activation.
- Remote shop device: authenticated, tenant/model/agent-bound owner-node broker with heartbeat,
  signed jobs, correlation IDs, replay checks, and timeout.
- Backend Qwen: no production adapter existed before this change.

## Implemented source of truth

`AgentModelBindingSummary` and `cp2_agent_model_bindings` now represent agent-level activation.
Device assignments remain device readiness records and are not interpreted as a global backend
activation.

A binding records:

- agent, shop, account, and canonical model ID;
- `verifying`, `active`, `inactive`, `failed`, or `unavailable` status;
- execution target, mode, fallback policy, and explicit permissions;
- activation and verification timestamps;
- last verification result and bounded error metadata.

The database has a partial unique index allowing only one active binding per agent. Migration 040
preserves previously verified device assignments by migrating the newest ready assignment for each
agent.

## Resulting runtime boundary

When the server adapter system is configured, chat now requires an active verified binding. It no
longer substitutes `grogoniclaw-local` for an unbound agent and no longer uses the deterministic parser
after a bound model fails. The parser and protected tool loop still run after a successful model
completion so existing confirmation gates remain authoritative.

The remaining platform-specific limits are explicit:

- Browser-local activation is unavailable when the deployment flag is off.
- Server activation cannot attest an ordinary browser's local cache.
- Installed-app activation returns `BRIDGE_UNAVAILABLE` unless a trusted bridge-backed adapter is
  supplied.
- Backend activation returns `RUNTIME_UNAVAILABLE` until a real inference endpoint is configured.
