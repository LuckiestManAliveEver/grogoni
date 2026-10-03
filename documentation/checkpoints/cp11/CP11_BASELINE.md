# CP11: llama.cpp Local Model Adapter

Status: passed
Date opened: 2026-07-04
Date passed: 2026-07-04
Target tag: `checkpoint/cp11-local-model-adapter`
Actual tag: `checkpoint/cp11-local-model-adapter`

## Purpose

CP11 attaches a local llama.cpp-compatible model adapter behind the CP10 Grogoniclaw Runtime contract.

The goal is to let the runtime use a local model for language understanding and response generation while preserving CP10's deterministic planning, verification, confirmation, telemetry, and business mutation boundaries.

CP11 is a local model adapter checkpoint. It is not a model training checkpoint, hosted LLM provider checkpoint, autonomous write checkpoint, production model-selection checkpoint, compliance hardening checkpoint, marketplace automation checkpoint, or TIEL checkpoint.

## Formal Entry From CP10

CP10 is accepted as passed.

CP11 starts from:

- CP10 runtime sessions, turns, planning, verification, confirmation gates, telemetry, rate limits, and web chat
- CP4 deterministic parser and fallback behavior
- CP5 through CP9 deterministic commerce, payment, sync, and import validators
- shared runtime contracts in `packages/shared-types`
- deterministic tool registry and planner support in `packages/tool-core`
- API runtime session and turn endpoints
- existing AI runtime service package boundary
- existing CI, lint, typecheck, tests, and boundary checks

## CP11 Scope

In scope:

- local model provider interface behind the CP10 runtime contract
- llama.cpp-compatible adapter boundary for prompt input and model output
- configurable local model endpoint or command adapter suitable for development
- deterministic timeout, retry, and failure behavior
- prompt assembly that uses least-necessary business-scoped context
- response parsing that cannot directly mutate business records
- fallback to CP10 deterministic planning when local model inference is unavailable
- telemetry for adapter availability, latency, failure mode, and fallback decisions without logging sensitive plaintext
- tests for adapter success, timeout, malformed output, fallback, and mutation-boundary preservation
- documentation for local development setup and model placement/configuration

Out of scope:

- model download automation
- model training, fine-tuning, quantization, or benchmark tuning
- GPU/CPU performance optimization beyond basic timeout and configuration controls
- production hosted LLM provider choice
- autonomous writes without explicit confirmation
- live payment provider actions
- marketplace automation
- TIEL
- broad compliance retention, privacy, and red-team hardening beyond CP11 adapter telemetry boundaries
- replacing CP10 deterministic verification, confirmation gates, or tool adapters

## Target Flow

```text
Owner sends a message
  -> CP10 runtime creates a turn
  -> context builder gathers least-necessary business-scoped context
  -> local model adapter receives a bounded prompt
  -> adapter returns structured model output or a deterministic failure
  -> runtime parses output into draft plan, clarification, or response text
  -> verifier enforces role, risk, input validation, and confirmation gates
  -> business mutations still route only through deterministic adapters
  -> unavailable or invalid model output falls back to CP10 deterministic behavior
  -> telemetry records adapter state, timing, and fallback decisions
```

## Business Rules

- Local model output must never directly mutate business records.
- All business mutations must continue to route through CP5 through CP9 validators and CP10 tool adapters.
- High and critical risk tools must still require explicit confirmation.
- The model adapter must be optional and fail closed into deterministic fallback behavior.
- Runtime context sent to the adapter must be business-scoped and least-necessary.
- Model prompts and outputs must not be logged as sensitive plaintext telemetry.
- Adapter timeouts and malformed output must produce deterministic runtime states.
- CP11 must preserve CP4 parser behavior and CP10 runtime verification behavior.

## CP11 Exit Criteria

CP11 can be marked passed when:

- [x] Local model provider interface exists behind the CP10 runtime contract.
- [x] llama.cpp-compatible adapter can be configured for local development.
- [x] Prompt assembly uses business-scoped, least-necessary runtime context.
- [x] Model output is parsed into response text, clarification, or draft plan without direct writes.
- [x] Adapter failures, timeouts, and malformed responses fall back deterministically.
- [x] Verification still enforces risk, role, input validation, and confirmation gates.
- [x] High and critical risk tools still require explicit confirmation.
- [x] Runtime telemetry records adapter state without sensitive plaintext prompts or outputs.
- [x] Tests cover successful inference, unavailable adapter, timeout, malformed output, and mutation-boundary preservation.
- [x] Web/runtime behavior exposes local-model-backed responses without regressing CP3 or CP10 behavior.
- [x] Existing CP1 through CP10 checks still pass.
- [x] Checkpoint tag `checkpoint/cp11-local-model-adapter` is created.

## Rollback Instructions

Rollback target:

- Return to CP10 runtime adapter behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP3 shell behavior.
- Preserve CP4 deterministic parser behavior.
- Preserve CP5 through CP9 deterministic business workflows.
- Disable local model adapter configuration and force deterministic CP10 fallback.

Rollback trigger examples:

- model output mutates business data without deterministic validators
- high or critical risk tool calls execute without confirmation
- model prompt context leaks data across businesses
- telemetry logs sensitive prompts, outputs, or merchant records in plaintext
- adapter failures block deterministic CP10 fallback
- CP4 parser behavior regresses
- CP10 runtime verification behavior regresses
- CP1 through CP10 checks regress

## Next Checkpoint

Next checkpoint:

- CP12: Reports, Notifications, and Knowledge Layer

CP12 should build reporting and knowledge workflows on top of stable CP10 runtime boundaries and the CP11 local adapter.
