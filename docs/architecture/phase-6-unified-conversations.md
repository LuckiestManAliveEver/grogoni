# Phase 6: unified conversations

Status: incremental implementation; the complete Phase 6 acceptance gate is **not yet met**.

## Existing infrastructure and compatibility

The messenger continues to use MessagingDomain's conversations, participants, messages,
delivery attempts, notifications and sync changes. PostgreSQL persists those records through the
existing snapshot collections. No second messaging store was introduced. Existing `personal`,
`storefront` and `order` kinds and conversation IDs remain compatible.

API views derive `conversationType` from durable conversation kind and account participants:
`personal` with multiple distinct accounts is DIRECT; other personal threads are DAEMON;
storefront/order threads are BUSINESS. These values are output metadata, never client permission
claims. Existing help and task threads retain their identities and relationships.

## Implemented behavior

- Both home and chat show the shared conversation list. Search works across all three types.
  Phone/email creation is available from home, alongside existing independent agent sessions.
- Each account gets a permanent daemon thread. Initialization reuses an eligible legacy personal
  thread, excludes direct/help/task threads, and persists the permanent marker. It cannot be
  archived or deleted. Startup selects it when no valid preferred conversation is supplied.
- Direct creation reuses the account pair in either direction. New direct conversations have no
  agent participant or inference binding. The existing encrypted message envelope and exact
  registered device checks remain enforced.
- New pair/business/daemon identities use deterministic server UUIDs; legacy IDs are reused.
  Reopening an occupied deterministic identity cannot overwrite a recycled conversation.
  Lookup and insertion are synchronous in the memory store. Existing Edge account/business locks
  and scoped persistence continue to coordinate database writes; multi-instance database race
  acceptance has not been run in this environment.
- Storefront creation reuses the customer's existing native business conversation. Business
  members can discover and reply in the shared inbox. Membership is checked on every access;
  previously materialized participant preferences cannot grant access after membership removal.
  Notifications and sync audiences include current business members and the customer.
- Business conversations use ordinary message submission by default. The frontend does not
  automatically invoke inference for a business inbox message. Explicit business runtime requests
  require server membership permissions and reject a mismatched business before storing a message.
- Phone Contacts exposes Message for discovered nodes. `network-node:` recipients resolve only
  through the caller's phonebook and registered user identity. Phone/email and node selection
  reuse the same direct conversation. Edge hydration includes the selected registered contact.
- Conversation-linked daemon tasks persist their origin, client message ID, scope and reminder
  metadata in the existing task payload. The Edge API validates ownership/type before enqueue and
  resolves the selected model through the existing native runtime registry. A task keeps the model
  selected at submission; subsequent submissions can resolve a changed binding without replacing
  the conversation or history. A different idle device model cannot execute/settle these tasks.
- Task results project on the server through the shared message writer. Migration 124 adds a
  delivery marker to the existing queue; terminal undelivered tasks are scanned independently of
  the latest-50 task window. Delivery survives browser closure and retries after persistence errors.
- Messages expose durable execution state and an owned retry control. Retry enforces ownership,
  capacity and stale-lease fencing. Permanent daemon model selection creates an account-specific
  binding, verifies the provider, and preserves conversation identity and history.
- Business agent execution requires an explicit owner toggle. It uses the authorized member's shop
  runtime, retaining replies in the customer conversation. Ordinary business messages remain human.

## Boundaries

Messaging owns history, delivery and presentation. The existing daemon queue owns background work;
its existing executor and provider abstraction perform inference. Business operations continue
through existing runtime authorization/approval paths. Conversation-linked background chat tasks
have no allowed business tools. OpenCode and configured provider integrations were not replaced.

## Verification

- Focused regression runs passed 74 tests across twelve suites; PostgreSQL queue and scoped Edge
  hydration tests passed 50 tests. Additional final messaging/model/delivery checks passed 12 tests.
- API and web TypeScript checks and production web build passed. The build retains existing large
  chunk warnings.
- Candidate cloud acceptance verified encrypted two-account exchange, pair reuse under concurrent
  requests, contact resolution, tenant isolation, business inbox replies, server-side result
  projection, owned task retry and real inference with both configured models in one daemon thread.
- The first candidate run exposed a business runtime account-binding rejection. The follow-up uses
  the authorized member's shop runtime and must pass live acceptance before promotion.
- Production evidence from October 22 is retained in
  [the original report](../testing/phase-6-production-2026-10-22.md). It describes the old deployment,
  not the corrected candidate. New production/browser evidence is recorded separately.

## Acceptance still in progress

Candidate retesting, production promotion, browser reload controls, real push receipt, and production
membership revocation must be verified before calling the complete Phase 6 gate passed. Model
unavailability is tested with isolated adapters; live global provider failure is not induced.
