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

### WhatsApp Linked Devices — one shared state type

The connector (`services/api/src/messaging/whatsapp-linked/connector.ts`) already funnels every move
through `transition()`, driven by socket events, so no edge table was added there. The web app,
though, stored the state as `string` and repeated `["PAIRING", "CONNECTING", "RECONNECTING"]` three
times.

- `packages/shared-types/src/whatsapp-linked-state.ts` names the states (`WhatsAppLinkedState`, now
  what the connector's `LinkedState` is) and the in-progress group (`isWhatsAppLinkInProgress`).
- `apps/web/src/WhatsAppLinkedConnection.tsx` types `Connection.state` with it and uses the helper.
  Its `labels` map is now typed over every state, so a new server state without a label fails the
  typecheck instead of showing a fallback.

### Logistics (fulfillment) — one transition table for server and screen

`business-core`'s `validateLogisticsStatusTransition` held the table, and `LogisticsSurface.tsx`
re-derived it by hand in four button conditions.

- `fulfillmentTransitions`, `canTransitionFulfillment` and `isFinalFulfillmentStatus` now live next
  to `FulfillmentStatus` in `@grogoni/shared-types`; the server validation uses them unchanged.
- The screen's buttons use `canChangeFulfillment`: the shared rule plus one written-down screen
  policy (a delivery is dispatched before it is completed, which the server would allow).
- `tests/fulfillment-transitions.test.ts` checks every status × method × next status: server
  validation equals the table, and every button is enabled exactly as before. The one difference
  is an unreachable record (a pickup that is out for delivery), where Back is now disabled because
  the server would refuse it anyway.

## Reviewed, no change

- `apps/web/src/OfflineRuntimeSettings.tsx`: each sub-flow (download, OCR, nearby, assistant) is an
  independent busy/error pair, cleared on start and set on finish. No impossible combination hides
  in them; folding them into a shared hook would churn ~10 sites for no behavioural gain.
- `apps/web/src/WhatsAppLinkedConnection.tsx` local flags (`expanded`, `dismissed`, consents): plain
  UI toggles, not a lifecycle.
- Small three-state flows (`NetworkConnectionStatus` in `cp2/domains/network/connections.ts`,
  commerce-source requests): each move is guarded inline where it happens; a separate table would
  only duplicate those guards.
