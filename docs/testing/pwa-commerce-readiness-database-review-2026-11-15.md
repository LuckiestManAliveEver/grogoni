# Database readiness and document implementation review — 15 November 2026

This continues the earlier readiness review. It does not finish the 301-item checklist or certify
a production milestone. Previously unchecked requirements include both existing but unassessed
features and work still missing; an unchecked box is not proof that the capability is absent.

## Fixes

- **Healthy commits incorrectly timed out:** optimized mode set the persistence response deadline
  to 200 ms. Fresh local PostgreSQL tests returned 503 for signup and device-account creation
  while healthy snapshot writes completed later. The default durability window is now at least
  1,000 ms, independent of the interactive target. The existing explicit environment override
  remains supported. Success still waits for persistence; an expired deadline still returns 503
  and removes authentication cookies. This trades some bounded wait time for reliable durable
  acknowledgments; it is not a claim that committed writes always meet the 100 ms UI target.
- **Runtime rollback lost host provenance:** rollbacks 103 and 108 attempted to delete hosts still
  referenced by immutable handoff checkpoints or transfers. They now retain referenced hosts;
  rollback 103 also retains referenced runtime agents and models. Historical checkpoints are
  not deleted or rewritten to force the rollback through. Failure diagnostics identify the
  rollback filename.
- **Chat lifecycle and evaluation:** the reviewed reply-version work is integrated, with late-response
  isolation and a record-content safety oracle. The separate document review lists remaining gaps.

## Executed checks

The database target was newly created inside the existing local test PostgreSQL container, bound
on loopback port 5433. All migration/database URL variables were set explicitly to this scratch
database; production settings were not loaded. Migration 108's opt-in flag was enabled only for
this disposable database. All 136 migrations applied successfully.

| Execution | Result |
| --- | --- |
| `node scripts/run-postgres-tests.mjs` | 47 files; 459 passed, 9 failed, 468 total. No PostgreSQL-gated tests skipped. |
| Initial failure rerun, after durability fix and corrected benchmark target | 5 files; 30 passed, 1 failed. |
| Final rollback regression rerun | 2 files; 20 passed. Includes fulfillment rollback/reapply over historical data and migration 108. |
| Authentication, tenant/runtime authorization, encryption and commerce selection | 9 files; 53 passed. |
| Offline sync/reconciliation/order intents and backup-target safety | 5 files; 32 passed. |
| Durability deadline and priority budget regressions | 2 files; 12 passed. |
| Initial reply-version server/client selection | 2 files; 40 passed. |
| Final combined reply-version API/client/safety-oracle selection | 3 files; 45 passed. |
| Lazy recovery, error boundaries and workspace coverage | 4 files; 31 passed. |

Three initial failures were harness configuration errors: the inventory benchmark requires its
own `grogoni_*benchmark` database name. The rerun supplied a separate correctly named local database.
Six initial failures exposed the real durability deadline regression. Once those were fixed,
the rerun reached the historical checkpoint rollback defect, which was then fixed and retested.
All failing suites have passing targeted reruns. These results are **not** a new all-green full
repository invocation or a repeat of all 47 database files after the fixes.

Local logs: `/tmp/grogoni-review-postgres-tests.log`,
`/tmp/grogoni-review-postgres-rerun.log`, `/tmp/grogoni-review-postgres-rollback-rerun.log`,
`/tmp/grogoni-review-security-commerce-tests.log`, `/tmp/grogoni-review-readiness-tests.log`,
`/tmp/grogoni-review-durability-fix.log`, `/tmp/grogoni-review-final-client-eval.log`.

## Build and payload validation

Production web compilation passed. The first integrated build failed the 185 KiB owner-route
budget at 197.50 KiB gzip. Loading business workspaces on demand reduced that measurement to
182.26 KiB; initial JavaScript is 159.51 KiB and CSS 24.93 KiB. All existing budgets pass, with no
threshold changes. Workspace chunks use the existing deployment recovery and error boundaries.
The corresponding 31 tests pass. Large optional chunks still produce Vite warnings.
Feature commit hooks passed lint, ESM checks, workspace package builds and web/API/shared-types
TypeScript checks.

## Actual backup restoration drill

A custom-format `pg_dump --no-owner` of the isolated readiness database was restored into a
separate newly created local database using `pg_restore --exit-on-error --no-owner`. Every user
table was compared by row count and an order-independent hash of complete JSON row contents.
All **253 tables and 8,274 rows matched**, with no mismatched tables. The archive was 1,434,700 bytes.
The sanitized archive hash/result is recorded in
`readiness-backup-restore-evidence-2026-11-15.json`; no database records, dump or credentials are committed.
This proves a local logical restore of this test dataset, not restoration from production remote
storage, backup encryption, recovery time objectives or managed-provider disaster recovery.

## Remaining release conditions

Real provider payment/refund verification, independent security/cryptographic review, physical-device
and low-memory/browser certification, legal/provider approval, and external credential retirement
remain open. A local database test is not proof of safe operation across every API instance or
process-kill scenario. H1–H5 remain open. The chat document additionally requires complete upstream
source audits, durable cancellation/reconnect, question revisions, attachment/voice/rendering work,
account-scoped history portability and browser/performance certification.
