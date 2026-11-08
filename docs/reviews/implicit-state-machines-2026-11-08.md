# Implicit state machines review — 2026-11-08

Prompt: see [recall.md](../../recall.md). Scope: `services/api`, `packages/*`, `apps/web/src`.

An implicit state machine is a lifecycle the code follows without writing it down: a `status`
column moved by scattered `update ... set status=` statements, or several React booleans whose
combinations stand for one screen stage. The cost is the same in every case: a person (or an agent)
must read every write site to learn which moves are legal, and nothing stops a new write from
adding an illegal one.

## Already explicit (the model to copy)

- **Fulfillment manifests** — `packages/business-core/src/domains/fulfillment-dispatch.ts`
  (`manifestTransitions` + `canTransitionManifest`), checked in `cp2/domains/fulfillment/dispatch.ts`.
- **Phone signup** — `apps/web/src/PhoneSignup.tsx` keeps one `stage: SignupStage`.

## Changed in this pass

### Daemon task queue (`grogoni_daemon_tasks`) — made explicit

`services/api/src/daemon/task-store.ts` moved tasks through `queued → running → completed |
failed | queued | cancelled` and `failed | cancelled → queued` across ~12 SQL updates, with the
status groups repeated as string literals. It was correct but undocumented.

- `packages/shared-types/src/daemon-lanes.ts` now declares `daemonTaskTransitions`,
  `activeDaemonTaskStatuses`, `terminalDaemonTaskStatuses`, `canTransitionDaemonTask` and
  `isActiveDaemonTaskStatus`, with the lifecycle diagram in its doc comment.
- `task-store.ts` re-exports `terminalDaemonTaskStatuses` from there (same name, same values) and
  uses `isActiveDaemonTaskStatus` in `retryOwned`. No SQL changed.
- `services/api/src/daemon/task-lifecycle.test.ts` reads every `set status='…'` update in the store
  and fails if its `where status …` guard allows an edge the table does not. Verified by mutation:
  letting `cancel` accept `completed` rows fails the test with `completed → cancelled`.

UX: unchanged behaviour. DX/AX: one table answers "can a task go from X to Y?", and a new SQL
update that breaks the lifecycle fails CI instead of shipping.

## Recommended next (not changed — each needs its own tests)

| # | Where | Implicit machine | Suggested shape |
|---|-------|------------------|-----------------|
| 1 | `services/api/src/edge-agent-turns.ts` (`agent_chat_turns`) | `pending → running → completed \| failed`, `failed → pending` (retry), lost leases → `failed`, ~18 SQL writes | Same treatment as the daemon queue: a transition table next to `AgentTurnStatus` and the same SQL-guard test. Lowest risk, highest value. |
| 2 | `apps/web/src/TrustedDeviceApproval.tsx` | `eligible`, `checked`, `approved`, `needsPasskey`, `dismissed`, `busy` booleans/nullables encode *ineligible → enter code → confirm browser → approved*, plus a *needs passkey* detour | One discriminated union `stage` (`hidden \| enter_code \| confirm \| needs_passkey \| approved`) via `useReducer`; impossible combos (e.g. `checked` and `approved` both set) disappear. Security-sensitive: add component tests first. |
| 3 | `apps/web/src/WhatsAppLinkedConnection.tsx` | `expanded`, `dismissed`, `consent`, `grantConsent`, `installed`, `busy`, `error`, `notice` alongside a server `connection.status` | Derive the view stage from `connection.status` + one local `step`; keep `busy`/`error` as the only transient flags. |
| 4 | `apps/web/src/OfflineRuntimeSettings.tsx` | Three parallel sub-flows (download/`confirming`/`progress`, OCR `ocrBusy`/`ocrProgress`, nearby `nearbyBusy`/`nearbyError`) each with its own `idle → busy → done \| error` | A small shared `useAsyncTask()` (status `idle \| running \| done \| error`) per sub-flow. |
| 5 | Terminal-status checks duplicated in the UI, e.g. `LogisticsSurface.tsx:176-188` (`completed \|\| cancelled`), `useSuppliersState.ts:351` (`failed \|\| FAILED`) | Each screen re-decides which statuses are final | Export `isTerminal…` helpers next to each status type in `@grogoni/shared-types` (as done for daemon tasks). |
| 6 | Status types in `packages/shared-types/src/index.ts` (`HandoffOrderStatus`, `NetworkConnectionStatus`, `ReceiptOCRJobStatus`, `InvoicePaymentStatus`, `LaunchIncidentStatus`, …) | Types list the states but not the edges | Add transition tables where the server mutates them; start with the ones a user can act on (handoff orders, network connections). |
