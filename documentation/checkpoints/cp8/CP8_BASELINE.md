# CP8: Payments and Debt Tracking

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03
Target tag: `checkpoint/cp8-payments-debt`
Actual tag: `checkpoint/cp8-payments-debt`

## Purpose

CP8 introduces deterministic payment recording and debt tracking on top of CP6 invoices and CP7 sync semantics.

The goal is to let an authorized owner record payments against invoices, track unpaid and partially paid balances, associate debt with customers when available, and preserve a payment audit trail without claiming external provider settlement unless that settlement has been explicitly recorded.

CP8 is a payments and debt checkpoint. It is not a full M-Pesa production integration, card processing, tax compliance, document import, marketplace, runtime/model, or broad financial compliance checkpoint.

## Formal Entry From CP7

CP7 is accepted as passed.

CP8 starts from:

- CP2 authenticated session, active business, membership, role, and audit event contracts
- CP3 owner web shell and active commerce navigation
- CP4 deterministic parser and non-mutating draft behavior
- CP5 product, customer, supplier, inventory quantity, and inventory movement foundations
- CP6 invoice drafts, previews, confirmation, invoice items, sale stock movements, deterministic totals, and print view
- CP7 offline cache, durable sync queue, idempotent replay, and deterministic conflict surfacing
- shared-types, business-core, event-core, sync-core, tool-core, API, and web package boundaries
- PostgreSQL migration path and existing in-memory API test store
- CI, lint, typecheck, tests, build, and boundary checks

## CP8 Scope

In scope:

- payment records scoped to a business and invoice
- payment method values for cash, bank transfer, mobile money manual entry, card manual entry, and other/manual
- partial payment and full payment calculations
- invoice balance, paid total, and payment status such as unpaid, partially paid, paid, and overpaid/credit if explicitly supported
- debt tracking for unpaid customer-associated invoices
- customer balance/debt summary foundations
- payment create/list/view foundations
- payment reversal or void foundation if needed to avoid destructive edits
- deterministic server-side payment total and invoice balance calculations
- business events for payment recorded and payment reversed/voided if implemented
- role checks for payment read/write actions
- CP7 sync queue support for offline payment recording if safe and deterministic
- web shell integration for owner-facing payment and debt workflow
- tests for invoice settlement, customer debt summaries, API boundaries, idempotency where applicable, and CP7 replay conflicts

Out of scope:

- live M-Pesa STK push, callbacks, and webhook reconciliation
- live card processing or bank API integration
- provider credential management
- chargebacks, disputes, refunds, and multi-provider settlement ledgers
- production accounting exports and general ledger integration
- tax remittance/compliance decisions
- document import
- marketplace payments
- TIEL
- local LLM, cloud model, Pi/OpenClaw, or full Grogoniclaw runtime integration

## Target Flow

```text
Owner opens payment workflow
  -> owner selects a confirmed invoice or customer debt record
  -> API validates business membership, roles, invoice ownership, and payment amount
  -> owner records a cash/manual payment with method and reference
  -> server calculates paid total, balance, and payment status
  -> invoice/debt summary updates without changing inventory
  -> payment event and audit trail are emitted
  -> optional CP7 queue replay can record safe offline payments through the same validators
```

## Business Rules

- Payments must always be scoped to the active business.
- Payments must reference an invoice owned by the same business.
- Payment amounts must be finite positive numbers.
- Payment totals and balances must be calculated server-side.
- Recording a payment must not mutate inventory.
- Confirmed invoice totals remain the source for amount due.
- Draft invoice payment recording is disallowed unless CP8 explicitly supports deposits.
- Customer debt summaries must not leak invoices across businesses.
- Payment edits should be append-only through reversal/void behavior if corrections are needed.
- Offline payment replay must not bypass server-side role checks or invoice ownership validation.
- Provider-specific settlement claims remain out of scope unless manually recorded as a reference.

## CP8 Exit Criteria

CP8 can be marked passed when:

- [x] Payment shared contracts exist.
- [x] Payment records and payment status/balance contracts exist for invoices.
- [x] Payment create and list/view API routes exist.
- [x] Payment mutations enforce business ownership and server-side roles.
- [x] Server-side payment amount validation exists.
- [x] Invoice paid total, balance, and status are deterministic and test-covered.
- [x] Customer debt summary exists for unpaid and partially paid invoices.
- [x] Payment business events are emitted.
- [x] Payment recording does not mutate inventory.
- [x] Web shell exposes owner-facing payment/debt workflow.
- [x] CP7 replay support exists for safe offline payment recording or is explicitly deferred with tests proving no unsupported mutation is accepted.
- [x] Existing CP1 through CP7 checks still pass.
- [x] Checkpoint tag `checkpoint/cp8-payments-debt` is created.

## Rollback Instructions

Rollback target:

- Return to CP7 offline sync and CP6 online invoice/inventory behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP4 parser behavior.
- Preserve CP5 business core records and inventory movement behavior.
- Preserve CP6 invoice confirmation behavior.
- Preserve CP7 sync queue behavior.

Rollback trigger examples:

- payment records leak across business boundaries
- payment totals are client-trusted or non-deterministic
- payments mutate inventory
- draft invoices can be settled accidentally
- customer debt summaries include another business's invoices
- payment reversal/void behavior deletes audit history
- CP7 replay can duplicate payments
- CP1 through CP7 checks regress

## Next Checkpoint

Next checkpoint:

- CP9: Document Import

CP9 should build on stable product, customer, invoice, payment, and debt schemas without changing CP8 settlement rules.
