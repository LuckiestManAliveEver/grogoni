# CP14 Artifact Manifest

Status: passed
Date opened: 2026-07-05
Date passed: 2026-07-05

## Created CP14 Artifacts

| Path                                                  | Purpose                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `documentation/checkpoints/cp14/CP14_BASELINE.md`     | Formal CP14 baseline, scope, exit criteria, and rollback rules.                    |
| `documentation/checkpoints/cp14/DECISION_LOG.md`      | Security, compliance, verification, tax, TIEL-preparation, and boundary decisions. |
| `documentation/checkpoints/cp14/ARTIFACT_MANIFEST.md` | This manifest.                                                                     |
| `documentation/CP14_SECURITY_COMPLIANCE.md`           | Implemented CP14 workflows, API surface, and runtime boundaries.                   |

## CP14 Opening Checklist

- [x] CP13 accepted as passed.
- [x] CP13 checkpoint tag exists locally and on GitHub.
- [x] CP13 commits are pushed to `origin/main`.
- [x] CP14 marked `active` in checkpoint log.
- [x] CP14 baseline created.
- [x] CP14 decision log created.
- [x] CP14 scope excludes full TIEL implementation, biometric identity verification, production provider integrations, closed beta operations, public launch, marketplace trust workflows, and model-driven compliance actions.

## CP14 Completion Checklist

- [x] RBAC enforcement review completed.
- [x] Audit log review completed and high-risk action gaps fixed.
- [x] Sensitive data logging and prompt-context scan completed.
- [x] Data export workflow implemented.
- [x] Account deletion and anonymization workflow implemented.
- [x] Compliance retention rules implemented.
- [x] Verification tier contracts and deterministic update rules implemented.
- [x] Country tax configuration implemented.
- [x] Device trust placeholder implemented if TIEL remains deferred.
- [x] TIEL design alignment documented.
- [x] CP14 tests implemented.
- [x] Existing CP1 through CP13 checks pass.
- [x] `checkpoint/cp14-security-compliance` tag created.

## Verification

Opening verification:

- [x] `pnpm run ci`

Passed verification:

- `pnpm --filter @grogoni/shared-types typecheck`
- `pnpm --filter @grogoni/business-core typecheck`
- `pnpm --filter @grogoni/api typecheck`
- `pnpm --filter @grogoni/web typecheck`
- `pnpm vitest run tests/cp14-security-compliance.test.ts tests/cp13-logistics.test.ts tests/cp12-reports-knowledge.test.ts tests/cp3-shell.test.ts --reporter=dot`
- `pnpm run ci`
