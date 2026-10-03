# Messaging PR 1: durable state and idempotency

## Scope

This is the first stage of the consent-based, offline-first messaging plan. It adds the server-side state contract required by a future durable client outbox:

- caller-stable, conversation-scoped idempotency keys;
- queued, sent, delivered, read, retry, and failure metadata;
- selected versus actual channel metadata;
- append-only delivery-attempt records;
- additive PostgreSQL migration and scoped rollback;
- account-scoped delivery-attempt API and persistence.

It does not add a transport adapter, Android SMS access, provider connection, history import, or a new client outbox. A channel other than `grogoni` is rejected until a real, configured official adapter exists.

## Repository diagnosis before implementation

- The frontend is a React/Vite PWA in `apps/web`. There is no native Android, Capacitor, TWA, React Native, or Flutter application. Android-related files only verify release identity and Play legal readiness.
- Conversation data exists in PostgreSQL relational tables and in the CP2 normalized JSON persistence layer. Messages were unique by `(conversation_id, client_message_id)`.
- The composer already creates stable client message IDs, optimistically renders, encrypts direct messages, and posts to `POST /v1/messages`. The server scopes conversations to accounts, deduplicates client IDs, records audit/sync events, and queues push/email notifications.
- Realtime updates use WebSocket catch-up with polling fallback. The PWA retries a localStorage outbox on the online event and a foreground interval.
- IndexedDB stores sync mutations and E2EE private keys. Message payloads still use localStorage. The service worker caches the shell and handles Web Push, but has no Background Sync worker.
- Existing message states were `pending`, `sent`, `delivered`, `read`, and `failed`. Draft, queued, sending, and retrying were absent.
- There is Web Push/VAPID and email notification delivery, but no common transport/provider adapter interface and no SSE.
- Direct messages use ECDH P-256, HKDF-SHA-256, and AES-256-GCM envelopes. Provider credentials are not present in browser code; server-side OAuth tokens use encrypted storage.
- Conversation participants are account, shop, or agent identities. Social identity linking exists for authentication/profile data, but there are no external message-thread mappings or import provenance records.
- A PWA cannot become the Android default SMS handler or read the SMS provider. Private Google Messages/RCS history has no supported general import API. RCS for Business is not a personal-history API.

## Data and API contract

`ConversationMessageSummary` now includes:

- `idempotencyKey`;
- `queuedAt`, `sentAt`, `deliveredAt`, and `readAt`;
- `failureCode`, `retryCount`, and `nextRetryAt`;
- `selectedChannel`, `actualChannel`, and `providerMessageId`;
- `importedSource`, `importedExternalId`, and `consentRecordId`.

`POST /v1/messages` accepts `idempotencyKey`, `queuedAt`, and `selectedChannel`. Repeating a request with the same conversation and idempotency key returns the original message even if a later client message ID differs. The only currently available channel is `grogoni`.

An agent-only conversation can include an `agent` processing request with its business ID, message,
optional runtime session, and agent profile. The API persists the user message, creates the runtime
turn, and persists the agent reply as one server-side operation. Replaying the same message returns
the existing reply without running the agent again, so messages delivered later by the offline
outbox are processed too. Human direct messages do not request this processing and the API rejects
attempts to attach it to an encrypted human conversation.

`GET /v1/conversations/:conversationId/messages/:messageId/delivery-attempts` returns attempt metadata only after account ownership is verified. The record deliberately excludes message bodies, access tokens, and provider credentials.

Legacy snapshots are hydrated with deterministic Grogoni idempotency keys and safe state defaults. New snapshots persist delivery attempts in `cp2_message_delivery_attempts`.

## Threat model

- Cross-tenant access: every attempt has an `accountId`; reads first resolve the conversation inside the current account and return 404 for other tenants.
- Replay/duplicate send: idempotency is scoped to a conversation in memory and by a unique PostgreSQL index.
- Secret leakage: attempts and audit payloads contain identifiers, channel, timing, and normalized result only. They do not contain message content or credentials.
- Fake provider availability: non-Grogoni channels are enumerated for durable schema compatibility but rejected by runtime capability enforcement.
- Import confusion: source and external IDs are reserved and uniquely indexed when present; no import path is enabled in this stage.
- Destructive rollout: the migration is additive and backfills existing rows before making idempotency non-null.

## Rollout and rollback

1. Back up PostgreSQL using the existing database operations procedure.
2. Deploy migration `031_message_delivery_state.sql`.
3. Deploy API and web artifacts from the same commit.
4. Confirm a Grogoni send returns state metadata and exactly one attempt.
5. Confirm repeating the idempotency key returns the same message ID.
6. Monitor `message_channel_unavailable`, idempotency validation errors, and API error rate.

No new environment variable or credential is required. Roll back the application first, then run `031_message_delivery_state.down.sql` only if the new metadata and attempt history may be discarded. Take a backup before the down migration because it removes those fields.

## Manual verification

- Send a Grogoni message with a stable idempotency key and queued timestamp.
- Retry it with a different client message ID and the same idempotency key.
- Verify both responses use the same server message ID.
- Read delivery attempts as the owner and verify one successful Grogoni attempt.
- Verify another account receives 404.
- Select SMS and verify the server reports the channel as unavailable instead of pretending to send.
- Restart from a persisted snapshot and verify message metadata and attempts remain.

## Remaining staged work

1. Move the PWA message outbox from localStorage to encrypted IndexedDB; persist before send; add authenticated connectivity probing, ordered retry/backoff, cancel/manual retry, attachment resume, app-resume and service-worker sync.
2. Add a transport interface and migrate Grogoni delivery behind it.
3. Introduce a separately approved Kotlin/Compose Android companion with secure auth and encrypted local storage.
4. Implement the complete Android default-SMS role only after explicit product and Play-policy review. Restricted SMS permissions must not be requested during generic onboarding.
5. Add separate SMS import consent, local-only behavior, resumable deduplication, revocation, and deletion.
6. Add deliberate, charge-disclosed SMS fallback with race protection.
7. Add only official, credential-validated provider adapters and verified webhooks.
8. Add an honest import-capability registry and connected-channel UI.
9. Add consent records, external mappings, agent-access controls defaulted to no access, audit coverage, retention, export, and deletion.

Provider credentials, OAuth apps, webhook secrets, business verification, opt-in/template approvals, and geographic eligibility will be required per official provider. Private Google Messages RCS import remains unsupported. Any Android SMS release will require default-handler functionality, prominent disclosure, minimum permissions, a privacy policy, Data safety declarations, restricted-permission eligibility, and Play review.
