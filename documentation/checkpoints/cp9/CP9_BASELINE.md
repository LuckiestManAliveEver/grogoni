# CP9: Document Import

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03
Target tag: `checkpoint/cp9-document-import`
Actual tag: `checkpoint/cp9-document-import`

## Purpose

CP9 introduces document import so merchants can reduce manual data entry from existing business records while preserving the confirmation boundaries established in CP5 through CP8.

The goal is to let an authorized owner upload or provide structured source files, preview extracted records, correct mappings, and confirm writes into existing product, customer, supplier, invoice, payment, and debt workflows without trusting extracted data as business truth before confirmation.

CP9 is a document import checkpoint. It is not a live OCR platform, automated accounting engine, M-Pesa reconciliation checkpoint, marketplace ingestion system, TIEL checkpoint, local model checkpoint, or full Grogoniclaw runtime checkpoint.

## Formal Entry From CP8

CP8 is accepted as passed.

CP9 starts from:

- CP2 authenticated session, active business, membership, role, and audit event contracts
- CP3 owner web shell and active commerce navigation
- CP4 deterministic parser and non-mutating draft behavior
- CP5 product, customer, supplier, inventory quantity, and inventory movement foundations
- CP6 invoice drafts, previews, confirmation, invoice items, sale stock movements, deterministic totals, and print view
- CP7 offline cache, durable sync queue, idempotent replay, and deterministic conflict surfacing
- CP8 payment records, invoice settlement, and customer debt summaries
- shared-types, business-core, event-core, sync-core, tool-core, API, and web package boundaries
- PostgreSQL migration path and existing in-memory API test store
- CI, lint, typecheck, tests, build, and boundary checks

## CP9 Scope

In scope:

- business-scoped document import job contracts
- source document metadata for uploaded or pasted import files
- CSV import foundation
- XLSX import foundation if dependency and parser constraints stay small
- PDF/DOCX import foundation only for safe text/table extraction if implemented
- supplier import as the first supported confirmed write path
- optional product, customer, invoice, or payment import draft paths if deterministic validation is available
- field mapping between source columns and target business records
- preview rows with validation errors and warnings
- correction before confirmation
- confirmed import application through existing CP5/CP6/CP8 validators
- import events for uploaded, parsed, previewed, confirmed, and failed states
- role checks for import read/write actions
- tests proving extracted data is not saved permanently before confirmation
- tests proving failed import does not corrupt existing records
- web shell entry point for owner-facing import workflow

Out of scope:

- handwritten OCR
- image-based receipt parsing that requires a vision model
- unconfirmed automatic writes to business records
- automatic M-Pesa, card, or bank reconciliation
- production accounting export/general ledger behavior
- marketplace catalog ingestion
- TIEL
- local LLM, cloud model, Pi/OpenClaw, or full Grogoniclaw runtime integration
- broad compliance retention policies beyond the checkpoint's source metadata and audit events

## Target Flow

```text
Owner opens document import
  -> owner uploads or provides a structured source file
  -> API stores source metadata and creates an import job
  -> parser extracts rows without mutating business records
  -> owner reviews preview rows, mappings, validation errors, and warnings
  -> owner corrects mapping or row values
  -> owner confirms selected rows
  -> server applies confirmed rows through existing business validators
  -> import events and audit trail are emitted
```

## Business Rules

- Import jobs must always be scoped to the active business.
- Import source data must not become business records until explicit confirmation.
- Confirmation must route through existing CP5, CP6, and CP8 validators.
- Parser output is advisory and never authoritative by itself.
- Failed parsing or failed confirmation must not partially corrupt existing records.
- Import previews must expose validation errors before confirmation.
- Import confirmation must enforce server-side roles.
- Import jobs must not leak source data across businesses.
- Sensitive source content should not be logged in plaintext.
- Document import must not change CP8 invoice settlement rules.

## CP9 Exit Criteria

CP9 can be marked passed when:

- [x] Document import shared contracts exist.
- [x] Source document/import job storage contracts exist.
- [x] Supplier CSV import can be uploaded or provided, previewed, corrected, and confirmed.
- [x] Extracted rows are validated before confirmation.
- [x] No extracted data is saved permanently without confirmation.
- [x] Failed import does not corrupt existing records.
- [x] Import confirmation enforces business ownership and server-side roles.
- [x] Import events are emitted for key import lifecycle states.
- [x] Web shell exposes owner-facing document import workflow.
- [x] Existing CP1 through CP8 checks still pass.
- [x] Checkpoint tag `checkpoint/cp9-document-import` is created.

## Rollback Instructions

Rollback target:

- Return to CP8 payment/debt behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP4 parser behavior.
- Preserve CP5 business core records.
- Preserve CP6 invoice confirmation behavior.
- Preserve CP7 sync queue behavior.
- Preserve CP8 payment settlement behavior.

Rollback trigger examples:

- import writes records without explicit confirmation
- failed imports corrupt existing products, suppliers, invoices, or payments
- source documents leak across business boundaries
- import preview hides validation errors
- import confirmation bypasses existing validators or role checks
- sensitive source content is logged in plaintext
- CP1 through CP8 checks regress

## Next Checkpoint

Next checkpoint:

- CP10: Grogoniclaw Runtime Full Adapter

CP10 should build on stable deterministic import and business tool contracts without allowing model output to mutate records directly.
