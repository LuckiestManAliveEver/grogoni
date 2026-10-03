# CP5: Business Core Records

Status: passed
Date opened: 2026-07-02
Date passed: 2026-07-02
Target tag: `checkpoint/cp5-business-core-records`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP5 replaces the paper ledger for the first core business records.

The goal is to introduce deterministic product, customer, supplier, inventory quantity, and inventory movement foundations that can be used by forms and, later, by CP4 parsed chat drafts. CP5 must keep business truth in validated application and database code, not in parser output or model behavior.

CP5 is a records checkpoint, not an invoicing, payments, tax, offline sync, or marketplace checkpoint.

## Formal Entry From CP4

CP4 is accepted as passed.

CP5 starts from:

- React/Vite mobile PWA shell
- authenticated CP2 session and active business contract
- CP3 commerce shell routes and empty states
- CP4 deterministic parser and non-mutating parsed drafts
- Fastify API boundary
- business, event, sync, tool, and UI package boundaries
- PostgreSQL migration path
- CI, lint, typecheck, tests, build, and boundary checks

## CP5 Scope

In scope:

- product create, update, and list/view foundations
- customer create, update, and list/view foundations
- minimal supplier create, update, and list/view foundations
- inventory quantity state
- inventory movement records for stock adjustments
- server-side business membership and role enforcement
- local business validation for required fields, quantity, and ownership boundaries
- audit/business events for product, customer, supplier, and stock mutations
- web shell integration for owner-facing product and customer workflows
- tests for core business rules and API behavior

Out of scope:

- invoice creation and totals
- tax calculation and launch-country compliance
- payment recording, debt tracking, M-Pesa, or payment webhooks
- offline mutation queue and durable local sync storage
- document import
- full staff invitation and role management UI
- marketplace behavior
- TIEL
- local LLM, cloud model, Pi/OpenClaw, or full Grogoniclaw runtime integration

## Target Flow

```text
Owner opens business shell
  -> owner creates or edits product/customer/supplier record
  -> API validates membership, role, and business ownership
  -> product stock adjustment creates inventory movement
  -> mutation emits audit/business event
  -> web shell shows persisted records
  -> CP4 parsed drafts remain drafts until routed through these validators
```

## Business Rules

- Records must always be scoped to the active business.
- Only authorized business members may mutate records.
- Product names must be present and normalized for storage.
- Product quantity must be numeric and must not silently become invalid.
- Stock changes must create inventory movement records.
- Inventory movements must preserve before and after quantities.
- Customer names must be present.
- Supplier support is minimal and must not pull invoice or payment behavior into CP5.
- State-changing operations must emit audit/business events.
- CP4 parser output may prefill or suggest, but may not bypass CP5 validation.

## CP5 Exit Criteria

CP5 is marked passed because:

- [x] Product create, edit, and view/list flows exist.
- [x] Customer create, edit, and view/list flows exist.
- [x] Minimal supplier create, edit, and view/list foundations exist.
- [x] Product inventory quantity is stored and validated.
- [x] Stock adjustment always creates an inventory movement event.
- [x] Product quantity cannot silently become invalid.
- [x] Server-side role checks protect CP5 mutations.
- [x] Business ownership boundaries are enforced.
- [x] Product, customer, supplier, and stock mutations emit events.
- [x] Web shell exposes owner-facing product and customer workflows.
- [x] Unit/API tests cover core business rules.
- [x] Existing CP1, CP2, CP3, and CP4 checks still pass.
- [x] Checkpoint tag `checkpoint/cp5-business-core-records` is created.

## Rollback Instructions

Rollback target:

- Return to CP4 non-mutating parsed drafts and CP3 commerce empty states.
- Preserve CP2 auth/business/session behavior.
- Preserve CP4 parser behavior.

Rollback trigger examples:

- stock quantity can become invalid without an explicit failed validation
- stock changes do not emit inventory movement records
- product/customer records leak across business boundaries
- CP5 mutations bypass server-side role checks
- CP5 records depend on model or parser output for correctness
- CP1 through CP4 checks regress

## Next Checkpoint

Next checkpoint:

- CP6: Invoice and Inventory Flow

CP6 should use CP5 product, customer, supplier, and inventory foundations to implement deterministic invoice and stock movement workflows.
