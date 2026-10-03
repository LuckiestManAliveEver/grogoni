# CP16: Public Launch

Status: passed
Date opened: 2026-07-05
Date passed: 2026-07-05
Target tag: `checkpoint/cp16-public-launch`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP16 prepares Grogoni for a controlled public launch after CP15 closed beta hardening passed.

The goal is to convert the beta-ready product into a launch-ready product with public onboarding, launch operations, production readiness checks, support coverage, safety monitoring, and rollback controls.

CP16 is a public launch checkpoint. It is not a marketplace foundation checkpoint, full Trusted Identity Execution Layer checkpoint, autonomous operations checkpoint, or broad trust-network rollout checkpoint.

## Formal Entry From CP15

CP15 is accepted as passed.

CP16 starts from:

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
- CP15 closed beta access, release gates, device checks, support process, telemetry contracts, beta readiness report, and rollback controls
- shared-types, business-core, event-core, sync-core, tool-core, API, AI runtime, and web package boundaries
- existing CI, lint, typecheck, tests, and boundary checks

## CP16 Scope

In scope:

- public onboarding readiness for self-serve merchants
- launch readiness gate based on CP15 beta status, support readiness, telemetry health, and operational controls
- production launch checklist, launch freeze rules, incident severity, and rollback procedure
- public release settings that can open onboarding while preserving business-scoped access controls
- launch support operating model, escalation states, and customer-facing issue categories
- launch-safe telemetry summaries for adoption, activation, support load, crash-free sessions, sync health, and payment reconciliation
- production readiness documentation for environment variables, secrets, backups, monitoring, and deploy verification
- first-run product experience refinements for public merchants
- public launch reports, notifications, runtime context, and owner/operator UI surfaces
- tests proving launch gates, rollback controls, public onboarding boundaries, telemetry safety, and existing checkpoint regressions

Out of scope:

- marketplace buyer, courier, seller, or trust network workflows
- full TIEL implementation, biometric identity verification, or external identity network operation
- broad external provider certification beyond launch readiness placeholders and documented requirements
- autonomous background agents that can mutate business state without confirmation
- production infrastructure-as-code beyond readiness documentation and deterministic launch checks
- changing prior invoice, payment, compliance, audit, logistics, beta, or runtime truth without explicit deterministic migrations
- paid marketing campaigns, legal launch approvals, or non-code business operations outside the repository

## Target Flow

```text

Operator reviews launch readiness
  -> CP15 beta gates, support state, telemetry health, and rollback controls are checked
  -> public onboarding is enabled through a reversible launch setting
  -> new merchant creates a business and completes launch-safe first-run setup
  -> core commerce workflows remain deterministic online and offline
  -> support, telemetry, sync, payment, and compliance signals stay bounded and auditable
  -> operators can pause onboarding or roll back public launch without data rescue
```

## Business Rules

- Public launch access must be explicit, reversible, and auditable.
- Public onboarding must preserve CP2 authentication, membership, role, and audit boundaries.
- Launch readiness must depend on deterministic gates, not manual claims alone.
- Launch telemetry must expose aggregate health without raw customer, payment, compliance, tax, identity, support, or telemetry payloads.
- Support escalation states must be business-scoped and operator-readable.
- Rollback must pause public onboarding without deleting businesses or mutating prior commerce truth.
- Runtime and model prompts must receive bounded public launch summaries, not raw support or telemetry dumps.
- CP1 through CP15 checks must continue to pass.

## CP16 Exit Criteria

CP16 can be marked passed when:

- [x] Public launch gate exists and is reversible.
- [x] Public onboarding can be enabled, paused, and audited.
- [x] Launch readiness report combines beta status, support state, telemetry health, sync health, payment reconciliation, and rollback state.
- [x] First-run public merchant workflow is implemented or refined for launch-critical setup.
- [x] Launch support process, incident severity, escalation, and customer-facing issue categories are documented.
- [x] Launch-safe telemetry contracts exist and avoid sensitive data exposure.
- [x] Production readiness checklist exists for configuration, secrets, backup, monitoring, deploy verification, and rollback.
- [x] Runtime context and reports include bounded public launch readiness summaries.
- [x] Tests prove launch gates, public onboarding boundaries, rollback controls, telemetry safety, and support workflow behavior.
- [x] Existing CP1 through CP15 checks still pass.
- [ ] Checkpoint tag `checkpoint/cp16-public-launch` is created. **Not actually done** — no `.repo.git` directory or `checkpoint/cp16-public-launch` tag exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Rollback Instructions

Rollback target:

- Return to CP15 closed beta behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP3 shell behavior.
- Preserve CP4 deterministic parser behavior.
- Preserve CP5 through CP9 deterministic business workflows.
- Preserve CP10 runtime verification behavior.
- Preserve CP11 local-model fallback behavior.
- Preserve CP12 report, notification, and knowledge behavior.
- Preserve CP13 logistics behavior.
- Preserve CP14 compliance, export, deletion, verification, tax, and device trust behavior.
- Preserve CP15 beta gates, support, telemetry, and readiness behavior.
- Disable CP16 public onboarding, public launch gates, and launch reports if launch readiness regresses.

Rollback trigger examples:

- public onboarding cannot be paused or revoked
- public onboarding bypasses authentication, role, membership, or audit boundaries
- launch readiness can pass while beta gates, support, telemetry, sync, payment, or rollback checks are unsafe
- telemetry, support, runtime context, or prompts leak sensitive data
- rollback mutates prior commerce, payment, compliance, logistics, beta, or audit truth
- support workflow exposes cross-business records
- sync replay, payment reconciliation, or offline cache behavior regresses
- CP10 runtime confirmation gates regress
- CP11 local-model fallback or bounded output behavior regresses
- CP12 report/notification boundaries regress
- CP13 logistics boundaries regress
- CP14 compliance/security boundaries regress
- CP15 beta hardening boundaries regress
- CP1 through CP15 checks regress

## Next Checkpoint

Next checkpoint:

- CP17: Marketplace Foundation

CP17 should begin only after public launch passes and launch telemetry supports marketplace foundation work.
