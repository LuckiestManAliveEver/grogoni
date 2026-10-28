# Unified commerce audit and implementation

Baseline: `8976d82a2a719828756081ec16d42ba3ed7b24f2`.
Audit date: 2026-10-25. No production data or deployment changes were authorized or performed.

## Reuse and gap matrix

| Capability                        | Evidence inspected                                                                                               | Decision and remaining gap                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt image extraction          | `docs/integrations/chat-receipt-reading.md`, `domains/suppliers/routes.ts`, `receipt-fields.ts`                  | Preserve the authenticated chat image reader and configured model. Generic OCR routes require extracted text; do not assume a worker runs in every deployment. No live model call was made for this implementation.                                                                          |
| Receipt purchasing and identities | `domains/suppliers/receipt-network.ts`, `store.ts`, `tests/delivery-receipt-fields.test.ts`                      | Retain documentary identities and existing delivery bindings. Confirmed inventory receipt lines also enter the common source-binding collection inside the same rollback boundary. Documentary names and phones are not account claims.                                                      |
| Inventory and invoices            | `domains/sales`, `domains/suppliers`, `domains/commerce/store.ts`                                                | Keep canonical products, movements, checkout and invoice services. Offer writes never call stock mutations.                                                                                                                                                                                  |
| Structured document import        | `domains/document-imports/routes.ts`, `store.ts`, `apps/web/src/ImportSurface.tsx`, `ImportRowEditors.tsx`       | Reuse preview, selected rows, validation and confirmation. Shop descriptions produce name-only JSON imports through this same service.                                                                                                                                                       |
| Camera catalogue                  | `domains/commerce/routes.ts`, `store.ts`, shared `ProductCaptureJobSummary`                                      | Reuse private product capture jobs, review, cancellation and confirmation. Add business-scoped checksum deduplication and resumable job listing. Multi-object vision detection is explicitly unavailable in the existing contract.                                                           |
| Catalogue sharing                 | `domains/catalogue-sharing/store.ts`, `routes.ts`, `CatalogueBrowsePanel.tsx`                                    | Preserve zero-stock duplication and opt-in projection. Linked resale uses separately published offers and requires explicit resale permission; catalogue sharing alone does not imply that permission.                                                                                       |
| Aliases and product search        | `packages/business-core/src/domains/sales.ts`, `docs/architecture/platform-agnostic-chat-commerce.md`            | Retain deterministic business catalogue query. New public offers match names, aliases and sellers lexically. No automatic identity merges.                                                                                                                                                   |
| Public conversations and checkout | `domains/commerce/store.ts`, `domains/agent-runtime/commerce-capabilities.ts`                                    | Preserve current feed, customer sessions and canonical order services. Source-linked discovery has its own registered capability in the same harness and is available in the existing buyer shopping conversation. Offer checkout attribution and invoice snapshots are not yet implemented. |
| Agent execution and approval      | `domains/agent-runtime/capabilities.ts`, `domain-deps-commerce.ts`, `packages/tool-core/src/domains/commerce.ts` | Add list, execute and discovery tools to existing registry. Mutations require runtime confirmation plus domain validation. No new agent or inference server.                                                                                                                                 |
| Offline OCR                       | `apps/web/src/offline-ocr.ts`, `packages/offline-runtime/`, `docs/receipt-ocr.md`                                | Existing local scanner and queued operations remain unchanged. Gallery batch uploads need a connection; no claim that new source mutations work offline.                                                                                                                                     |
| Android                           | `apps/android/README.md`, `MainActivity.kt`, native API client, manifest                                         | Standalone native app, not Capacitor. Add scoped document-picker activity and sequential sampled thumbnail uploads using existing encrypted session. Review/publication occur in existing workspace. SDK/device verification remains required.                                               |
| External websites                 | Existing `commerce.website.open`, Computer Runtime policy and registry                                           | Source registration accepts credential-free HTTPS references without fetching them. No new browser automation. Verified ownership, API/feed connectors, scheduled refresh and source-bound browser query are outstanding.                                                                    |

## Minimal domain extension

`CommerceSource → ProductSourceBinding → canonical ProductSummary → CommerceOffer`.
Canonical products and physical stock remain in existing collections. A linked reseller offer
references the upstream offer and original product ID; it creates no reseller product or movement.
One discriminated metadata collection holds sources, bindings, offers and accepted relationships.
It is registered in the existing normalized PostgreSQL snapshot persistence mechanism.

Sources record owner tenant, source type, stable locator, maintenance authority, manual sync policy,
connection state and nullable refresh/error fields. A new registration has never refreshed and must
not be described as verified or live. Agent-maintained sources never imply wholesaler endorsement.

Bindings require an explicit confirmed canonical product ID and namespaced external reference.
A conflicting binding returns HTTP 409. Similar names alone cannot create bindings. This first
extension does not add a barcode/packaging reconciliation engine.

Offers start private/draft, use explicit selling prices/currencies/expiry, and report unknown
availability. Publication and resale permissions are explicit. Updating a price returns an offer
to draft. An expired, disconnected, deleted-product, quarantined-business or unavailable upstream
offer is hidden, including linked descendants. Supplier changes do not overwrite reseller prices.
Private source locators, buying prices and purchase histories never enter public projections.
Media reuse is intentionally not provided by linked resale, so a resale grant cannot expose images.

Distribution requests bind authenticated business IDs. Only the target may accept/reject; either
party can revoke. Acceptance grants no access to either business's private catalogue or receipts.
This is connection acceptance, not wholesaler representation verification. No receipt name or phone
is used to look up another tenant's private records.

## API and workspace

- `GET /businesses/:businessId/commerce-sources`: scoped metadata and own relationship requests.
- `POST /businesses/:businessId/commerce-sources/operations`: validated source, binding, offer and connection mutations.
- `POST /businesses/:businessId/commerce-sources/describe`: reviewed name-only import candidates.
- `GET /businesses/:businessId/commerce-sources/gallery`: last 100 noncancelled capture jobs.
- `GET /public/commerce-offers?query=...`: published, unexpired allowlisted offer summaries.
- Runtime: `commerce.sources.list`, `commerce.sources.execute`, `commerce.discovery.search`.

The existing product and nested catalogue workspace lazy-load a common source card. It includes
source registration, a bounded gallery picker, description candidates, linked resale, publication,
withdrawal, discovery, and distribution acceptance. Receipt/document workflows stay in their
existing surfaces. Source registration does not itself import a receipt/document or fetch a URL.

## Migration and rollout

1. Back up the target database using established operations.
2. Apply `129_unified_commerce_sources.sql` with the existing `pnpm db:migrate` process, against an explicitly selected nonproduction database first.
3. Deploy shared-types/tool-core, API and web artifacts together after the migration.
4. Build Android with the documented SDK/Gradle toolchain; device-test document grants, memory, session expiry, cancellation and retry before distributing.
5. No existing product, receipt, invoice, or inventory backfill is necessary. Link existing identities through explicit review.

Rollback API/web first, then use `infra/db/rollbacks/129_unified_commerce_sources.down.sql` only after
backing up source metadata. Dropping that table destroys metadata; it never reverses stock receipts
or invoices. Disconnecting a source is the normal reversible user operation.

## Security and performance assessment

Tenant permission checks precede all private reads and mutations. Product references are resolved
inside the owning tenant. Offers expose an explicit projection, not stored records. Relationships
need target acceptance and cannot be manufactured from documentary contact information. Source
strings remain inert data: no URL fetch, script execution, model instruction or secret interpolation.
New table privileges are revoked from public, anon and authenticated database roles; API mediation
is required. Consequential runtime tools use the existing approval system and mutations emit audit
events. Account purge includes owned commerce metadata.

Browser batches cap selection at 100 and upload at concurrency one. Original images are at most
10 MB and thumbnails at most 1024 pixels per side. Server checksum checks are tenant-scoped.
Android decodes bounds first and samples images before scaling. Selection is explicit; there is no
whole-gallery scan. Cancellation stops subsequent images; an accepted in-flight upload remains a
private job that can be discarded. Public images are not retained by the batch confirmation action.

The source/offer search currently scans in-process normalized records with a bounded result count.
This fits existing CP2 architecture, but large deployments should add an indexed SQL query behind
the same projection after measuring load. There are no new paid services or infrastructure.

## Outstanding requirements

The broad unified-commerce definition of done is **not yet met**. Outstanding work includes verified
wholesaler/agent representation and secure external claims, receipt-to-accepted-network discovery,
source-specific import provenance backfills, barcode/package/variant identity review, offer checkout
and immutable attribution snapshots on canonical orders, authoritative availability evidence and
refresh/conflict jobs, website ownership/feed adapters, source-linked storefront customer routing beyond buyer shopping, richer agent description/gallery operations, persisted native picker queues,
and complete browser/device end-to-end coverage. New gallery entry is bounded and retryable by
reselection/server deduplication; it is not a durable native background indexing scheduler.

Do not advertise these outstanding capabilities as completed integrations. See
`docs/architecture/unified-commerce-implementation-report.md` for actual command results.
