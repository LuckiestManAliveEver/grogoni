# CP25 Full Messaging Platform

CP25 upgrades Grogoni's chat-first workspace into a durable direct-messaging platform while keeping the
Grogoni business agent in the same inbox. The implementation is shared by web/PWA clients and the
server-authoritative conversation API.

## User experience

The messaging workspace provides:

- an inbox ordered by pinned state and recent activity
- direct conversations created from an exact Grogoni phone number or email address
- conversation search, unread badges, pin, eight-hour mute, and archive controls
- persisted text messages and up to 10 attachments per message
- image previews and downloadable document, video, audio, and other file attachments
- timestamps and pending, delivered, read, and failed states
- typing presence, reply context, forwarding, editing, soft deletion, and emoji reactions
- an offline outbox with client-generated idempotency keys and automatic reconnect retry
- voice dictation where the browser exposes the Web Speech API
- closed-browser Web Push notifications with notification-click routing back to the conversation
- end-to-end encrypted human direct-message bodies and attachments
- the existing Grogoni agent runtime as a first-class inbox participant

The responsive behavior is messenger-like: desktop and tablet layouts display an inbox beside the
active thread, while phones expose the inbox as an accessible slide-over panel. The composer and
thread remain usable at the certified viewport widths.

## Shared contracts

`@grogoni/shared-types` defines the interoperable message model:

- `ConversationInboxItem`
- `ConversationAttachment`
- `ConversationReaction`
- `ConversationMessageDeliveryStatus`
- `ConversationTypingSummary`
- `E2eeDeviceSummary`, `E2eePublicKey`, and per-device encrypted envelopes
- `PushSubscriptionSummary`
- participant-specific `lastReadAt`, `archivedAt`, `mutedUntil`, and `pinnedAt`
- message `deliveredAt`, `readAt`, `editedAt`, `deletedAt`, reply, forward, and reaction metadata

The conversation owner is not the only reader. Access is granted to every account participant, and
all message and conversation mutations verify that the active account is a participant. Direct
threads reject agent-authored messages so an account cannot impersonate the Grogoni agent in a human
conversation.

Agent-only threads are processed server-side as part of `POST /v1/messages`. The user message,
runtime turn, and agent reply share the message idempotency boundary, so foreground sends and
offline-outbox retries behave the same and cannot generate duplicate agent turns. Human direct
messages remain end-to-end encrypted and are not sent to the business agent implicitly.

## API

```http
GET   /v1/conversations?includeArchived=false
POST  /v1/conversations
GET   /v1/conversations/{conversationId}
PATCH /v1/conversations/{conversationId}
POST  /v1/conversations/{conversationId}/typing
POST  /v1/messages
PATCH /v1/conversations/{conversationId}/messages/{messageId}
POST  /v1/e2ee/devices
GET   /v1/e2ee/devices
DELETE /v1/e2ee/devices/{deviceId}
GET   /v1/conversations/{conversationId}/encryption-devices
GET   /v1/push/config
POST  /v1/push/subscriptions
DELETE /v1/push/subscriptions
```

Create a direct conversation:

```json
{
  "kind": "personal",
  "activeShopId": null,
  "recipient": "+254700000032",
  "title": "Delivery coordination"
}
```

The client creates an offline-safe encrypted direct message. The plaintext below is encrypted in the
browser and is never included in the API request:

```json
{
  "conversationId": "conversation-id",
  "clientMessageId": "android-unique-message-id",
  "content": {
    "type": "encrypted",
    "attachmentCount": 0,
    "iv": "base64url-content-iv",
    "ciphertext": "base64url-aes-gcm-ciphertext",
    "envelopes": [
      {
        "version": 1,
        "algorithm": "ECDH-P256-HKDF-SHA256-AES-256-GCM",
        "recipientDeviceId": "device-id",
        "ephemeralPublicKey": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
        "salt": "base64url-salt",
        "iv": "base64url-key-wrap-iv",
        "ciphertext": "base64url-wrapped-content-key"
      }
    ]
  },
  "replyToMessageId": null,
  "clientTimestamp": "2026-07-15T12:00:00.000Z"
}
```

Repeating a `clientMessageId` in one conversation returns the original message. This makes reconnect
replay safe. Message changes, typing state, and participant settings emit account realtime change
signals; clients refresh the authoritative thread after a signal and periodically while open.

## Attachments and storage

The current PWA encodes small attachments as data URLs inside the browser-encrypted payload. The API
stores only ciphertext plus the attachment count and allows no more than 10 attachments and 10 MB of
plaintext attachment data per message. This provides an offline-first transport without adding a
storage-provider dependency.

For high-volume production traffic, replace data URLs with signed HTTPS object-storage uploads while
retaining the same `ConversationAttachment` contract. Add malware scanning, media transcoding,
retention rules, and per-account storage quotas before raising the limit.

## Notifications

Users opt in from the inbox. The PWA creates a `PushSubscription`, stores it against the signed-in
account, and the API sends standards-based Web Push with VAPID authentication. This wakes the service
worker even when every Grogoni window is closed. Notifications intentionally contain no message text;
selecting one focuses or opens the app and routes to the conversation.

Generate one stable VAPID key pair per deployment and store the private key only in the API secret
manager:

```bash
pnpm --filter @grogoni/api exec web-push generate-vapid-keys --json
```

Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` together. `VAPID_SUBJECT` must
be a `mailto:` address or HTTPS URL. Push is reported as unavailable when those values are absent;
the API does not create ephemeral keys that would invalidate existing subscriptions.

## Security and privacy

- Conversation reads and writes require an authenticated participant.
- New recipients are resolved only by an exact normalized phone number or email address.
- Message edit and delete operations are restricted to the original sender.
- Deletion is a tombstone so synchronized clients do not resurrect content.
- Agent authorship is accepted only in account-to-agent threads.
- Mutations retain audit events and account-scoped realtime signals.
- Attachment URLs are limited to `data:` and HTTPS schemes.
- Human direct-message bodies and attachments use a random AES-256-GCM content key. P-256 ECDH,
  HKDF-SHA-256, and AES-GCM wrap that content key separately for every active participant device.
- Private device keys are non-exportable Web Crypto keys stored in IndexedDB. The API stores only
  public device keys, ciphertext, delivery metadata, and routing metadata.
- The API rejects plaintext in multi-account conversations and rejects stale or incomplete device
  envelope sets.

The end-to-end encryption claim applies only to human-to-human direct threads. Grogoni agent threads are
visibly labelled as agent-processed and remain readable by the server so the selected local or hosted
agent can respond and use tools. Conversation membership, sender, timestamps, delivery/read state,
reactions, reply/forward references, attachment count, and push endpoints remain server-visible
metadata. Public-key identity verification and key transparency are not yet provided, so the current
device directory relies on authenticated server key distribution; high-risk users do not yet have a
manual safety-number verification flow. Clearing browser site data destroys that device's private
key and makes its historical ciphertext unreadable unless another registered device still has an
envelope. Abuse controls, blocking/reporting, and legal retention policy remain deployment duties.

## Verification

- `tests/cp20-unified-session-conversations.test.ts` covers two-account visibility, plaintext
  rejection, ciphertext-only persistence, device envelope enforcement, privacy-safe Web Push,
  delivery/read state, typing, encrypted edit, reaction, and soft deletion.
- `e2e/responsive-accessibility.spec.ts` exercises the inbox/thread on phone and desktop viewports in
  addition to the full responsive and automated WCAG certification matrix.
- Repository typecheck, lint, build, unit tests, Playwright tests, and boundary checks are the release
  gate.
