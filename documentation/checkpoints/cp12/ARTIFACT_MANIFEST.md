# CP12 Artifact Manifest

Status: passed
Date opened: 2026-07-04
Date passed: 2026-07-04

## Created CP12 Artifacts

| Path                                                  | Purpose                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `documentation/checkpoints/cp12/CP12_BASELINE.md`     | Formal CP12 baseline, scope, exit criteria, and rollback rules.              |
| `documentation/checkpoints/cp12/DECISION_LOG.md`      | Reports, notifications, knowledge, provider, and runtime-boundary decisions. |
| `documentation/checkpoints/cp12/ARTIFACT_MANIFEST.md` | This manifest.                                                               |

## Implemented CP12 Artifacts

| Path                                          | Purpose                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/shared-types/src/index.ts`          | Shared report, notification, knowledge summary, and runtime context contracts.                 |
| `packages/business-core/src/index.ts`         | Report and notification permissions for role-gated API access.                                 |
| `services/api/src/cp2/store.ts`               | Deterministic report builders, in-app notifications, knowledge summaries, and runtime context. |
| `services/api/src/cp2/routes.ts`              | Business-scoped report, notification, and knowledge endpoints.                                 |
| `services/ai-runtime/src/local-model.ts`      | Bounded CP12 knowledge counts in local-model prompt context.                                   |
| `apps/web/src/cp3-shell.ts`                   | Reports and alerts shell navigation entries and empty states.                                  |
| `apps/web/src/main.tsx`                       | Owner-facing report and notification UI surfaces.                                              |
| `apps/web/src/styles.css`                     | Compact report and notification row styling.                                                   |
| `tests/cp12-reports-knowledge.test.ts`        | Report totals, scoping, role access, notification, and runtime knowledge safety tests.         |
| `documentation/CP12_REPORTS_NOTIFICATIONS.md` | Report definitions and notification boundary documentation.                                    |

## CP12 Opening Checklist

- [x] CP11 accepted as passed.
- [x] CP11 checkpoint tag exists locally and on GitHub.
- [x] CP11 commits are pushed to `origin/main`.
- [x] CP12 marked `active` in checkpoint log.
- [x] CP12 baseline created.
- [x] CP12 decision log created.
- [x] CP12 scope excludes external notification providers, autonomous actions, analytics warehouse integration, marketplace automation, logistics implementation, and TIEL.

## CP12 Completion Checklist

- [x] Report shared contracts implemented.
- [x] Deterministic report builders implemented.
- [x] Report API endpoints implemented.
- [x] Owner report UI implemented.
- [x] Notification shared contracts implemented.
- [x] In-app notification records and state transitions implemented.
- [x] Notification API endpoints implemented.
- [x] Runtime knowledge summaries implemented.
- [x] Local-model prompt boundaries preserved.
- [x] CP12 tests implemented.
- [x] Existing CP1 through CP11 checks pass.
- [x] `checkpoint/cp12-reports-knowledge` tag created.

## Verification

Passed verification:

- `pnpm --filter @grogoni/shared-types typecheck`
- `pnpm --filter @grogoni/api typecheck`
- `pnpm --filter @grogoni/web typecheck`
- `pnpm vitest run tests/cp12-reports-knowledge.test.ts --reporter=dot`
- `pnpm run ci`
