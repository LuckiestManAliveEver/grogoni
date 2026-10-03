# CP15: Beta Release Hardening

Status: passed
Date opened: 2026-07-05
Date passed: 2026-07-05
Target tag: `checkpoint/cp15-closed-beta`
Actual tag: `checkpoint/cp15-closed-beta`

## Purpose

CP15 prepares Grogoni for selected merchant usage by hardening the product, runtime, offline behavior, payment workflows, sync reliability, support process, and telemetry before public launch.

The goal is to make the current core commerce system practical for a small closed beta while keeping risky launch, marketplace, and full TIEL work out of scope.

CP15 is a closed beta readiness checkpoint. It is not a public launch checkpoint, marketplace foundation checkpoint, full Trusted Identity Execution Layer checkpoint, broad provider-certification checkpoint, or autonomous operations checkpoint.

## Formal Entry From CP14

CP14 is accepted as passed.

CP15 starts from:

- CP2 authenticated session, active business, membership, role, and audit event contracts
- CP3 mobile shell, chat shell, quick actions, offline/sync status, and commerce empty states
- CP4 deterministic parser, confidence scoring, clarification, and chat integration
- CP5 product, customer, supplier, inventory quantity, and stock movement foundations
- CP6 invoice draft, preview, confirmation, totals, print view, and sale stock movements
- CP7 offline cache, sync queue, idempotent replay, and conflict surfacing
- CP8 payment records, invoice settlement, and customer debt summaries
- CP9 supplier document import preview, correction, confirmation, and import lifecycle events
- CP10 Grogoniclaw runtime sessions, turns, planning, confirmation gates, telemetry, and rate limits
- CP11 optional local model adapter with deterministic fallback and bounded output parsing
- CP12 reports, notifications, bounded knowledge summaries, and owner report UI
- CP13 deterministic logistics records, lifecycle validation, bounded runtime/report context, and sync replay behavior
- CP14 data export, deletion scheduling, retention summaries, verification tiers, tax config, device trust placeholder, and security review workflows
- shared-types, business-core, event-core, sync-core, tool-core, API, AI runtime, and web package boundaries
- existing CI, lint, typecheck, tests, and boundary checks

## CP15 Scope

In scope:

- closed beta onboarding readiness for selected merchants
- beta feature flag and release gate definitions
- low-end Android usability checks for 1 GB and 2 GB device targets
- offline workflow hardening for products, customers, invoices, payments, imports, logistics, reports, and compliance views
- sync stress testing and deterministic replay checks under repeated queued mutations
- payment testing for staging and controlled production boundaries without broad provider certification
- payment reconciliation checks for existing CP8 settlement behavior
- UX refinements for beta-critical owner workflows in the mobile web shell
- support process, issue intake, severity labels, and rollback communication rules
- crash and error telemetry contracts that avoid sensitive data exposure
- beta readiness report, runtime context, and documentation
- tests proving beta gates, offline/sync hardening, payment reconciliation boundaries, telemetry safety, and support workflows
- documentation for beta operating rules and rollback triggers

Out of scope:

- public launch readiness and public marketing rollout
- marketplace buyer, courier, seller, or trust network workflows
- full TIEL implementation, biometric identity verification, or external identity network operation
- broad KYC/KYB, tax, payment, SMS, email, WhatsApp, push, carrier, map, courier, or analytics provider integration
- autonomous background agents that can mutate business state without confirmation
- production infrastructure-as-code beyond beta readiness notes
- replacing deterministic validators, audit events, sync replay rules, or runtime confirmation gates
- changing prior invoice, payment, compliance, or audit truth without explicit deterministic migrations

## Target Flow

```text
Selected merchant is invited to beta
  -> beta eligibility and feature gates are checked
  -> merchant uses core mobile workflows daily
  -> offline writes queue and replay deterministically
  -> payments and debt reconcile against invoices
  -> errors, crashes, support issues, and rollback signals are captured without sensitive payloads
  -> operators can pause onboarding or disable risky beta features if metrics regress
```

## Business Rules

- Closed beta access must be explicit and reversible.
- Beta feature flags must default to conservative behavior.
- Offline writes must remain deterministic and replayable.
- Sync failures must be visible to the merchant and auditable for operators.
- Payment reconciliation must preserve CP8 invoice settlement truth.
- Crash, error, support, and telemetry records must avoid raw customer, payment, account deletion, export, tax, or identity payloads.
- Support workflows must preserve business-scoped access controls.
- Runtime and model prompts must receive bounded beta readiness summaries, not raw telemetry or support dumps.
- CP1 through CP14 checks must continue to pass.

## CP15 Exit Criteria

CP15 can be marked passed when:

- [x] Closed beta onboarding gate exists and is reversible.
- [x] Beta feature flags and release gates are documented and enforced.
- [x] 1 GB and 2 GB Android usability targets are tested or simulated with documented constraints.
- [x] Offline workflows are tested across beta-critical records.
- [x] Sync stress tests prove repeated queued mutations replay deterministically.
- [x] Payment testing and reconciliation checks pass in staging and controlled production boundaries.
- [x] UX refinements for beta-critical owner workflows are implemented.
- [x] Support process, severity labels, and rollback communication rules are documented.
- [x] Crash and error telemetry contracts exist and avoid sensitive data exposure.
- [x] Beta readiness report or summary is available to owner/operator workflows.
- [x] Tests prove beta gates, offline/sync hardening, payment reconciliation, telemetry safety, and support workflow behavior.
- [x] Existing CP1 through CP14 checks still pass.
- [x] Checkpoint tag `checkpoint/cp15-closed-beta` is created.

## Rollback Instructions

Rollback target:

- Return to CP14 security, compliance, and TIEL-preparation behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP3 shell behavior.
- Preserve CP4 deterministic parser behavior.
- Preserve CP5 through CP9 deterministic business workflows.
- Preserve CP10 runtime verification behavior.
- Preserve CP11 local-model fallback behavior.
- Preserve CP12 report, notification, and knowledge behavior.
- Preserve CP13 logistics behavior.
- Preserve CP14 compliance, export, deletion, verification, tax, and device trust behavior.
- Disable CP15 beta gates, beta reports, support surfaces, and telemetry surfaces if they regress safety or usability.

Rollback trigger examples:

- beta access cannot be paused or revoked
- feature flags expose unreviewed workflows to beta users
- offline writes are lost, duplicated, or replayed out of order
- sync stress testing shows unrecoverable conflicts or hidden failures
- payment reconciliation changes invoice settlement truth incorrectly
- crash, error, support, telemetry, runtime context, or prompts leak sensitive data
- support workflows expose cross-business records
- low-end device workflows are unusable for beta-critical tasks
- CP10 runtime confirmation gates regress
- CP11 local-model fallback or bounded output behavior regresses
- CP12 report/notification boundaries regress
- CP13 logistics boundaries regress
- CP14 compliance/security boundaries regress
- CP1 through CP14 checks regress

## Next Checkpoint

Next checkpoint:

- CP16: Public Launch

CP16 should begin only after closed beta hardening passes and beta readiness metrics support a controlled public launch.
