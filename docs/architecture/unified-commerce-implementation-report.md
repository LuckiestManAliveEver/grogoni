# Unified commerce implementation report

Date: 2026-10-25. Baseline/current HEAD: `8976d82a2a719828756081ec16d42ba3ed7b24f2`.
Changes are in the working tree; no new commit, deployment or production migration was made.

## Outcome

Implemented a source/offer foundation integrated into the existing CP2 application. This is a
partial implementation of the requested complete commerce environment; the complete definition of
done is not satisfied. The repository audit and remaining gaps are recorded in
[unified-commerce-audit.md](unified-commerce-audit.md).

Implemented behavior:

- Eight source types, private source registration/disconnection, maintenance authority, manual synchronization metadata, nullable refresh/error state and audit events.
- Explicit product-source identity bindings with tenant checks, idempotent reuse and HTTP 409 conflicts. Confirmed inventory receipts retain line bindings inside the original stock-confirmation rollback boundary.
- Draft, published and withdrawn offers with explicit selling prices, currencies and expiry. Linked reselling retains original product identity, requires upstream resale consent and never copies inventory or supplier cost. Source/upstream disconnection, withdrawal, expiry and deleted products hide offers.
- Distribution requests between authenticated business IDs, target-only acceptance/rejection and either-party revocation. Connections grant no access to private receipts or catalogue records.
- Name-only shop description previews through the existing import service. Prices remain null. Existing generic unit/zero-stock defaults are disclosed before confirmation; no purchase movement is created.
- Explicit browser image batches, sequential thumbnails, checksum deduplication, resumable existing capture job listing, cancellation, review and explicit product confirmation. Existing capture and media cleanup services remain authoritative.
- Native Android scoped document selection and sequential sampled image upload through the existing authenticated API client. No silent gallery scanning. Existing workspace handles review/publication.
- Lazy source cards in the product and nested catalogue workspace, with sources, description previews, gallery batches, offers, linked resale, discovery and accepted connections.
- Three new tools in the existing agent registry: commerce.sources.list, commerce.sources.execute and commerce.discovery.search. Mutation tool requires human confirmation. Buyer shopping chat can discover published offers; offer IDs are explicitly not accepted as confirmed inventory or passed to existing checkout.
- Additive PostgreSQL migration 129, Drizzle declaration, normalized persistence, snapshot restore and account/user purge coverage.

## Verification

| Command / scope                                                                                                                                            | Actual result                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                                                                                | Passed, including final repeat.                                                                                                                                                                 |
| `pnpm typecheck`                                                                                                                                           | Passed across workspace, including final repeat.                                                                                                                                                |
| `pnpm build`                                                                                                                                               | Initial unconfigured invocation failed because Vite requires an API base URL.                                                                                                                   |
| `VITE_API_BASE_URL=http://127.0.0.1:4000 pnpm build`                                                                                                       | Passed; the URL is a build-time local configuration, not a deployment.                                                                                                                          |
| `pnpm test`                                                                                                                                                | 451 files passed, 10 failed, 32 skipped; 3,197 tests passed, 15 failed, 344 skipped; 4 sandbox socket errors. This run overlapped implementation edits and is not a clean final-suite result.   |
| Focused receipt/OCR/import/capture/commerce regressions                                                                                                    | 5 files, 26 tests passed.                                                                                                                                                                       |
| Final changed-area regressions: unified commerce, receipt bindings, tool registry, purge coverage, lazy module recovery, buyer shopping assistant and Edge | 7 files, 40 tests passed after corrections.                                                                                                                                                     |
| Source commerce policy tests                                                                                                                               | 4 tests passed: expiry, aliases, revoked resale permission, independent prices, invalid prices, disconnected-source publication, deleted product suppression.                                   |
| Database retry regressions outside sandbox                                                                                                                 | 2 files, 65 tests passed, 4 skipped.                                                                                                                                                            |
| Browser runtime, mocked Supabase scheduler and guest-intent subprocess tests outside sandbox                                                               | 3 files, 6 tests passed. Real Chromium exercised the existing isolated browser runtime against a local test page. No external retailer was queried.                                             |
| `pnpm check:api-routes`                                                                                                                                    | The added gallery review method mismatch was fixed (PATCH). A pre-existing unclassified `share-links` business route group remains; final repeat reports only that existing classification gap. |
| Android build/device                                                                                                                                       | Not run: repository has no Gradle wrapper and this environment has no `gradle` executable or attached Android device.                                                                           |
| PostgreSQL migration / database-gated tests                                                                                                                | Not executed against a database. No isolated test database was configured for this work; production connection settings were not used.                                                          |
| Live Luna, supplier ERP, verified external website                                                                                                         | Not exercised; no completed integration claim. Existing model configuration was preserved.                                                                                                      |

The 15 full-run failures were investigated individually. Registry expectations, lazy recovery and
purge classification were updated for the new code. Receipt and description failures came from the
long-running suite loading older modules while assertions were being added; their final focused
runs pass. Socket/child-process failures were rerun outside the sandbox and pass, including the
existing database retry and browser runtime integration tests. A second complete 493-file run has
not been performed after those targeted fixes. Database-gated tests remain skipped, not passed.

The gallery test creates 120 capture metadata jobs and repeats their checksums; it verifies domain
deduplication, tenant isolation and bounded listing. It does not simulate 120 real photo uploads,
OCR accuracy, Android memory pressure or a full browser publication journey.

## Reproduction commands

```bash
pnpm lint
pnpm typecheck
VITE_API_BASE_URL=http://127.0.0.1:4000 pnpm build
pnpm test
pnpm format
pnpm check:api-routes
pnpm exec vitest run tests/unified-commerce.test.ts tests/delivery-receipt-fields.test.ts tests/receipt-ocr.test.ts tests/cp9-document-import.test.ts tests/platform-chat-commerce-foundation.test.ts
pnpm exec vitest run tests/runtime-tool-registry.test.ts tests/user-purge-script.test.ts tests/lazy-module-recovery-coverage.test.tsx tests/buyer-shopping-assistant.test.ts tests/buyer-shopping-edge.test.ts tests/unified-commerce.test.ts tests/delivery-receipt-fields.test.ts
pnpm exec vitest run tests/unified-commerce-policy.test.ts
pnpm exec vitest run services/api/src/db-startup-retry.test.ts tests/api-boot-database-retry.test.ts
pnpm exec vitest run tests/computer-runtime-browser.integration.test.ts tests/supabase-job-scheduler-script.test.ts services/api/src/guest-intent/eval/score-settles.test.ts
```

The last two commands require local sockets and subprocess support. Logs are retained under
`/tmp/unified-*.log` in this workspace session. The repository-wide formatting check also identified
an existing formatting issue in `docs/audits/main-test-failures-triage-2026-10-25.md`; that unrelated
file was not reformatted. New architecture documents were formatted after that check started.

## Migration and deployment requirements

Apply `infra/db/migrations/129_unified_commerce_sources.sql` using the established migration runner
before enabling the updated API. Test on a backed-up nonproduction database first. The migration
adds one normalized JSONB metadata collection and tenant/binding/public-offer/relationship indexes;
it does not modify existing products, stock movements, receipts or invoices. Database roles
`public`, `anon` and `authenticated` cannot read the new table directly.

Build shared-types and tool-core with API/web together. Configure the normal web API base URL.
No new paid services, brokers, search engines, vector stores, model runtime or inference provider
are required. Android requires the documented Gradle/SDK toolchain and a real-device scoped-storage,
session, cancellation and retry check. Rollback instructions are in the audit; dropping migration
129 deletes source metadata and must follow a backup and application rollback.

## Security and performance

Private reads and mutations enforce business membership and existing permissions. Public discovery
uses an allowlist projection without purchase costs, source document locators, quantities or contact
information. Extracted identities never grant account access. External source references are inert
strings; this implementation neither fetches private URLs nor executes imported instructions.
Unknown availability remains unknown. Resale carries no automatic media grant or stock assertion.

Browser batches cap selections at 100, file size at 10 MB, thumbnails at 1024 pixels and concurrency
at one. Android reads image bounds and samples before scaling. Cancelled work stops subsequent
uploads; an already accepted job remains private and can be discarded. Publication without media
uses existing temporary media cleanup. Search uses the existing in-process persistence model with
bounded results; SQL query optimization should follow measured scale.

## Remaining product work

Verified wholesaler representation and claim verification, receipt-driven accepted-network discovery,
package/barcode/variant reconciliation, authoritative refresh/conflict workers, website ownership
and feed adapters, offer-to-canonical-order fulfillment and immutable price/attribution snapshots,
source-linked storefront customer routing, richer conversational gallery/description operations,
and durable native indexing queues remain unimplemented. The native and browser batch flows also
need complete user-journey/device coverage. Source registration alone is not a website integration
or proof of wholesaler authorization. Do not deploy or market this as the complete requested system.

## Changed files

- `apps/android/app/src/main/AndroidManifest.xml`
- `apps/android/app/src/main/java/market/grogoni/app/MainActivity.kt`
- `apps/android/app/src/main/java/market/grogoni/app/commerce/GalleryCommerceActivity.kt`
- `apps/android/app/src/main/java/market/grogoni/app/sms/NativeSmsApiClient.kt`
- `apps/web/src/CatalogueNestedCard.tsx`
- `apps/web/src/CommerceSourcesPanel.tsx`
- `apps/web/src/GalleryBatchPanel.tsx`
- `apps/web/src/ProductSurface.tsx`
- `apps/web/src/ShopDescriptionPanel.tsx`
- `docs/architecture/unified-commerce-audit.md`
- `docs/architecture/unified-commerce-implementation-report.md`
- `infra/db/migrations/129_unified_commerce_sources.sql`
- `infra/db/rollbacks/129_unified_commerce_sources.down.sql`
- `infra/db/schema.ts`
- `packages/shared-types/src/commerce-sources.ts`
- `packages/shared-types/src/index.ts`
- `packages/tool-core/src/contracts/api-route-coverage.json`
- `packages/tool-core/src/contracts/runtime.ts`
- `packages/tool-core/src/domains/commerce.ts`
- `packages/tool-core/src/validation/runtime.ts`
- `scripts/purge-all-users.sql`
- `services/api/src/cp2/domains/agent-runtime/capabilities.ts`
- `services/api/src/cp2/domains/agent-runtime/domain-deps-commerce.ts`
- `services/api/src/cp2/domains/commerce-sources/routes.ts`
- `services/api/src/cp2/domains/commerce-sources/store.ts`
- `services/api/src/cp2/domains/commerce/buyer-assistant.ts`
- `services/api/src/cp2/domains/commerce/store.ts`
- `services/api/src/cp2/postgres-store.ts`
- `services/api/src/cp2/routes.ts`
- `services/api/src/cp2/store.ts`
- `tests/delivery-receipt-fields.test.ts`
- `tests/runtime-tool-registry.test.ts`
- `tests/unified-commerce-policy.test.ts`
- `tests/unified-commerce.test.ts`
- `tests/user-purge-script.test.ts`
