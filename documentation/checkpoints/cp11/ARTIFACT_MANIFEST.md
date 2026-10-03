# CP11 Artifact Manifest

Status: passed
Date opened: 2026-07-04
Date passed: 2026-07-04

## Created CP11 Artifacts

| Path                                                  | Purpose                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `documentation/checkpoints/cp11/CP11_BASELINE.md`     | Formal CP11 baseline, scope, exit criteria, and rollback rules.          |
| `documentation/checkpoints/cp11/DECISION_LOG.md`      | Local model adapter, fallback, telemetry, and safety-boundary decisions. |
| `documentation/checkpoints/cp11/ARTIFACT_MANIFEST.md` | This manifest.                                                           |

## Implemented CP11 Artifacts

| Path                                      | Purpose                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `services/ai-runtime/src/local-model.ts`  | llama.cpp-compatible provider, prompt builder, timeout handling, and failure mapping.      |
| `services/ai-runtime/src/app.ts`          | Exports local model adapter helpers from the AI runtime service boundary.                  |
| `services/api/src/cp2/store.ts`           | Optional model-provider runtime integration, bounded fallback, model trace, and telemetry. |
| `services/api/src/cp2/routes.ts`          | Awaits async runtime turn creation while preserving CP2 error handling.                    |
| `packages/shared-types/src/index.ts`      | Shared model adapter prompt, completion, provider, trace, and telemetry types.             |
| `packages/tool-core/src/index.ts`         | Bounded model output parsing and runtime tool-input validation support.                    |
| `tests/cp11-local-model-adapter.test.ts`  | Adapter success, fallback, timeout, malformed output, and safety tests.                    |
| `documentation/CP11_LOCAL_MODEL_SETUP.md` | Local development setup and configuration notes for llama.cpp adapter.                     |

## CP11 Opening Checklist

- [x] CP10 accepted as passed.
- [x] CP10 checkpoint tag exists locally and on GitHub.
- [x] CP10 commits are pushed to `origin/main`.
- [x] CP11 marked `active` in checkpoint log.
- [x] CP11 baseline created.
- [x] CP11 decision log created.
- [x] CP11 scope excludes model download automation, quantization, production provider selection, autonomous writes, marketplace automation, and TIEL.

## CP11 Completion Checklist

- [x] Local model provider interface implemented.
- [x] llama.cpp-compatible local adapter implemented.
- [x] Local adapter configuration documented.
- [x] Prompt assembly uses least-necessary business-scoped context.
- [x] Model output parsed into bounded runtime shapes.
- [x] Adapter failures, timeouts, and malformed output fall back deterministically.
- [x] Verification gates remain enforced for model-derived plans.
- [x] High and critical risk confirmation tests still pass.
- [x] Runtime telemetry records adapter state without sensitive plaintext.
- [x] CP11 adapter tests implemented.
- [x] Existing CP1 through CP10 checks pass.
- [x] `checkpoint/cp11-local-model-adapter` tag created.

## Verification

Passed verification:

- `pnpm --filter @grogoni/shared-types typecheck`
- `pnpm --filter @grogoni/tool-core typecheck`
- `pnpm --filter @grogoni/api typecheck`
- `pnpm --filter @grogoni/ai-runtime typecheck`
- `pnpm vitest run tests/cp11-local-model-adapter.test.ts --reporter=dot`
- `pnpm run ci`
