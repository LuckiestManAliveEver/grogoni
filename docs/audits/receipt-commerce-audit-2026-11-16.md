# Receipt-to-commerce repository audit

> Historical contract-only audit at `acfd72b5`. Subsequent cleanup and posting safeguards supersede its OCR defaults, validation and packaging findings. Planned migration numbers and engine decisions below were proposals, not completed code. See [current checklist](receipt-to-commerce-checklist-2026-11-16.md) and [implemented safeguards](../implementation/receipt-posting-safeguards.md).

Date: 2026-11-16. Base: `origin/main` at `dda6928a`. Every finding below was checked against code,
not documentation. Where a document disagrees with the code, the document is listed as stale.

## Verdict

Grogoni can read a receipt into fields and add stock to the scanning shop. It cannot yet treat a
receipt as a shared transaction. Nothing connects the scanning shop's purchase to the seller's sale,
nothing records what is owed, and nothing lets one account authorize writes that originate in
another. The camera, the cross-account engine, the authorization model, the durable event pipeline
and the tamper-evident audit trail all have to be built.

## 1. OCR, capture and document processing

| Finding                                                                                                                                                                                                                  | Where                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| There is no server-side OCR. The PaddleOCR worker and `ocr-provider.ts` were removed. Setting `OCR_WORKER_URL` makes the API refuse to boot.                                                                             | `services/api/src/config.ts:114-123`, `tests/render-blueprint.test.ts:146-160`                |
| Online images are read by Luna (`gpt-6-luna` through OpenRouter) with the schema in the prompt and `json_object` output.                                                                                                 | `services/api/src/cp2/chat-image-reader.ts:11-104`, route `POST /v1/chat/images/read`         |
| Offline images are read by tesseract.js in the browser, English only, after an opt-in 14 MiB install.                                                                                                                    | `apps/web/src/offline-ocr.ts`, `apps/web/src/offline-ocr-assets.ts`                           |
| An online PDF receipt always fails with 400 `receipt_text_required`.                                                                                                                                                     | `services/api/src/cp2/domains/suppliers/routes.ts:338-344`                                    |
| There is no live camera. No `getUserMedia`, `<video>`, canvas pipeline or image worker exists. The receipt input has no `capture` attribute.                                                                             | `apps/web/src/SupplierSurface.tsx:115-125`                                                    |
| Receipt photos are uploaded at full resolution. The only downscale in the app is for product captures.                                                                                                                   | `apps/web/src/hooks/useSuppliersState.ts:298-360`, `apps/web/src/GalleryBatchPanel.tsx:50-58` |
| Field confidence is five hard-coded constants regardless of engine. Luna jobs store `averageConfidence: 0`.                                                                                                              | `services/api/src/cp2/domains/suppliers/shared.ts:698-734`                                    |
| Text-only and agent-created jobs are labelled `paddleocr 2.8.1` with an invented 0.9 confidence per line.                                                                                                                | `services/api/src/cp2/domains/suppliers/shared.ts:639-666`, `store.ts:612-613`                |
| The client chooses the `engine` label and the server trusts it.                                                                                                                                                          | `services/api/src/cp2/domains/suppliers/routes.ts:310-378`                                    |
| Math validation is one warning: line sum vs total, tolerance 1. No per-line, tax, discount or balance check. It never blocks confirmation.                                                                               | `services/api/src/cp2/domains/suppliers/shared.ts:750-769`                                    |
| Duplicate detection is an exact SHA-256 match held in memory. Without image bytes the hash includes the file name, so renaming the file defeats it. There is no database constraint and no receipt-number check.         | `services/api/src/cp2/domains/suppliers/store.ts:630-643`                                     |
| Document type is returned by Luna as one of three values and then discarded. Every confirmed job becomes a purchase receipt plus stock in. A quotation would add stock.                                                  | `services/api/src/cp2/chat-image-reader.ts`, `services/api/src/cp2/store.ts:9565-9686`        |
| `/v1/chat/images/read` sends image bytes to the model without the malware scan and without a business scope.                                                                                                             | `services/api/src/cp2/chat-image-routes.ts:15-27`                                             |
| Stale documents: `docs/receipt-ocr.md` (worker, compose profile, fallback flag, `/documents/ocr`), `docs/ocr-data-lifecycle.md` (TTL variables no code reads), the comment at `packages/shared-types/src/index.ts:2361`. |                                                                                               |

## 2. Inventory, catalogue, orders, payments

| Finding                                                                                                                                                                               | Where                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The data layer is one in-memory store (`Cp2Store`) mirrored to Postgres JSONB tables. There is no Prisma. Drizzle is declared but never imported at runtime.                          | `services/api/src/cp2/store.ts:1190`, `services/api/src/cp2/postgres-store.ts:671`        |
| Production runs the same domains inside a Supabase Edge function against Neon. There, one request is one Postgres transaction that takes an advisory lock on every business in scope. | `supabase/functions/api/index.ts:66-99`, `services/api/src/edge-domain-routes.ts:390-480` |
| A store method not listed in `mutatingMethodNames` is not persisted until some other write happens.                                                                                   | `services/api/src/cp2/postgres-store.ts:268-563`                                          |
| Stock is set by absolute value (`quantityAfter`), not by delta. The single movement writer does not check for a negative result.                                                      | `services/api/src/cp2/domains/sales/store.ts:514`, `:1492`                                |
| `InventoryMovementType` is `manual_adjustment` or `sale`. A received delivery is recorded as a manual adjustment.                                                                     | `packages/shared-types/src/index.ts:3469`                                                 |
| `createPurchase` records a purchase and never changes stock.                                                                                                                          | `services/api/src/cp2/domains/commercial-records/store.ts:746`                            |
| Supplier payables do not exist. Receivables are derived from invoices for customers only.                                                                                             | `services/api/src/cp2/domains/sales/store.ts:1544`                                        |
| Unit conversion does not exist. `unit` is free text. `packaging` is a string used only to flag conflicts.                                                                             | `packages/shared-types/src/commerce-sources.ts:84`                                        |
| Products have no barcode field.                                                                                                                                                       | `packages/shared-types/src/index.ts:1620-1641`                                            |
| Money and quantity are floats everywhere except procurement, which uses integer minor and milli units.                                                                                | `services/api/src/cp2/domains/agent-runtime/inventory-procurement-store.ts:56`            |
| Confirmed invoices cannot be cancelled or voided.                                                                                                                                     | `services/api/src/cp2/domains/sales/store.ts:894`                                         |
| `PurchaseReceipt` drops currency, tax, subtotal, document numbers and payment fields. They survive only in the OCR job JSON.                                                          | `services/api/src/cp2/domains/suppliers/store.ts:705-857`                                 |

## 3. Contacts and identity

| Finding                                                                                                                                                                             | Where                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Phone numbers are not verified. OTP is disabled by database trigger. A phone number is still used for discovery and staff invitations, so whoever registers a number first owns it. | `infra/db/migrations/046_disable_sms_verification.sql`, `services/api/src/cp2/domains/network/store.ts` |
| A business's "verified" tier is set by its own owner with no review.                                                                                                                | `services/api/src/cp2/domains/compliance/store.ts:202`                                                  |
| Any member with `customer:write` can link a customer or contact to any account id without that account's consent.                                                                   | `services/api/src/cp2/domains/sales/store.ts:649`, `commercial-records/store.ts:281`                    |
| `primaryBusinessByUser` returns the user's first membership of any role, which can be an employer rather than the user's own shop.                                                  | `services/api/src/cp2/domains/network/connections.ts:372`                                               |
| Supplier and sales-agent phone is unnormalized text. Canonical contacts store local `07...` numbers as raw digits.                                                                  | `packages/business-core/src/domains/contact-records.ts:49`, `commercial-records/store.ts:1234`          |
| Contact imports exist for vCard, CSV, Chrome Contact Picker, Google Contacts (read-only) and phonebook sync, stored as HMAC fingerprints.                                           | `apps/web/src/contacts-import.ts`, `services/api/src/cp2/google-contacts.ts`, `network/shared.ts:108`   |
| A sales agent is a record inside the retailer's shop tied to a supplier. It has no account link. Territory is one free-text field. Customer assignment and commission do not exist. | `packages/shared-types/src/index.ts:2305`, `commerce-sources.ts:122`                                    |
| No flow lets an unregistered partner later claim its history.                                                                                                                       |                                                                                                         |

## 4. Authorization, tenant isolation, audit

| Finding                                                                                                                                                                                    | Where                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Every business-scoped call is gated by `requireAuthorizedSession(sessionId, businessId, permission)`: PIN-verified session, membership, role permission.                                   | `services/api/src/cp2/store.ts:15219-15288`                      |
| Tenant isolation is application code only. No row-level security exists in any migration.                                                                                                  | `infra/db/migrations/`                                           |
| Two models already describe business-to-business trust and should be extended, not replaced: `DistributionRelationship` and `CommerceRepresentation` (salesperson business to wholesaler). | `packages/shared-types/src/commerce-sources.ts:60`, `:122`       |
| Neither model carries scopes, value limits or expiry. No standing grant between businesses exists.                                                                                         | `services/api/src/cp2/domains/commerce-sources/store.ts:446-640` |
| One cross-account write exists today, `confirmSourceFulfillment`, authorized only by a product id in an invoice snapshot, with no consent from the business being written to.              | `services/api/src/cp2/store.ts:12075`                            |
| The business audit log is mutable. Rows are deleted by the snapshot writer and by account purge, risk is always `low`, and there is no hash chain.                                         | `services/api/src/cp2/store.ts:17109`, `postgres-store.ts:3458`  |
| A real immutability trigger exists on `cp2_runtime_execution_events` and is the pattern to copy.                                                                                           | `infra/db/migrations/087_runtime_execution_events.sql:85-103`    |

## 5. Daemon, Luna and the agent runtime

| Finding                                                                                                                                                                  | Where                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Luna is the catalog model `gpt-6-luna`, vision capable, reached through `createOpenRouterRuntime`. There is no JSON-schema mode; output must be validated by the server. | `services/api/src/inference/openrouter-model-runtime.ts:11-34`, `openrouter-runtime.ts:59-66` |
| The daemon is a leased Postgres queue with retries, backoff and a terminal failed state. Its agent tasks run with no tools.                                              | `services/api/src/daemon/worker.ts:32-211`, `task-store.ts:509-536`, `executor.ts:20`         |
| Scheduled work is declared once in `edgeJobDefinitions` and runs on both Node (interval) and Edge (pg_cron).                                                             | `services/api/src/edge-job-runner.ts:68`                                                      |
| Model output cannot mutate records. It can only propose a tool call, which passes role, policy and confirmation checks before the single dispatcher runs it.             | `services/api/src/cp2/domains/agent-runtime/capabilities.ts:36-40`, `store.ts:2685-2881`      |
| Seven receipt tools exist. `receipt.scan` is text only and cannot receive inventory.                                                                                     | `packages/tool-core/src/domains/receipts.ts`, `agent-runtime/receipt-capabilities.ts`         |
| There is no domain event bus and no general outbox. The only transactional outbox is fulfillment's, with no dead-letter state.                                           | `infra/db/migrations/098_fulfillment_dispatch_automation.sql:80`                              |
| Agents are never notified of business events.                                                                                                                            |                                                                                               |
| A sanitizer for untrusted text exists and should be reused.                                                                                                              | `services/api/src/cp2/agent-business-runtime.ts:640-657`                                      |
| No eval runs on a schedule. The repository rule asks for nightly runs.                                                                                                   | `.github/workflows/ai-eval.yml`                                                               |

## 6. PWA and offline

| Finding                                                                                                                                                           | Where                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| The API sends `permissions-policy: camera=()` on every response, including the app document when the API serves it. A live camera would be blocked there.         | `services/api/src/app.ts:380`                                  |
| The Render static-site CSP has no `wasm-unsafe-eval` and no `blob:` worker source, so on-device OCR cannot run on that deployment. The Vercel CSP is correct.     | `render.yaml:192-196`, `vercel.json`                           |
| Offline state in IndexedDB is plain JSON. Nothing is encrypted.                                                                                                   | `packages/offline-runtime/db/client.ts:10-61`                  |
| Offline receipt capture keeps extracted text only. Image bytes are neither retained nor queued, and offline PDF is rejected.                                      | `packages/offline-runtime/providers/local-provider.ts:240-401` |
| The owner route has about 12 KiB of gzip headroom against a 185 KiB budget. New screens must be lazy chunks.                                                      | `scripts/check-web-bundle-budgets.mjs:11-18`                   |
| There is no component library. Screens use flat class names in one stylesheet, with per-feature English and Kiswahili copy modules. Receipt copy is English only. | `apps/web/src/styles.css`, `apps/web/src/shop-hub-copy.ts`     |
| No test mocks a media API. Component tests use React `act` with jsdom, not Testing Library.                                                                       | `tests/delivery-receipt-review-panel.test.tsx`                 |

## 7. What is reusable

- Receipt job storage, contact matching and the review form (`domains/suppliers`, `ReceiptFieldsForm.tsx`).
- `adjustProductStock`, `createPurchase`, `createSale`, `recordPayment` as the only writers of stock,
  purchase, sale and payment records.
- `DistributionRelationship` and `CommerceRepresentation` as the base for trusted trading relationships.
- The Edge per-request transaction and business-scope locking for atomic multi-account writes.
- `edgeJobDefinitions` for the outbox and reconciliation workers.
- The runtime tool registry and approval pipeline for agent actions.
- The immutability trigger pattern from migration 087.
- The offline operation journal, keyed on account, store, device and sequence.

## 8. Decisions taken from this audit

1. **The engine is a snapshot domain**, `services/api/src/cp2/domains/receipt-commerce/`, in the same
   pattern as `commerce-sources`. Stock, purchases and invoices live in that store, so this is the only
   place a multi-account write can be atomic. Database-level guarantees are added by migration 142:
   unique fingerprint and idempotency indexes, a unique outbox event key, and immutable ledger rows.
2. **A phone number or name never authorizes a cross-account write.** A counterparty is a Grogoni
   account only through an explicit link to its business id, and both accounts must hold an active
   grant naming the other.
3. **Money and quantity in the new engine are integers** (minor units and thousandths).
4. **Luna proposes, deterministic code decides.** Luna output is validated, then math, duplicate,
   identity and authorization checks run in code. Luna cannot post anything.
5. **Document type gates effects by a fixed table.** A quotation posts nothing. An invoice records
   what is owed and never marks itself paid.
6. **"Synchronized" is reported only when every required projection has committed.**

## 9. Implementation priorities

1. Shared contract (`packages/shared-types/src/receipt-commerce.ts`).
2. Deterministic logic: math validation, fingerprints, unit conversion, product matching, effect policy.
3. Luna interpreter with strict validation and an eval.
4. Engine domain: canonical transaction, grants, projections, outbox, ledger, reversal, claims.
5. Smart camera and image pipeline.
6. Scan to synchronize flow, authorization settings, offline drafts.
7. Agent tools and worker jobs.
8. Header and CSP fixes, stale documentation.
