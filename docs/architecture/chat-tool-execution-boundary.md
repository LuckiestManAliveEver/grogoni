# Chat tool-execution boundary

This document exists because the two chat pipelines and three model-selection layers in this
repository are each individually documented, but the boundary _between_ them — which one can
actually execute a business action, and why the other cannot even if a user asks it to — was not
written down anywhere. It complements, not replaces:

- [`docs/model-activation-runtime.md`](../model-activation-runtime.md) — the server-side
  test/verify/activate API for `cp2_agent_model_bindings`.
- [`docs/architecture/client-first-inference.md`](client-first-inference.md) — provider routing,
  fallback order, and browser download mechanics.

## Two pipelines, not one — plus a local-execution variant of the server one

> **Correction (this section was wrong from 2026-08-13 to the date of this edit):** the table
> below originally claimed browser-local inference is "structurally incapable" of producing a
> tool proposal because `BrowserGenerationResult` has no tool field. That is still true for the
> plain conversational path, but `954e4c3` ("Enable browser GGUF tool handoff", 2026-08-13) added
> a second browser-local path that this document never covered: when
> `requestRequiresServerTool(message)` is true, the client still runs inference on-device
> (`browser-webgpu` / `browser-wasm` / `native-llama-cpp`), but then submits the raw generated text
> to the server as `RuntimeTurnBody.clientInferenceCompletion`
> (`apps/web/src/hooks/useChatRuntimeState.ts`, `createClientInferenceModelRoute` in
> `services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts`). The server parses that
> text with the exact same `parseRuntimeModelOutput` used for a real server-model response, so it
> **can** yield a `RuntimeToolProposal`. This does not weaken governance — the resulting proposal
> still passes through the identical `enforceAgentPolicy` → confirmation-token → `executeRuntimeAction`
> gate as any other proposal (see the paragraph after the table) — but the earlier "no code path
> into `executeRuntimeAction`" claim was factually wrong for this case and is corrected here
> instead of left standing.

|                                | Server-mediated chat                                                           | Browser-local chat (plain)                                                         | Browser-local chat (tool-shaped request)                                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point                    | `POST /businesses/:id/runtime/turns` (`createRuntimeTurn`)                     | `generateBrowserAgentResponse` (`apps/web/src/browser-inference-session.ts`)       | Same on-device generation, then `runRoutedRuntimeTurn` submits `clientInferenceCompletion` to `POST /businesses/:id/runtime/turns` (`apps/web/src/hooks/useChatRuntimeState.ts`)                                                                                                                          |
| Runs on                        | The API server, using the shop's activated model binding                       | Entirely in the browser tab, using a downloaded on-device model                    | Generation runs on-device; the server only parses/authorizes the reported output                                                                                                                                                                                                                          |
| Routing trigger                | Default when browser inference is unavailable/disabled                         | `requestRequiresServerTool(message)` is false and a local model is ready           | `requestRequiresServerTool(message)` is true and a local model is ready (`browser-inference-routing.ts`)                                                                                                                                                                                                  |
| Output shape                   | `RuntimeModelOutputParseResult`: `"response"` \| `"clarification"` \| `"tool"` | `BrowserGenerationResult`: `{ text: string, ... }` — no tool field, rendered as-is | The reported `outputText` is re-parsed server-side into the same `RuntimeModelOutputParseResult` union                                                                                                                                                                                                    |
| Can execute a business action? | Yes, after `enforceAgentPolicy` and confirmation gating                        | **No** — no code path from this result into `executeRuntimeAction`                 | **Yes, after the same `enforceAgentPolicy` and confirmation gating** — verified by `requireReadyClientInferenceCompletion` first (the completion must match a `READY` device/browser assignment for that exact account+user+model+runtime, or it's rejected with `409 CLIENT_MODEL_ASSIGNMENT_NOT_READY`) |
| Authorization                  | `requireAuthorizedSession`, tenant/role checks, per-tool policy                | None needed for execution, because none is possible                                | Same as server-mediated chat, plus the device/browser-assignment match above                                                                                                                                                                                                                              |

A model-proposed tool call is never trusted on its own anywhere in this system regardless of which
column produced it — see `docs/agent-context-instructions-personality.md` and the runtime-turn
pipeline (`services/api/src/cp2/domains/agent-runtime/store.ts`, `enforceAgentPolicy`) for the full
policy/confirmation chain. Only the middle column (plain browser-local chat, the common case for an
ordinary question) is structurally incapable of proposing a tool at all; the right column is
policy-blocked the same way server-mediated chat is, not structurally prevented.

## How a message gets routed between them

`decideInferenceRoute` (`apps/web/src/browser-inference-routing.ts`) decides per message, before
any inference runs:

```
requiresServerTool(message)   → route: "server" (or "native" if a bridge is ready)
complexReasoning / tab hidden → route: "server"
device unsupported            → route: "server"
prompt exceeds context window → route: "server"
model not loaded/ready        → route: "server"
otherwise                     → route: "browser-local"
```

`requestRequiresServerTool` is a keyword heuristic (`create|add|delete|remove|update|change|refund
|pay|send|invite|sync|order|receipt`, case-insensitive). It is a _routing convenience_, not the
safety boundary — it exists so obviously-actionable requests are routed to the tool-capable path
(the right column above) so a real action can actually happen. The actual safety boundary is the
structural one from the table: a message the heuristic **misses** (falls through to "otherwise")
takes the plain browser-local path, whose result type has no tool field, so it can only ever
produce `{ text }` — it never reaches `clientInferenceCompletion` or `executeRuntimeAction` at all.
The realistic residual risk of a heuristic miss is therefore the on-device model **hallucinating**
a reply that claims an action happened ("I've added the product for you") when nothing did — a
trust/UX problem to watch for in prompt design and user messaging, not a security hole. A heuristic
_false positive_ (an ordinary question misrouted to the tool-capable path) carries no extra risk
either, since that path still requires `enforceAgentPolicy` and confirmation before anything
executes — at worst it costs one unnecessary round trip.

## The three model-selection layers

Reading the code in isolation, `cp2_agent_model_bindings`, `agentModelAssignments`, and
`activeAiModels` look like three overlapping ways to pick a model. They are not — each has a
distinct, non-overlapping job, enforced by the actual UI flow
(`apps/web/src/GrogoniApplication.tsx`), not just by convention:

1. **`cp2_agent_model_bindings`** (`AgentModelBindingSummary`) — the canonical binding for
   provider-neutral execution targets (`backend`, `browser-local`, installed-app native bridge,
   and `remote-shop-device`). Set only via `POST /api/agents/:agentId/models/:modelId/activate`, which
   re-runs a real inference health check before flipping the binding to `active`
   (`store.ts:3492`, `requireModelRuntimeAdapter(...).healthCheck(...)`). This is what
   `Cp2Store.resolveActiveRuntimeModelId` checks first when a runtime turn needs a model.
2. **`agentModelAssignments`** (`PUT /businesses/:id/agent-model`, `assignAgentModel`) — tracks
   whether a _device-local_ model (browser-downloaded or installed-app) has actually completed a
   real inference successfully. The frontend gate that matters:
   `agentModelAssignment.lastSuccessfulInferenceAt !== null && runtimeBackend !== "CLOUD"`
   (`GrogoniApplication.tsx:13195`) — a device model is not considered "ready" until it has proven
   itself with a real completion, mirroring the health-check discipline of layer 1 at the device
   level.
3. **`activeAiModels`** (`PUT /businesses/:id/ai-model`, `activateAiModel`) — the **hosted fallback
   model** selector only. It is never the primary model source; it is only consulted by
   `resolveActiveRuntimeModelId` as a last-resort model ID when no verified binding (layer 1)
   exists.

> **Correction (2026-08-29):** this section originally said "the UI blocks setting a hosted
> fallback model until layer 2 reports a ready local model" and that none of the three layers is
> reachable without a prior real-inference success gate. Neither is still true. Zero-setup hosted
> execution (`docs/architecture/native-agent-model-runtime.md`) removed the local-model
> prerequisite from ordinary chat, and its own gate is deliberately weaker than layers 1-2's: `
AgentRuntimeDomain.ensureDefaultRuntimeForTurn` (`store.ts`) only requires a configured adapter's
> `canRun(...)` to report available — an advisory availability probe, not a completed real
> inference — before `NativeRuntimeBindingStore.ensureDefaultRuntimeBinding` provisions a binding.
> This is intentional: the alternative is a real inference call, with its cost and latency, on
> every fresh account before the first message can even be attempted. The residual risk is the same
> shape as the heuristic-miss risk two sections up - a `canRun: true` adapter can still fail its
> first real `generate` call - which is why that failure is retryable and falls through the
> ordered execution-target chain (`docs/architecture/native-agent-model-runtime.md#resolution-and-fallback`)
> rather than being treated as fatal. Layers 1 and 2 above still gate on a completed real inference
> exactly as described; only the zero-setup provisioning path trades that guarantee for
> zero-setup availability.

## Verification

- Server-side auto-install and its own fail-fast gate:
  `services/ai-runtime/scripts/start-inference.sh`, `services/ai-runtime/scripts/model-admin.mjs`.
- Browser download, license gate, GGUF signature check:
  `apps/web/src/ai-model-manager.ts` (`downloadCatalogModel`, `importCustomGgufModel`).
- Verified server-side activation: `tests/model-activation-runtime.test.ts` — "tests real adapter
  output, activates a canonical binding, and survives hydration"; "routes agent chat through the
  active binding with shop instructions and records metadata"; "rejects unbound chat, cross-shop
  activation, browser activation, and absent bridges".
- Real deployed-model round trip (opt-in, not run as part of this doc's review):
  `tests/live-render-model-runtime.test.ts`, gated behind `RUN_LIVE_MODEL_RUNTIME_TEST=true`.
- Browser routing to/away from tool-shaped requests: `apps/web/src/browser-inference-routing.ts`
  (`decideInferenceRoute`, `requestRequiresServerTool`).
- Structural text-only browser output (the plain, non-tool-shaped path only):
  `BrowserGenerationResult` in `apps/web/src/browser-inference-types.ts`.
- The tool-shaped path goes through the same policy/confirmation gate, and
  `requireReadyClientInferenceCompletion` (`runtime-model-routing.ts`) rejects a mismatch against
  an _existing_ ready assignment, not just a missing one: `tests/browser-inference-assignment.test.ts`
  — "accepts a ready browser model proposal only through the canonical policy and confirmation
  pipeline"; "rejects client model output that does not match a ready device assignment"; "rejects
  a browser completion whose modelId/runtime does not match the device's ready assignment"; "accepts
  an installed-app completion only through a matching ready installation+assignment"; "rejects an
  installed-app completion whose modelId/runtime does not match the ready installation" — the last
  four close what was previously a coverage gap (every earlier rejection test hit only the "no
  assignment exists at all" branch, and the `installationId`/installed-app identity-check branch had
  no coverage at all).

## What this document is _not_ reporting as a gap

An earlier pass flagged the three model-selection layers above as a possible sign of overlapping,
unclear mechanisms worth auditing. On tracing the actual frontend gating logic
(`GrogoniApplication.tsx`), that concern did not hold up: each layer has a distinct job and its own
real-inference gate. No code change was made here — this document replaces that earlier informal
concern with the traced, verified explanation, so it does not need re-investigating later.
