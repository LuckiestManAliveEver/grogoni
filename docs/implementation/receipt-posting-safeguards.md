# Receipt posting safeguards

This is the first executable phase of the receipt-to-commerce checklist. It does not yet synchronize accounts. It extends the existing supplier receipt writer, stock movement writer and commerce metadata collection.

## Behavior

Before recording a purchase, classify its document and enter its actual date and grand total. The existing review form persists `documentType`, `fulfillmentStatus`, `receipt.taxBasis`, product `lineDiscount` and `lineTotalSource`. Stock additionally requires explicit delivery confirmation and known units. A quotation, return, credit, refund or payment receipt cannot use the positive-purchase writer. An invoice does not record payment.

Financial discrepancies must be corrected before posting. Validation uses two-decimal minor units, thousandth quantities, integer multiplication and one minor unit of rounding tolerance. Included tax is informational in the total equation; exclusive tax is added. Unknown tax basis with positive tax blocks posting. Calculated totals remain labeled as derived and require review. Printed/model labels never establish authenticity or authorization.

Configure packaging in the existing Commerce sources panel. Select the product, pack unit and verified count of stock units. Saving requires the existing `product:write` permission and explicit confirmation. Revocation prevents future conversions; changing a product's stock unit invalidates definitions for its old unit. Completed receipt bindings retain the conversion actually used, so retries do not recalculate stock under a later definition.

The existing commerce operations API supports:

- `packaging.verify`: `{ productId, packUnit, unitsPerPack, confirmed: true }`.
- `packaging.revoke`: `{ id }`.

Existing `GET /businesses/:businessId/commerce-sources` returns scoped packaging metadata. Existing receipt creation/correction routes parse the new document fields; confirmation runs the gates for manual, image, offline-synced and tool-created jobs. No new public/unscoped endpoint exists.

## Files

- `services/api/src/cp2/domains/receipt-commerce/`: document effects, financial validation, local receipt identity and verified unit conversion.
- `services/api/src/cp2/domains/suppliers/{shared,receipt-fields,store}.ts`: parsing, preserved evidence, warnings and confirmation gates.
- `services/api/src/cp2/store.ts`: stock preflight, conversions, retained delivery bindings and retry controls.
- `services/api/src/cp2/domains/commerce-sources/store.ts`: packaging verification/revocation through existing authorization, persistence and audit mechanisms.
- `packages/shared-types/src/{index,commerce-sources,receipt-commerce}.ts`: additive contracts; the receipt-commerce contract was reused from existing local work.
- `apps/web/src/{ReceiptFieldsForm,CommerceSourcesPanel}.tsx`: document/delivery review and packaging controls.
- Migration/rollback `140_receipt_verified_packaging`: extend existing metadata constraints; no second product, inventory or invoice ledger.
- `tests/receipt-posting-{validation,postgres}.test.ts`: adversarial numeric/document/stock tests, evaluation grid, restart and PostgreSQL constraints. Existing receipt/offline fixtures now include explicit review where posting is expected.

## Rollout

1. Back up the target database under the existing deployment procedure. Apply migration 140 with the existing `pnpm db:migrate` tooling before deploying the new API. This phase has only been migrated on an isolated local PostgreSQL database.
2. Deploy API/Edge and frontend together. No new daemon schedule or inference provider is required. Build/deploy the API and frontend through the existing release pipeline; locally restart their normal dev processes after rebuilding shared contracts.
3. Verify old drafts load as unclassified and cannot post until reviewed. Verify a known packaging conversion and repeated confirmation against test accounts before any production acceptance claim.
4. To roll back, deploy the prior application and apply the provided non-destructive rollback only if required. It removes the packaging index/validation but deliberately retains the expanded kind allowlist and evidence. Older code ignores packaging metadata. Application rollback restores its previous, weaker receipt posting behavior; account for that operationally.

The isolated test migration chain also required the repository's migration 108 opt-in because the database was empty. This does not authorize or recommend running that destructive historical cleanup again against a populated deployment.

## Remaining boundaries

Supplier/document-number duplicate checks survive reload but are not a database-enforced canonical receipt identity. Documents without stable numbers, OCR-altered identities and concurrent processes still need the full receipt transaction/idempotency work. Packaging database uniqueness is enforced separately.

No cross-account grants, participant resolution/outbox, synchronized AP/AR/commissions, reversals, protected image retention, camera/CV, scanned-PDF extraction or real-device/live-model certification is delivered by this phase. No old receipt data is relabeled as verified, no payment is inferred and no production data is changed. Keep those checklist items open.

## Validation

Validation results are recorded in the implementation checklist after the final runs. PostgreSQL tests use a separate local container/database and exercise actual save/reload, uniqueness/invalid-value rejection and rollback retention. The existing multi-party source-order test is regression coverage; it is not the missing scan-driven three-account acceptance test.

## Trading-permission foundation (subsequent checkpoint)

The existing commerce operations API also accepts `trading_grant.create` and `trading_grant.revoke`. Only the business owner can issue/revoke these standing permissions. Creation requires `confirmed: true`, an available partner business id, `partnerRole`, explicit local supplier/customer id (or current principal-approved salesperson `representationId`), allowed transaction kinds, a currency, nullable integer minor-unit ceiling, explicit posting permission booleans, bounded agent delegation and a future UTC ISO expiry. No ceiling means no automatic posting. Terms cannot be edited in place: revoke and replace them.

`receipt-commerce/trading-policy.ts` checks current scope, expiry/revocation, representation, categories, currency, value, individual effects and agent ceiling. Migration 141 stores these records in the existing commerce table and enforces one active permission per account/partner/role. API startup now requires migration 141. Apply migrations 140 and 141 before deploying this checkpoint. Rollbacks retain evidence and expanded kind allowlists.

This API/evaluator is preparatory. There is no receipt participant consumer yet, no two-sided account synchronization or owner policy settings screen. A local receipt confirmation does not consume a grant to write another account. The corresponding checklist item remains open until orchestration invokes the evaluator for each effect and retry. Persisting permission configuration alone is not cross-account authorization acceptance.
