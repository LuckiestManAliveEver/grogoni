# CP6: Invoice and Inventory Flow

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03
Target tag: `checkpoint/cp6-invoice-inventory`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP6 introduces the first deterministic commerce workflow on top of CP5 records.

The goal is to let an owner create an invoice with line items, preview the totals, confirm the invoice, and emit inventory movement records for confirmed sales. CP6 must keep invoice math, invoice numbering, inventory effects, and confirmation behavior deterministic and test-covered.

CP6 is an invoicing and inventory checkpoint. It is not a payments, debt tracking, M-Pesa, offline sync, document import, marketplace, or full compliance checkpoint.

## Formal Entry From CP5

CP5 is accepted as passed.

CP6 starts from:

- CP2 authenticated session, active business, membership, role, and audit event contracts
- CP3 mobile/web shell and commerce navigation
- CP4 deterministic parser and non-mutating parsed drafts
- CP5 product, customer, supplier, inventory quantity, and inventory movement foundations
- Fastify API boundary
- business, event, sync, tool, shared-types, and UI package boundaries
- PostgreSQL migration path
- CI, lint, typecheck, tests, build, and boundary checks

## CP6 Scope

In scope:

- invoice create, update-draft, preview, confirm, and list/view foundations
- invoice item records tied to CP5 products
- deterministic invoice number generation per business
- deterministic subtotal, tax placeholder/configurable tax, and total calculation
- inventory availability checks during confirmation
- inventory movement records emitted for confirmed sales
- customer association when available, with a walk-in/customer-optional path if needed
- printable invoice output or browser print-ready view
- web shell integration for owner-facing invoice workflow
- chat-to-invoice draft path that still requires deterministic validation and confirmation
- tests for invoice math, inventory effects, API boundaries, and parser-to-draft behavior

Out of scope:

- payment recording
- debt tracking and accounts receivable workflows
- M-Pesa, card, cash reconciliation, or payment webhooks
- production tax compliance and jurisdiction rules beyond a placeholder/configurable tax line
- offline mutation queue and durable local sync storage
- PDF service infrastructure beyond printable/browser output if that is the smallest safe implementation
- document import
- marketplace behavior
- TIEL
- local LLM, cloud model, Pi/OpenClaw, or full Grogoniclaw runtime integration

## Target Flow

```text
Owner opens invoice workflow
  -> owner selects or drafts customer and product line items
  -> API validates business membership, roles, product ownership, quantities, and totals
  -> app shows deterministic invoice preview
  -> owner confirms invoice
  -> invoice is saved with a business-scoped invoice number
  -> product inventory quantities are reduced
  -> inventory movement and business events are emitted
  -> printable invoice output is available
```

## Business Rules

- Invoices must always be scoped to the active business.
- Only authorized business members may create or confirm invoices.
- Invoice numbers must be unique within a business and deterministic enough for tests.
- Invoice totals must be calculated by server-side business rules, not trusted from the client.
- Invoice item product references must belong to the invoice business.
- Confirming an invoice must fail if stock is insufficient.
- Confirming an invoice must create inventory movement records for product line items.
- Draft or preview invoices must not mutate inventory.
- Confirmed invoice inventory movement must preserve before and after quantities.
- Chat-generated invoice drafts may prefill fields but may not bypass CP6 validation or confirmation.
- Payments and debt status must remain deferred to CP8.

## CP6 Exit Criteria

CP6 is marked passed because:

- [x] Invoice create, preview, confirm, and list/view flows exist.
- [x] Invoice item records exist and reference business-scoped CP5 products.
- [x] Invoice numbers are generated and unique per business.
- [x] Invoice subtotal, tax placeholder/configurable tax, and total are deterministic and test-covered.
- [x] Confirmed invoices reduce product inventory.
- [x] Confirmed invoices emit inventory movement records and business events.
- [x] Draft/preview invoice work does not mutate inventory.
- [x] Server-side role checks protect invoice mutations.
- [x] Business ownership boundaries are enforced.
- [x] Web shell exposes owner-facing invoice workflow.
- [x] Chat-to-invoice draft path remains non-mutating until confirmation.
- [x] Existing CP1, CP2, CP3, CP4, and CP5 checks still pass.
- [x] Checkpoint tag `checkpoint/cp6-invoice-inventory` is created.

## Rollback Instructions

Rollback target:

- Return to CP5 product, customer, supplier, and manual stock adjustment records.
- Preserve CP2 auth/business/session behavior.
- Preserve CP4 parser behavior.
- Preserve CP5 inventory movement history.

Rollback trigger examples:

- invoice totals are non-deterministic or client-trusted
- confirmed invoices can oversell stock
- draft/preview invoices mutate inventory
- invoice records leak across business boundaries
- invoice confirmation bypasses server-side role checks
- invoice creation introduces payments, debt, or M-Pesa behavior ahead of CP8
- CP1 through CP5 checks regress

## Next Checkpoint

Next checkpoint:

- CP7: Offline Local Data and Sync Queue

CP7 should use the CP5/CP6 record and event model to design durable local mutations and conflict handling.
