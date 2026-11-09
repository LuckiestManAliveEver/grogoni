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

### Agent chat turns (`agent_chat_turns`) — made explicit

`services/api/src/edge-agent-turns.ts` moved turns between `pending`, `running`, `completed` and
`failed` across 7 SQL updates. Two edges were easy to miss without reading every statement:
`completed → pending` (a resend after the reply was deleted) and `pending | failed → completed`
(the reply was saved on the side before the turn finished).

- `edge-agent-turns.ts` now declares `agentTurnTransitions`, `unfinishedAgentTurnStatuses`,
  `canTransitionAgentTurn` and `isUnfinishedAgentTurn` next to `AgentTurnStatus`, with the lifecycle
  in its doc comment. No SQL changed.
- `edge-agent-turn-worker.ts` uses `isUnfinishedAgentTurn` where it decides to run recovery.
- `services/api/src/edge-agent-turn-lifecycle.test.ts` checks every `set status = '…'` statement's
  guard against the table (ignoring the `not exists` guard on earlier turns). Verified by mutation:
  letting `failAgentTurn` act on `completed` turns fails with `completed → failed`.

### Trusted-device approval screen — one step instead of two nullables

`apps/web/src/TrustedDeviceApproval.tsx` tracked where the owner was with two separate values,
`checked` (code matched, awaiting confirmation) and `approved`, and every branch had to clear the
right one. They are now one `step`: `enter_code | confirm | approved`, with the moves in a comment
above the type. A confirmation and an approval can no longer be on screen at once.

- Kept separate on purpose: `eligible` and `dismissed` (whether the prompt shows at all) and
  `needsPasskey` (it survives a decline today; folding it in would change that).
- Two tests added first and run against the old code: cancelling the screen lock returns to code
  entry without approving, and the prompt keeps an approval on screen until Done. All 12 tests in
  `tests/trusted-device-recovery-ui.test.tsx` pass before and after, as do the other 26 recovery
  suites run alongside.

## Recommended next (not changed — each needs its own tests)

| #   | Where                                                                                                                                                                            | Implicit machine                                                                                                                                                            | Suggested shape                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/web/src/WhatsAppLinkedConnection.tsx`                                                                                                                                      | `expanded`, `dismissed`, `consent`, `grantConsent`, `installed`, `busy`, `error`, `notice` alongside a server `connection.status`                                           | Derive the view stage from `connection.status` + one local `step`; keep `busy`/`error` as the only transient flags.               |
| 2   | `apps/web/src/OfflineRuntimeSettings.tsx`                                                                                                                                        | Three parallel sub-flows (download/`confirming`/`progress`, OCR `ocrBusy`/`ocrProgress`, nearby `nearbyBusy`/`nearbyError`) each with its own `idle → busy → done \| error` | A small shared `useAsyncTask()` (status `idle \| running \| done \| error`) per sub-flow.                                         |
| 3   | Terminal-status checks duplicated in the UI, e.g. `LogisticsSurface.tsx:176-188` (`completed \|\| cancelled`), `useSuppliersState.ts:351` (`failed \|\| FAILED`)                 | Each screen re-decides which statuses are final                                                                                                                             | Export `isTerminal…` helpers next to each status type in `@grogoni/shared-types` (as done for daemon tasks).                      |
| 4   | Status types in `packages/shared-types/src/index.ts` (`HandoffOrderStatus`, `NetworkConnectionStatus`, `ReceiptOCRJobStatus`, `InvoicePaymentStatus`, `LaunchIncidentStatus`, …) | Types list the states but not the edges                                                                                                                                     | Add transition tables where the server mutates them; start with the ones a user can act on (handoff orders, network connections). |
