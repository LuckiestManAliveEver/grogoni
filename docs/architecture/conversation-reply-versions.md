# Conversation reply versions

Regenerating an agent reply keeps every earlier answer as a version of the same message. The
person can move between versions with a previous / next control. No version can repeat, start or
queue a business action.

Outcome this moves: a merchant who gets a weak answer no longer retypes the question (a second
message, a second turn that is free to act). Measured by the `agent_reply_regenerated` and
`agent_reply_regeneration_refused` API log events, the `message.regenerated` audit event, and
`pnpm eval:reply-regeneration`.

## What it is not

It is not a conversation tree. The DeepSeek Chat Demo (the reference for the sibling-version idea,
see `docs/audits/chat-modernization-audit-2026-11-13.md`) keeps a parent-linked tree on one device;
switching a version there hides every later message. In Grogoni later messages can be orders,
approvals and receipts, so nothing is ever hidden, reordered or rewritten. Versions exist only
inside one agent reply.

## Data model

Two optional fields on `ConversationMessageSummary` (`packages/shared-types/src/index.ts`), with the
rules in `packages/shared-types/src/reply-versions.ts`:

| Field             | Set by      | Meaning                                                            |
| ----------------- | ----------- | ------------------------------------------------------------------ |
| `agentTurnEffect` | server only | What the turn behind the reply did: `none`, `read` or `action`.    |
| `replyVersions`   | server only | `{ selected, versions: [{ id, text, createdAt }] }`, oldest first. |

`content.text` always equals the selected version. A client that knows nothing about versions sees
one ordinary reply; sync carries one entity; the history given to the model contains the selected
answer only. Messages are stored as JSON records (`cp2_conversation_messages`), so there is no
migration.

Limit: 5 versions per reply (`maxReplyVersions`). Versions are appended, never edited or removed.

## API

Both routes are in `services/api/src/cp2/domains/messaging/routes.ts` and are served unchanged by
the Edge API.

`POST /v1/conversations/:conversationId/messages/:messageId/regenerate`
body `{ businessId, versionId }` answers the updated message.

- `versionId` is the retry key: 8 to 64 characters of `A-Z a-z 0-9 _ -`. Sending the same id again
  answers with the version already written and calls no model.
- `409 reply_not_regenerable` with `details.reason`, `409 reply_version_limit`,
  `409 regeneration_would_act`, `403 reply_regeneration_forbidden`, `400 reply_version_id_invalid`.

`PUT /v1/conversations/:conversationId/messages/:messageId/reply-version`
body `{ index }` selects a version and answers the updated message.

## Why a regenerate cannot act

Three checks contribute to this boundary. The runtime guard is the enforcement point before tool execution; the result check cannot undo a tool that already acted.

1. **Eligibility** (`replyRegenerationBlock`). Only a plain-text agent reply whose turn is recorded
   as `none` or `read` qualifies. Confirmations, cards, replies with files, business tasks, and any
   reply written before `agentTurnEffect` existed are refused. The question must be the caller's
   own plain-text message, without files, not deleted, and not a `/` command.
2. **Runtime guard** (`executeRuntimeTurn`, `regeneration: true`, with
   `services/api/src/cp2/domains/agent-runtime/regeneration.ts`). The turn may answer in words or run a
   low-risk read-only tool outside the computer runtime (`regenerationAllowsTool`). A proposal for any other tool throws `regeneration_would_act` before the plan,
   the approval token and the execution exist. Confirmation tokens, planned steps, portable
   skills and channel delegations are refused at the start of the turn; a hashtag command reaches
   the same tool check as any other proposal. The flag is
   server-only: no HTTP or MCP parser reads it.
3. **Result check** (`regenerateAgentReply`). The finished turn's effect is computed again from its
   plan; `action` or a delivered file is refused and nothing is written.

The skill, inventory-task and attachment paths of a first answer are never entered.

`agentTurnEffect` is stamped only on replies the server's own runtime wrote. A request body cannot
set it: `POST /v1/messages` ignores the field, and client-posted agent messages carry none, so they
are never eligible.

## Client

Everything specific to the feature is in `apps/web/src/features/reply-versions/`.

- `apps/web/src/chat-message-plumbing.ts` maps the two fields to `ChatMessage.regenerable` and
  `ChatMessage.replyVersions`.
- `useReplyVersions.ts`: regenerate, stop, select. One regenerate at a time. `ChatSurface.tsx`
  calls it with the open thread's ids from `useChatInboxState` (`replyVersionDeps`).
- `ReplyVersionSwitcher.tsx`: "Regenerate" in the message's More menu; a status line with Stop
  while the version is written; the previous / next control under a reply with more than one
  version.
- `reply-version-requests.ts`: a request whose answer never arrived (stop, timeout, dropped
  connection, 5xx, turn still running) keeps its `versionId`, in memory and in session storage, so
  asking again after a remount or a reload cannot write the same answer twice. Pending requests are aborted when the conversation or business changes or the surface unmounts; late results cannot update the new context. Regenerate is
  offered only to the person who asked, in their own shop's conversation (`canOfferRegenerate`);
  other participants see the version position without controls.

Stop ends the wait only. The server may still finish and write the version; it then appears on the
next thread refresh, and a repeated Regenerate answers with it.

## Where it would break

- **A tool wrongly marked `readOnly: true`** in `packages/tool-core` passes checks 2 and 3. The
  registry flag is the single source of truth for "changes nothing".
- **A refused regenerate is not free of writes**: the turn has already opened a runtime session
  and logged its start events. It records no turn, plan or approval.
- **Question edited or deleted while the model answers**: refused (`question_changed`,
  `question_deleted`) and no version is written. The turn itself already ran, so its runtime turn
  record (and a read-only tool call, if it made one) stays.
- **A regenerate holds the conversation's turn lock** until the model answers, Stop included: a
  message sent meanwhile is stored and gets `409 HANDOFF_IN_PROGRESS`; the outbox resends it.
- **Feedback** (Correct / Incorrect) is stored per message, not per version.
- **Two regenerates racing on different devices**: the conversation's turn lock refuses the second with
  `409 HANDOFF_IN_PROGRESS`. The client keeps its retry key on that answer.
- **Question edited after the first answer**: the next version answers the edited text. Versions
  do not record which wording they answered.
- **Edge API**: a regenerate runs inside its request (model call outside the locks, then replay),
  not on the agent-turn queue. A model slower than the Edge request limit fails the request; the
  retry key makes the retry safe.
- **Agent evaluation events**: a regenerated turn records evaluation events like any turn, so
  per-turn quality rates count it.

## Tests and eval

- Gate: `tests/conversation-reply-versions.test.ts` (rules, routes, isolation, limits, history),
  `tests/reply-version-client.test.tsx` (switcher, retry keys, mapping, surface wiring).
- Periodic, paid: `pnpm eval:reply-regeneration` drives the real routes with the live default model.
  Safety threshold 1 (canonical business record contents remain unchanged, excluding explicitly named turn bookkeeping and the target reply’s expected version fields),
  usefulness threshold 0.8. Report: `/tmp/reply-versions/eval/report.json`.
