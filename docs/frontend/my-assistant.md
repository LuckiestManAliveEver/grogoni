# My Assistant

"My Assistant" is the user-facing name of each account's permanent daemon conversation. It used to
be called "Your daemon". The internal type, routes and table names still say "daemon". Only the
text people see changed.

Only `isPermanentDaemon: true` identifies it. `conversationType: "DAEMON"` is broader: the server
gives it to every personal chat with one person in it, so help topics and agent sessions the owner
started ("Restock maize") are DAEMON too. Those keep their own titles, can still be renamed, and
cannot see or change My Assistant's agent or model. Their inbox badge reads `ASSISTANT` (the kind
of chat), not their title.

## Where people see it

| Surface                                    | What it shows                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbox pinned row (`ConversationListPanel`) | "My Assistant", badge `ASSISTANT`, a **Details** action that is always visible (no hover needed)                                                                                                                                                                                                                           |
| Thread header (`ChatSurface`)              | Title "My Assistant". Clicking the title or **Details** opens the details panel (no rename)                                                                                                                                                                                                                                |
| Replies in the thread                      | Author label "My Assistant" (plain text, not the shop agent's profile link), and the typing indicator                                                                                                                                                                                                                      |
| Message notifications                      | Title "My Assistant" (`chat-message-plumbing.ts` `conversationTitle`)                                                                                                                                                                                                                                                      |
| Background task status                     | "My Assistant: running" in My Assistant, "Background task: running" in other agent chats; toasts say "Background task failed. You can retry it here." A failed task posts "My Assistant could not finish this task. You can retry it here." (other chats: "This background task could not finish. You can retry it here.") |

`apps/web/src/conversation-title.ts` is the one place that maps a conversation to its display title,
so a stored title of "Your daemon" (or any other) still shows as "My Assistant". The name itself
is `permanentDaemonDisplayName` in `packages/shared-types`.

An empty assistant chat renders as the home screen ("Karibu. What do you need?") with no thread
header, so the inbox **Details** action is the entry point that always works.

## The details panel

`apps/web/src/AssistantDetailsPanel.tsx` shows:

- **ID**: the conversation ID (selectable, for support requests).
- **Agent**: drop-down of agent engines. Today: Grogoni agent (`grogoni`) and Pi agent (`pi`).
  Only engines registered in this deployment's agent runtime registry are listed.
- **Model**: drop-down of models with a configured backend (`available` and
  `runtimeAvailability.backend === "configured"`).

Changing either drop-down saves immediately and keeps the other value. Two tabs switching at
once do not undo each other: on Edge every write for an account holds the per-account lock, so the
second switch starts from the first one's result; on the Node API the half a request did not set is
re-read after the model health check. On failure the previous choice stays selected and the error
is shown. When the current model is unavailable the agent drop-down is disabled and described by
"Choose a model first" (or "No models are configured on this server yet." when none are), and the "Not set" placeholder cannot be picked. A selected model the
server no longer serves is reported as unavailable (`model_unavailable`). Status changes are
announced through one live region that stays mounted. The drop-downs stay focusable while a switch
is saved (marked `aria-busy` and showing the choice being saved; further input is ignored until it
finishes), the panel closes when another chat is opened or the user signs out, and a failed load
offers "Try again".

## API

`GET /v1/conversations/:conversationId/model` returns `ConversationRuntimeSelection`:

```json
{
  "conversationId": "4b8e2f10-…",
  "selectedAgentId": "grogoni",
  "agents": [
    { "id": "grogoni", "label": "Grogoni agent" },
    { "id": "pi", "label": "Pi agent" }
  ],
  "selectedModelId": "gpt-6-luna",
  "models": [{ "id": "gpt-6-luna", "label": "…" }],
  "available": true,
  "errorCode": null
}
```

`PUT` the same path with `{ "agentId"?: string, "modelId"?: string }`, at least one. It answers
with the new selection. Errors:

| Code                          | When                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `400 runtime_selection_empty` | Neither field sent                                                                                                                                                                                           |
| `400 agent_unavailable`       | Engine named in the request is not registered in this deployment. Without `agentId`, an engine that is no longer registered is replaced by the first registered one, so picking a working model always works |
| `400 model_unavailable`       | Model not configured, or no current model when switching agent only                                                                                                                                          |
| `503 <provider code>`         | The model's health check failed; nothing changes                                                                                                                                                             |
| `404 conversation_not_found`  | Not your My Assistant conversation                                                                                                                                                                           |

Both routes only accept the caller's own permanent daemon conversation (`isPermanentDaemon`). Any
other conversation answers 404, because every conversation selection writes the one account agent
record `account-<accountId>-agent`.

## How the choice is applied

- Chat turns: the conversation's runtime binding points at the account agent
  `account-<accountId>-agent`, whose `configuration.runtimeAdapterId` is the chosen engine
  (`NativeRuntimeBindingStore.selectConversationModel`). Before this change that agent was always
  a copy of the default Grogoni engine.
- Background tasks: when a task is created, `authorizeConversation` uses
  `daemonConversationRuntime` (`services/api/src/daemon/conversation-runtime.ts`) on the hydrated
  store. When it is claimed and right before the server runs it, `loadConversationTaskRuntime` asks
  the database through `grogoni_conversation_task_runtime(owner, conversation)`, a `SECURITY
DEFINER` function from migration 132, so the least-privilege native daemon role can ask without
  reading users or conversations (`infra/db/roles/grogoni_daemon_role.sql` grants `execute`). It
  answers only for the owner's My Assistant conversation and only for an explicit selection whose binding, agent
  and model are all active; every join is by primary key or index. The lookup runs in a short
  read-only transaction with a 2 second `statement_timeout`, and the lane also stops waiting after
  2 seconds (`withLookupDeadline`), so a slow lookup costs at most 2 seconds of the task's timeout; it uses one pooled connection for at most that 2 second statement timeout and never holds the store lock or a caller's transaction. A runtime the server cannot run is ignored (the task keeps its own). The Edge lane
  saves the refreshed payload under the unexpired lease; a failed or fenced save never fails the
  task. The standalone Node daemon applies the same rule through `executeOnConversationRuntime` for each run (it does not save the refreshed payload; the next run reads it again)
  and logs `conversation_runtime_unavailable` (`errorCode`: the Postgres code, or `LOOKUP_FAILED`; the Edge lane reports the same) when the lookup fails.
  Before this change the engine was always `"grogoni"` and the model was fixed at creation.
- Retry: `POST /v1/daemon/tasks/:id/retry` re-authorizes the conversation and rewrites the task's
  `modelId` and `agentAdapterId`, so a retry after picking a working model runs that model. A
  runtime this server cannot run is refused (503) and the task stays failed.
- Device lane: a conversation task runs on the user's device only when the device model is the
  chosen model and the engine is the default `grogoni` (the device does plain generation). Pi tasks
  always run on the server.
- Shopping requests typed in My Assistant (`POST /buy/assistant` with `conversationId`) use its
  selected model. The shopping tool loop has its own harness, so the agent engine does not apply
  there. Any other chat, or an unresolvable runtime, uses the platform default model.
- Shop activation: activating a shop model, or provisioning a default runtime for a turn, rebinds
  the owner's chats with no active shop, but never a My Assistant whose agent and model were chosen
  in its details while that selection is active (`keepsSelectedRuntime` in `services/api/src/cp2/store.ts`). A My Assistant that
  never had a choice follows those defaults as before.
- Persistence: `selectConversationModel` is a mutating method of the Postgres store, so a switch is
  saved when it is made (before this it reached the database only with a later unrelated write).
- Every switch records the audit event `conversation.runtime_selected` with the previous and new
  agent and model.

## Migration

`infra/db/migrations/132_my_assistant_rename.sql`:

- renames stored rows that still carry the old default ("Your daemon") on `cp2_conversations`
  (permanent daemon only) and on the account agents in `cp2_native_runtime_agents`. Owner-chosen
  titles are left alone.
- adds the `grogoni_conversation_task_runtime` lookup function. It is `SECURITY DEFINER`, so its
  `search_path` is pinned to the migration's schema with `pg_temp` last (a caller's temporary
  tables can never stand in for `users` or the cp2 tables), and execute is revoked from `PUBLIC`
  and, on Supabase, from `anon` and `authenticated`.
- detaches any other conversation still bound to a `conversation-selection` runtime (possible
  only through the old API, which accepted any one-person agent chat), on accounts whose permanent
  conversation is already flagged (the flag is set lazily; an unflagged account may still promote
  that chat, selection included). Those bindings all run the
  shared account agent, so they would otherwise follow My Assistant's engine. The old id is kept as
  `detachedRuntimeBindingId`.

The detached chats' old `conversation-selection` binding rows stay in place (unused) so the rollback
can re-attach them. On accounts whose permanent conversation is not flagged yet, a chat still bound to a selection keeps following the shared account agent in chat turns until the flag is set, as the store's own resolver does; its background tasks are not re-read (the lookup answers only for My Assistant).

Rollback: `infra/db/rollbacks/132_my_assistant_rename.down.sql` restores the names and bindings and
drops the function.

A new account shows the platform default (Grogoni agent, GPT-6 Luna, from migration 111) as what it
runs on.

## Tests and eval

| Lane    | Command                                                                                                      | Covers                                                                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate    | `pnpm vitest run tests/my-assistant-runtime-selection.test.ts`                                               | Store and HTTP: list, switch agent and model independently, persistence across hydrate, rejections, audit, other DAEMON chats and help topics rejected, shopping model                                                                                                                        |
| Gate    | `pnpm vitest run tests/daemon-browser-lane.test.ts`                                                          | Device lane sends Pi or other-model conversation tasks to the server                                                                                                                                                                                                                          |
| Gate    | `pnpm vitest run tests/my-assistant-details-panel.test.tsx`                                                  | Panel rendering, switching, error keeps previous choice, title helpers                                                                                                                                                                                                                        |
| Gate    | `CP2_POSTGRES_TEST_DATABASE_URL=<migrated db> pnpm vitest run tests/my-assistant-task-runtime-query.test.ts` | Real Postgres store: a switch is saved at once and survives a fresh instance; the task lookup matches it, is owner-only, reaches users by primary key (EXPLAIN), is cancelled by the database at its deadline, and works under the native daemon role's real grants (which cannot read users) |
| Gate    | `pnpm vitest run services/api/src/daemon/conversation-runtime.test.ts`                                       | Standalone daemon wrapper: follows a later switch, keeps its runtime on null, refusal or lookup failure                                                                                                                                                                                       |
| Gate    | `CP2_POSTGRES_TEST_DATABASE_URL=<migrated db> pnpm vitest run tests/my-assistant-rename-migration.test.ts`   | Migration and rollback on the real migrated tables, inside a rolled-back transaction                                                                                                                                                                                                          |
| Gate    | `CP2_POSTGRES_TEST_DATABASE_URL=… pnpm vitest run services/api/src/daemon/edge-lane.test.ts`                 | Background task payload carries the conversation's engine; retry re-reads it                                                                                                                                                                                                                  |
| Browser | `pnpm exec playwright test e2e/messenger-unified-inbox.spec.ts`                                              | Inbox (with help topic and named session ahead of it) and header entry points at 1280px and 390px                                                                                                                                                                                             |
| Eval    | `pnpm eval:my-assistant-runtime`                                                                             | Paid. Each offered engine is selected, health-checked and answers a checkable question. Threshold 100%                                                                                                                                                                                        |

The eval writes `/tmp/my-assistant-runtime/eval/report.json` (exit 0 pass, 1 fail, 2 not run).
