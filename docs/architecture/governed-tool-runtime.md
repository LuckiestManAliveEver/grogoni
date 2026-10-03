# Governed tool runtime

This document describes how every Grogoni surface that can act on a business — native chat, MCP,
browser-local inference, and cloud fallback — converges on one governed execution path, and what
changed (and deliberately did not change) to strengthen that convergence. It complements, not
replaces:

- [`chat-tool-execution-boundary.md`](chat-tool-execution-boundary.md) — why browser-local chat is
  structurally incapable of executing a tool, and the three model-selection layers.
- [`client-first-inference.md`](client-first-inference.md) — provider routing, fallback order, and
  browser download mechanics.
- [`context-semantic-runtime.md`](context-semantic-runtime.md) — context retrieval and prompt
  assembly.

## The governing principle

> Everything is an API. Every API can become a tool. Every tool executes through one governed
> runtime.

This was already true in the repository before this change. The audit behind this document found
one canonical tool registry (`runtimeToolRegistry`, `packages/tool-core/src/index.ts`), one
execution pipeline (`Cp2Store.createRuntimeTurn` / `executeRuntimeAction`,
`services/api/src/cp2/store.ts`), and one MCP surface that calls into that same pipeline rather
than duplicating it. What was missing was metadata _on_ that registry (a description and typed
input schema per tool, and an explicit MCP-exposure flag) and a shared vocabulary for inference
failures across the three inference surfaces. Both gaps are additive; nothing about how a tool
call is authorized, confirmed, or executed changed.

## Request lifecycle (unchanged)

```
User / Channel (native chat, MCP, browser, storefront)
      |
      v
Cp2Store.createRuntimeTurn                 services/api/src/cp2/store.ts
      |  parses the message (parseMerchantCommand / a context script / the model)
      |  into a RuntimeToolProposal naming one RuntimeToolName
      v
runtimeToolRegistry[proposal.toolName]      packages/tool-core/src/index.ts
      |  risk, requiresConfirmation, readOnly, requiredPermission,
      |  description, inputSchema, mcpExposable (the last three are new)
      v
enforceAgentPolicy + role/permission check   services/api/src/cp2/agent-business-runtime.ts
      |
      v
needs_confirmation? --yes--> persist plan + confirmationToken, stop (no side effect yet)
      |no
      v
executeRuntimeAction                         services/api/src/cp2/store.ts
      |  dispatches to the canonical domain service (createProduct, createCustomer,
      |  sendChannelMessage, ...) - the same service every REST endpoint uses
      v
RuntimeTurnSummary { plan, verification, model, toolResult, telemetry }
```

A confirmation resumes through the exact same `createRuntimeTurn` call (with a
`confirmationToken`), not a second path — a model cannot fabricate approval by itself, and no
second model invocation can substitute for the stored token.

## Convergence, verified per surface

| Surface        | Entry point                                                                                           | Converges via                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native chat    | `POST /businesses/:id/runtime/turns`                                                                  | calls `createRuntimeTurn` directly                                                                                                                                                                                                                              |
| MCP            | `tools/call` → `grogoni.runtime_turn` / `grogoni.confirm_runtime_action` (`services/api/src/mcp/routes.ts`) | calls `store.createRuntimeTurn` with the same arguments a REST caller would use                                                                                                                                                                                 |
| Browser-local  | `generateBrowserAgentResponse` (`apps/web/src/browser-inference-session.ts`)                          | structurally cannot execute a tool — its result type has no tool-proposal field (see `chat-tool-execution-boundary.md`); any actionable request is routed server-side before inference runs                                                                     |
| Cloud fallback | `createCloudFallbackProvider` (`services/api/src/inference/cloud-fallback.ts`)                        | is a `RuntimeModelProvider`, one of several the _router_ (`Cp2Store.createRuntimeModelRoute`) may call — it proposes text/tool JSON like any other provider; the proposal still passes through the same registry and policy gate above before anything executes |

No surface has its own copy of tool definitions, its own authorization check, or its own
confirmation mechanism.

## What changed

### 1. The tool registry now carries introspectable metadata

`RuntimeToolDefinition` (`packages/tool-core/src/index.ts`) gained three fields on every one of
the 20 existing entries:

- `description: string` — a one-line, human/model-readable summary of what the tool does.
- `inputSchema: { type: "object", properties: Record<string, { type, required?, description }> }`
  — a minimal, hand-rollable JSON-Schema-compatible shape (deliberately not a validation-library
  dependency), accurate to what each tool's proposal builder and `executeRuntimeAction` branch
  actually read from `input`.
- `mcpExposable: boolean` — currently `false` on every entry. This is a statement of _current
  fact_, not a policy default to route around: the existing MCP surface does not call any of these
  20 tool names directly today (see the table above), so nothing changed about what MCP can do.
  The field exists so that a future, deliberate decision to expose one specific tool as its own
  MCP-callable entry is a one-line, reviewable change with an obvious place to make it, instead of
  an accidental default. `mcpSchemaForRuntimeTool(name)` adapts a definition into the exact shape
  `services/api/src/mcp/routes.ts` already hand-writes for its other tools, for when that decision
  is made.

No input validation logic was added or changed. `packages/tool-core/src/index.ts` already has a
thorough, tool-specific validator (`validateRuntimeToolInput`, used for model-proposed calls via
`parseRuntimeModelOutput`) and each deterministic proposal builder
(`createRuntimeToolProposal` and its context-script variants) already validates its own required
fields with a situation-specific clarification message ("Which product should I delete?"). An
earlier draft of this change added a second, schema-driven validator; it was removed once this
existing coverage was found, per the standing rule to evolve an existing mechanism rather than add
a competing one.

### 2. A shared, provider-neutral inference error taxonomy

`packages/shared-types/src/index.ts` gained `RuntimeInferenceErrorCategory`,
`RuntimeInferenceError`, and `normalizeInferenceErrorCode(code)`. The repository has three
independent, already-shipping error vocabularies — server model adapters and cloud fallback
(`MODEL_PROVIDER_TIMEOUT`, `CLOUD_TIMEOUT`, `INVALID_INFERENCE_RESPONSE`, ...,
`services/api/src/inference/`) and browser-local inference (`BrowserInferenceErrorCode`,
`apps/web/src/browser-inference-types.ts`) — and no shared way to reason about "a timeout
happened" independent of which of the three produced it. `normalizeInferenceErrorCode` maps every
existing code from all three into one coarse category set (`TIMEOUT`, `ENGINE_UNREACHABLE`,
`MODEL_NOT_INSTALLED`, `MODEL_LOADING`, `MODEL_UNAVAILABLE`, `CONTEXT_WINDOW_EXCEEDED`,
`EMPTY_RESPONSE`, `INVALID_RESPONSE`, `INVALID_TOOL_CALL`, `RATE_LIMITED`,
`AUTHENTICATION_FAILED`, `PROVIDER_ERROR`, `ABORTED`, `UNKNOWN`). Nothing that currently throws or
returns one of the specific codes was changed; this is a pure additive mapping function, not yet
wired into any call site, available for future telemetry or client messaging that wants a
provider-independent view.

## What was deliberately not done

The source prompt for this change asked for a much larger set of changes: provider-neutral
streaming (`RuntimeModelChunk`), a shared stream assembler, provider-neutral content blocks
(`RuntimeContentBlock`), and a multi-step agent loop (multiple model/tool steps within one turn,
with step/call budget limits). None of these were implemented.

Why: the audit found `createRuntimeTurn` already implements one plan → one policy/confirmation
gate → one execution per turn, is heavily tested (`tests/cp10-grogoniclaw-runtime.test.ts`,
`tests/agent-business-runtime.test.ts`, and others), and every current inference adapter is
non-streaming already (each `RuntimeModelProvider.complete()` call already returns one complete
result — see "one adapter call = one provider attempt" below). Building a streaming protocol with
no current streaming consumer, or a multi-step loop on top of a single-plan-per-turn model that
every existing test assumes, would be exactly the kind of speculative, unrequested architecture
the source prompt separately says not to add. If a real need for multi-step tool chaining or
token-level streaming emerges, it should be scoped as its own change against the actual consumer
that needs it, not spun up preemptively here.

## Invariant already verified, not changed: one adapter call = one provider attempt

`ModelRuntimeAdapter.generate()` (`services/api/src/inference/model-runtime.ts`) and
`createRuntimeModelRoute` (`services/api/src/cp2/store.ts`) each call
`provider.complete(prompt)` exactly once per attempt; fallback-vs-retry decisions live in the
router (`createRuntimeModelRoute`'s `fallbackUsed`/`fallbackReason` tracking and
`model.fallback` telemetry), not inside an adapter. The one intentional exception is
`createCloudFallbackProvider`'s own bounded (max 2 attempts), same-provider, circuit-broken retry
on a transient OpenAI error — this does not switch providers or escalate models, so it is
transport-level resilience, not routing policy, and was left as-is per the instruction to refactor
adapters only where they mix transport concerns with routing policy.

## Verification

- `tests/runtime-tool-registry.test.ts` — every tool has a description and input schema, no tool
  is MCP-exposable yet (a regression test, so flipping one is a deliberate, reviewed change),
  read-only tools never require confirmation, critical-risk tools always do, and
  `mcpSchemaForRuntimeTool` produces MCP's existing schema shape.
- `tests/runtime-inference-error-taxonomy.test.ts` — every currently-shipping error code from all
  three inference surfaces normalizes to the expected category, and an unrecognized code
  normalizes to `UNKNOWN` rather than throwing.
- `tests/cp10-grogoniclaw-runtime.test.ts`, `tests/agent-business-runtime.test.ts`,
  `tests/cp11-local-model-adapter.test.ts`, `tests/receipt-ocr.test.ts` — unchanged, all still
  pass, confirming the registry metadata addition did not alter tool execution, confirmation, or
  policy behavior.
