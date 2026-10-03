# CP10: Grogoniclaw Runtime Full Adapter

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03
Target tag: `checkpoint/cp10-grogoniclaw-runtime`
Actual tag: `checkpoint/cp10-grogoniclaw-runtime`

## Purpose

CP10 introduces the Grogoniclaw Runtime full adapter on top of the deterministic commerce, parser, sync, payment, and import foundations from CP2 through CP9.

The goal is to move from a simple rule parser to a structured runtime that can plan, route intents, build context, propose tool calls, verify risk, require confirmation for sensitive actions, and generate responses without allowing model output to mutate business data directly.

CP10 is a runtime adapter checkpoint. It is not a local model checkpoint, llama.cpp integration checkpoint, provider-specific model checkpoint, broad autonomous agent checkpoint, TIEL checkpoint, production compliance checkpoint, or marketplace automation checkpoint.

## Formal Entry From CP9

CP9 is accepted as passed.

CP10 starts from:

- CP2 authenticated session, active business, membership, role, and audit event contracts
- CP3 owner web shell and chat shell
- CP4 deterministic parser, intent taxonomy, confidence scoring, clarification, and non-mutating draft behavior
- CP5 product, customer, supplier, inventory quantity, and inventory movement foundations
- CP6 invoice drafts, previews, confirmation, invoice items, sale stock movements, deterministic totals, and print view
- CP7 offline cache, durable sync queue, idempotent replay, and deterministic conflict surfacing
- CP8 payment records, invoice settlement, and customer debt summaries
- CP9 supplier CSV import, preview, correction, confirmation, source metadata, and import lifecycle events
- shared-types, business-core, event-core, sync-core, tool-core, API, AI runtime, and web package boundaries
- PostgreSQL migration path and existing in-memory API test store
- CI, lint, typecheck, tests, build, and boundary checks

## CP10 Scope

In scope:

- Grogoniclaw Runtime API contract
- conversation manager for runtime sessions and turns
- context builder for business-scoped, least-necessary runtime context
- intent router that can combine CP4 parser output with runtime planning
- planner that produces explicit draft actions instead of direct writes
- tool executor adapter around existing deterministic business tools
- verification engine for risk, confirmation, role, and validation gates
- response generator for user-facing summaries, clarifications, and confirmation prompts
- runtime telemetry for state transitions, tool proposals, verification outcomes, and errors
- agent action rate limits
- AI evaluation dataset expansion for runtime flows
- optional Pi/OpenClaw-style harness adapter behind `AgentHarnessAdapter`
- tests proving high and critical risk tools require confirmation
- tests proving model/runtime output cannot directly mutate business data

Out of scope:

- llama.cpp local model adapter
- model download, quantization, or GPU/CPU tuning
- production provider selection for hosted LLMs
- autonomous writes without explicit confirmation
- live payment provider actions
- marketplace automation
- TIEL
- broad compliance retention, privacy, and red-team hardening beyond CP10 telemetry boundaries
- replacing CP4 deterministic parser or CP5 through CP9 validators

## Target Flow

```text
Owner sends a message
  -> runtime creates a turn
  -> context builder gathers business-scoped context
  -> intent router classifies the request
  -> planner proposes draft action or clarification
  -> verifier checks role, risk, required confirmation, and tool input validity
  -> low-risk safe actions may execute through deterministic adapters
  -> high/critical-risk actions return a confirmation prompt
  -> confirmed actions execute through existing validators only
  -> response generator explains result, next action, or failure
  -> telemetry records every runtime state transition
```

## Business Rules

- Runtime sessions and turns must always be scoped to the active business and authenticated user.
- Model or runtime text must never directly mutate business records.
- All business mutations must route through existing deterministic validators and API/store boundaries.
- High and critical risk tools must require explicit confirmation.
- Runtime plans must be inspectable before execution.
- Tool input must be validated before execution.
- Runtime context must not leak data across businesses.
- Runtime telemetry should log state, IDs, decisions, and error codes rather than sensitive source content.
- Rate limits must prevent unbounded agent action loops.
- CP10 must preserve CP4 parser behavior and CP5 through CP9 business workflows.

## CP10 Exit Criteria

CP10 can be marked passed when:

- [x] Runtime shared contracts exist.
- [x] Runtime API exposes session/turn endpoints.
- [x] Conversation manager records runtime sessions and turns.
- [x] Context builder gathers business-scoped context without cross-business leakage.
- [x] Intent router preserves CP4 deterministic parser fallback behavior.
- [x] Planner emits draft actions, clarifications, or safe read actions.
- [x] Tool executor adapter routes actions through deterministic validators.
- [x] Verification engine enforces risk, role, input validation, and confirmation gates.
- [x] High and critical risk tools require explicit confirmation.
- [x] Runtime output cannot directly mutate business data.
- [x] Runtime telemetry records state transitions needed for debugging.
- [x] Agent action rate limits exist.
- [x] AI evaluation dataset covers runtime flows and configured task-completion gates.
- [x] Web/chat shell exposes the runtime path without regressing CP3 behavior.
- [x] Existing CP1 through CP9 checks still pass.
- [x] Checkpoint tag `checkpoint/cp10-grogoniclaw-runtime` is created.

## Rollback Instructions

Rollback target:

- Return to CP9 document import behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP3 shell behavior.
- Preserve CP4 deterministic parser behavior.
- Preserve CP5 through CP9 deterministic business workflows.
- Disable runtime endpoints or route chat back to CP4 parser-only behavior.

Rollback trigger examples:

- runtime output mutates business data without deterministic validators
- high or critical risk tool calls execute without confirmation
- runtime context leaks data across businesses
- telemetry logs sensitive source content in plaintext
- agent loops can execute unbounded tool actions
- CP4 parser behavior regresses
- CP5 through CP9 business workflows regress
- CP1 through CP9 checks regress

## Next Checkpoint

Next checkpoint:

- CP11: llama.cpp Local Model Adapter

CP11 should attach a local model behind the CP10 runtime contract without changing deterministic business mutation boundaries.
