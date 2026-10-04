# CP7 Decision Log

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03

This file records offline local data and sync queue decisions for CP7.

## Accepted Decisions

| ID      | Decision                                                                                        | Rationale                                                                                        | Impact                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| CP7-D01 | Treat server-side business rules as the source of truth for queued mutation replay.             | Offline capture must not weaken CP5/CP6 validation, role checks, or business boundaries.         | Queue replay must call the same validation paths used by online mutations.                                    |
| CP7-D02 | Store queued mutations as explicit envelopes with idempotency keys and business scope metadata. | Retries and intermittent connectivity require duplicate-safe replay and clear ownership context. | Queue records need stable IDs, business IDs, actor/session context, operation types, payloads, and statuses.  |
| CP7-D03 | Distinguish cached/local state from server-confirmed state in owner-facing UI.                  | Owners should be able to work offline without mistaking queued work for confirmed server truth.  | Web shell must show offline status, queued count, and failed/conflict indicators.                             |
| CP7-D04 | Represent conflicts deterministically instead of attempting broad automatic merge behavior.     | CP5/CP6 workflows include inventory and invoice rules where silent merges can corrupt state.     | Conflicts should preserve local payload and server rejection reason for owner review or retry.                |
| CP7-D05 | Keep payments and debt workflows deferred to CP8.                                               | Payment trust, settlement, and reconciliation have different risk and correctness requirements.  | CP7 may queue supported CP5/CP6 mutations, but payment recording is out of scope.                             |
| CP7-D06 | Keep sync infrastructure independent from AI/model/runtime implementation.                      | CP7 is an offline data reliability checkpoint, not an execution/runtime checkpoint.              | Sync packages and API replay must not import AI runtime, local model, or Grogoniclaw adapter implementations. |

## Deferred Decisions

| Decision                                          | Deferred To | Reason                                                           |
| ------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| Payment/debt mutation queue semantics             | CP8         | Payment correctness belongs to the payments checkpoint.          |
| Document import offline capture                   | CP9         | Import parsing needs stable document workflows first.            |
| Grogoniclaw runtime tool execution against queue  | CP10        | Runtime adapter should consume stable deterministic tools later. |
| Local model execution for offline AI assistance   | CP11        | Local model adapter depends on runtime/tool boundaries.          |
| Production sync service scaling and observability | CP14/CP15   | Hardening belongs closer to beta readiness.                      |

## CP7 Boundary Checks

CP7 must preserve these checks:

- Offline data and queued mutations are business-scoped.
- Queue replay does not bypass server-side role checks.
- Queue replay does not bypass CP5 product and inventory validation.
- Queue replay does not bypass CP6 invoice confirmation validation.
- Queued invoice confirmation does not decrement inventory until replay succeeds.
- Cached/local UI states do not claim server confirmation.
- Payment, debt, and M-Pesa behavior remain out of scope.
- Sync infrastructure does not import AI runtime implementation.
- Existing CP1 through CP6 tests continue to pass.
