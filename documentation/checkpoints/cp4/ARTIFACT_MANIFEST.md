# CP4 Artifact Manifest

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02

## Created CP4 Artifacts

| Path                                                 | Purpose                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `documentation/checkpoints/cp4/CP4_BASELINE.md`      | Formal CP4 baseline, scope, exit criteria, and rollback instructions. |
| `documentation/checkpoints/cp4/DECISION_LOG.md`      | Rule parser, confidence, clarification, and boundary decisions.       |
| `documentation/checkpoints/cp4/ARTIFACT_MANIFEST.md` | This manifest.                                                        |

## Implemented CP4 Artifacts

| Path                              | Purpose                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `packages/tool-core/src/index.ts` | Parser contract, intent taxonomy, confidence scoring, and slot logic. |
| `apps/web/package.json`           | Adds the web app dependency on `@grogoni/tool-core`.                     |
| `apps/web/src/main.tsx`           | Integrates parser output into the CP3 chat shell.                     |
| `apps/web/src/cp3-shell.ts`       | Updates initial chat copy for CP4 parser behavior.                    |
| `tests/ai-eval/cp4-commands.ts`   | Internal command dataset for parser evaluation.                       |
| `tests/cp4-rule-parser.test.ts`   | Parser, confidence, clarification, and non-mutation tests.            |
| `tests/cp3-shell.test.ts`         | Updated shell contract test for CP4 chat copy.                        |
| `pnpm-lock.yaml`                  | Records the new web-to-tool-core workspace dependency.                |

## CP4 Opening Checklist

- [x] CP3 accepted as passed.
- [x] CP3 checkpoint tag exists locally.
- [x] CP3 commit is pushed to `origin/main`.
- [x] CP4 marked `active` in checkpoint log.
- [x] CP4 baseline created.
- [x] CP4 decision log created.
- [x] CP4 scope excludes model integration, full runtime, business CRUD, payments, marketplace, and TIEL.

## CP4 Completion Checklist

- [x] Rule-based parser implemented.
- [x] Intent taxonomy implemented.
- [x] Confidence scoring implemented.
- [x] Slot extraction implemented.
- [x] Clarification behavior implemented.
- [x] Structured fallback behavior implemented.
- [x] Chat shell integration implemented.
- [x] Safe command completion implemented.
- [x] State-changing intents remain drafts only.
- [x] AI evaluation dataset contains at least 50 commands.
- [x] Parser tests meet acceptance threshold.
- [x] Existing CP1, CP2, and CP3 checks pass.
- [x] `checkpoint/cp4-rule-parser` tag created.

## Verification

- `pnpm run ci`
- `pnpm build`
- parser evaluation threshold check
