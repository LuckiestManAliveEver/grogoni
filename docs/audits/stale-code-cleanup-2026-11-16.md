# Stale-code cleanup and receipt prompt recheck

Date: 2026-11-16. Review baseline: local `fix/chat-readiness-gaps` at `06911588`, with pre-existing catalogue and persistence edits. Pre-existing edits remain in the same working tree; the cleanup was compared with a saved baseline to preserve them. No production data, migrations, deployed services or credentials were changed.

## Result

Confirmed stale receipt/OCR configuration and misleading operational documentation were removed. The attached receipt prompt remains **partially implemented**. [The updated phase checklist](receipt-to-commerce-checklist-2026-11-16.md) retains **43 open feature/readiness items**. Documentation cleanup does not implement receipt-driven wholesaler/salesperson/financial synchronization.

`CLAUDE.md` was inspected and updated locally. It originally supplied general agent rules, not receipt implementation evidence, and is ignored by `.gitignore`. The local update links the repository checklist, describes current CP2/SQL/Drizzle/Node/Edge boundaries, and replaces the conflicting local-Claude shell-service guidance with reuse of the existing configured OpenRouter integration. It was not force-added or published as personal agent guidance.

## Removed or corrected

| Area                     | Change                                                                                                                                                                                                                                              | Evidence                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phantom OCR defaults     | Removed `readReceiptOCRConfig`, four worker-default constants and their consumer imports. Removed engine/profile/language/version examples that configured no running worker.                                                                       | `domains/suppliers/shared.ts`, `domains/suppliers/store.ts`, `.env.example`                                                                                    |
| Text provenance          | New supplied-text drafts use `provided_text`, non-applicable versions, zero OCR confidence and no invented language hints. Field-only review preserves actual OCR evidence; changed transcriptions do not become fabricated 100-percent OCR output. | `tests/receipt-extraction-provenance.test.ts`                                                                                                                  |
| Historical compatibility | Kept old engine types/persisted metadata and real browser extraction. The former worker extraction validator is still used by offline receipt sync and was preserved.                                                                               | Offline dispatcher caller in `cp2/store.ts`; restore and offline regressions                                                                                   |
| Current documentation    | Replaced obsolete ingestion, worker deployment, lifecycle, licensing and resource instructions; updated pipeline/offline descriptions and third-party notices from pinned local package manifests.                                                  | `docread.md`, `docs/receipt-ocr.md`, `docs/ocr-data-lifecycle.md`, `docs/ocr-licensing.md`, `THIRD_PARTY_NOTICES.md`, current resource/offline/pipeline guides |
| Historical assessments   | Clearly labeled dated inference, resource, source/offer and procurement assessments as historical and pointed them to current source/test evidence. Kept audit history and migrations rather than deleting recoverability/provenance.               | Existing architecture audit/report headers                                                                                                                     |
| Drift prevention         | Added `check:current-ocr-contracts` to CI. Checks 10 operational documents and 2 source modules. Negative tests reject obsolete worker settings and fabricated defaults; compatibility references remain permitted.                                 | `scripts/check-current-ocr-contracts.mjs`, `tests/current-ocr-contracts.test.ts`, `package.json`                                                               |

The resource-control library has tested primitives, but this review found no direct production API caller of `createBulkhead` or `createCircuitBreaker`. The old resource guide incorrectly described live OCR/inference controls and environment settings. It now distinguishes reusable tested primitives from wired production isolation. Active database startup backoff remains in place.

## Validation

| Check                                                                        | Actual result                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Receipt/OCR/offline/image/provenance regressions, 9 files                    | 57 passed                                                       |
| Existing commerce/contact/document/deployment/resource regressions, 11 files | 47 passed, 1 PostgreSQL variant skipped without the test DB URL |
| New current-contract guard regression file                                   | 3 passed                                                        |
| API and frontend TypeScript                                                  | Passed                                                          |
| Node API build and Supabase Edge bundle                                      | Passed                                                          |
| Targeted ESLint                                                              | Passed                                                          |
| Retired execution-fabric, retired device-model and retired deployment checks | Passed                                                          |
| Import/architecture boundaries and explicit ESM imports                      | Passed                                                          |
| Current operational OCR reference guard                                      | Passed                                                          |

Total: **107 tests passed, 1 skipped across 21 files**. The tests use deterministic fixtures/mocks where defined. Full repository CI, live-model extraction, real-browser OCR/device certification and production deployment were not run. Existing historical test results in older reports were not rewritten as if this cleanup reran them.

## Scope and preservation

This is an evidence-based cleanup, not an automatic deletion of every unreferenced-looking symbol or old document. Active offline sync, compatibility formats, schema migrations/rollbacks, failure detectors, third-party attribution and dated audit evidence were retained. Unrelated working-tree edits and the pre-existing untracked device reproduction script were not deleted or staged with this cleanup.

New plain-text engine metadata uses existing text columns; no SQL migration or backfill is required. Existing records are not relabeled. To activate the code change, rebuild/deploy the existing API/Edge and shared web artifacts through the established process. Documentation and local `CLAUDE.md` changes require no restart. This cleanup does not deploy production or provision a new OCR/inference service.
