# CP7: Offline Local Data and Sync Queue

Status: passed
Date opened: 2026-07-03
Date passed: 2026-07-03
Target tag: `checkpoint/cp7-offline-sync`
Actual tag: not created. No `.repo.git` directory exists in this checkout; see the corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

## Purpose

CP7 introduces the offline-first data foundation for Grogoni.

The goal is to let the app keep useful business data available when connectivity is unreliable, queue supported local mutations durably, replay them through server-side business rules, and surface deterministic conflict states when the server rejects or supersedes local work.

CP7 is an offline local data and sync queue checkpoint. It is not a payments, debt tracking, M-Pesa, document import, marketplace, full Grogoniclaw runtime, local model adapter, or compliance checkpoint.

## Formal Entry From CP6

CP6 is accepted as passed.

CP7 starts from:

- CP2 authenticated session, active business, membership, role, and audit event contracts
- CP3 installable mobile/web shell and offline/sync placeholder surfaces
- CP4 deterministic parser and non-mutating draft behavior
- CP5 product, customer, supplier, inventory quantity, and inventory movement foundations
- CP6 invoice drafts, previews, confirmation, invoice items, sale stock movements, and print view
- shared-types, business-core, event-core, sync-core, tool-core, API, and web package boundaries
- PostgreSQL migration path and existing in-memory API test store
- CI, lint, typecheck, tests, build, and boundary checks

## CP7 Scope

In scope:

- local data cache contracts for business-scoped products, customers, suppliers, invoices, and inventory movement summaries
- durable sync queue model for supported offline mutations
- mutation envelope metadata: idempotency key, business ID, actor/session context, client timestamp, entity type, operation type, payload, and status
- deterministic replay path through existing API/business validation rather than client-trusted state
- queue states such as pending, processing, synced, failed, and conflict
- conflict representation for server rejection, stale local version, missing business/entity, insufficient stock, permission denial, and validation failure
- web shell integration for offline status, queued work count, failed/conflict states, and manual retry
- tests for queue ordering, idempotency, business scoping, offline reads, replay behavior, and CP5/CP6 conflict cases
- boundary checks that keep sync infrastructure separate from AI/runtime ownership

Out of scope:

- payment recording, debt status, M-Pesa, card, or cash reconciliation
- document import and OCR/parsing workflows
- marketplace behavior
- full Grogoniclaw runtime adapter
- llama.cpp or local model adapter
- production-grade distributed conflict resolution beyond deterministic conflict surfacing
- background push notification infrastructure
- multi-device real-time collaboration
- service worker cache tuning beyond what is required for local app usability
- full compliance/security hardening beyond preserving existing auth and business boundaries

## Target Flow

```text
Owner uses app with intermittent connectivity
  -> app reads cached business records for the active business
  -> supported local mutation is captured as a queued envelope
  -> UI shows queued work and avoids claiming server confirmation
  -> connectivity returns or owner retries
  -> queue replays mutations through API/business validators
  -> successful mutations become synced and refresh local cache
  -> rejected mutations become failed/conflict with actionable reason
```

## Business Rules

- Offline data must always be scoped to the active business.
- Queued mutations must not bypass server-side role checks or business validation.
- Queued invoice confirmation must not claim inventory mutation until replay succeeds.
- Queue replay must be idempotent for retried mutation envelopes.
- Conflicts must preserve enough local context for review instead of silently dropping work.
- Offline reads may show cached data, but the UI must distinguish cached/local state from confirmed server state.
- Sync queue records must not import AI runtime implementation.
- CP7 must preserve CP5 product/inventory invariants and CP6 invoice confirmation invariants.
- Payments and debt status must remain deferred to CP8.

## CP7 Exit Criteria

CP7 is marked passed because:

- [x] Local cache contracts exist for CP5 and CP6 business records.
- [x] Durable sync queue types and storage exist.
- [x] Supported offline mutation envelopes include idempotency and business scope metadata.
- [x] Queue replay routes mutations through existing server/API validation.
- [x] Queue states cover pending, processing, synced, failed, and conflict.
- [x] Conflict reasons are deterministic and visible to the owner-facing shell.
- [x] Offline status and queued work count are visible in the web shell.
- [x] Manual retry exists for failed/conflict queue items where appropriate.
- [x] Tests cover queue ordering, idempotency, business boundaries, and replay.
- [x] Tests cover CP5 product/inventory conflict behavior.
- [x] Tests cover CP6 invoice confirmation conflict behavior.
- [x] Existing CP1 through CP6 checks still pass.
- [ ] Checkpoint tag `checkpoint/cp7-offline-sync` is created. **Not actually done** — see the
      corrected Git Directory Note in `documentation/checkpoints/CHECKPOINT_LOG.md`.

**Follow-up (added after the original pass above):** conflicts now carry an explicit `category`
(`money` / `product_quantity` / `duplicate` / `generic`), and `product.create`, `customer.create`,
and `payment.record` replays are checked against existing business records and blocked as a
`duplicate` conflict rather than silently creating a second row. See the CP7 implementation note in
`documentation/README.md` and `tests/cp7-offline-sync.test.ts`.

## Rollback Instructions

Rollback target:

- Return to CP6 online invoice and inventory behavior.
- Preserve CP2 auth/business/session behavior.
- Preserve CP4 parser behavior.
- Preserve CP5 business core records and inventory movement behavior.
- Preserve CP6 invoice confirmation behavior.

Rollback trigger examples:

- offline mutations bypass server validation
- queued work mutates server-confirmed inventory before replay succeeds
- queue replay can duplicate confirmed mutations
- local data leaks across business boundaries
- conflict states silently drop owner work
- CP5 or CP6 invariants regress
- sync code imports AI/runtime implementation
- CP1 through CP6 checks regress

## Next Checkpoint

Next checkpoint:

- CP8: Payments and Debt Tracking

CP8 should build on CP6 invoices and CP7 sync semantics without changing CP7's rule that payments remain out of scope.
