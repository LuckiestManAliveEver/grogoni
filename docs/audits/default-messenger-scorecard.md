# Default messenger scorecard

How complete Grogoni is as the default contact book and messenger for people, businesses and
agents. `pnpm score:messenger` calculates the score from this file (`scripts/score-messenger.mjs`);
nobody types the percentage by hand.

Rules the scorer enforces:

- `## <area> (weight N)` starts an area. Weights add up to 100.
- `- [x]` done: the item must cite at least one `evidence:` path that exists in the repository.
- `- [ ]` not done. `- [-]` excluded by decision: it must give a `reason:` and does not count.
- An area scores done / (done + not done). The total is the weighted sum of the area scores.

Tick an item only in the same commit that adds its evidence.

## Human messaging (weight 30)

- [x] One-to-one conversations started from a Grogoni phone number or email. evidence: tests/instant-messaging-api.test.ts, tests/direct-messaging-postgres.test.ts
- [x] End-to-end encrypted message bodies and attachments between people. evidence: tests/e2ee-messaging.test.ts, tests/phone-email-e2ee-messaging.test.ts
- [x] Attachments with previews and downloads. evidence: tests/conversation-attachment-card.test.tsx
- [x] Pending, delivered, read and failed states. evidence: tests/message-delivered-on-sync.test.ts, tests/message-delivery-state-migration.test.ts
- [x] Offline outbox with idempotent automatic retry. evidence: tests/messaging-outbox.test.ts, tests/outbox-auto-retry.test.tsx
- [x] Web Push notifications with the browser closed. evidence: tests/service-worker-push.test.ts
- [x] Typing presence. evidence: tests/cp20-unified-session-conversations.test.ts
- [x] Reactions. evidence: tests/optimistic-message-reactions.test.ts
- [x] Reply versions and regeneration. evidence: tests/conversation-reply-versions.test.ts
- [x] Group discussions: add people or agents to a personal chat. evidence: tests/cp20-unified-session-conversations.test.ts
- [x] Realtime event stream and sync. evidence: tests/message-event-stream.test.ts, tests/cp22-realtime-sync.test.ts
- [x] Recycle bin and restore. evidence: tests/conversation-recycle-bin.test.ts
- [x] Contact privacy and blocking. evidence: tests/messenger-contact-privacy.test.ts
- [x] A send stopped before it leaves the device gives the draft back. evidence: tests/send-stopped-returns-draft.test.tsx
- [ ] Kept sends count as on-device model history (instant-messaging-remaining §5).
- [ ] A blocked sync database retries once the blocking tab closes (instant-messaging-remaining §5).
- [ ] Outbox load pass reruns after a late device-database open (instant-messaging-remaining §5).
- [ ] Another open tab's outbox entries are left to that tab (instant-messaging-remaining §5).
- [ ] Voice notes: record and send audio in a conversation.
- [ ] One-to-one voice calls.
- [ ] One-to-one video calls.

## Contact book (weight 20)

- [x] Phone contact sync, including vCard import. evidence: tests/phonebook-sync.test.ts
- [x] Directory of which phone contacts are on Grogoni. evidence: tests/phonebook-directory.test.ts
- [x] Google contacts import. evidence: tests/google-contacts-network.test.ts
- [x] Contact network graph with consent and agent-mediated second-degree routes. evidence: tests/network-sync-graph.test.ts
- [x] Connections and invites. evidence: tests/network-invite-delivery.test.ts, tests/network-connections-postgres.test.ts
- [x] One canonical card per contact across identities. evidence: tests/canonical-contacts-card.test.ts
- [x] Grogoni ID lookup. evidence: tests/grogoni-id-routes.test.ts
- [x] Open a conversation from a contact. evidence: tests/network-contact-conversations.test.ts
- [ ] Find a business by name, category or place (shop directory).
- [ ] Android contact picker permission verified on the API 30 emulator.

## Business messaging (weight 20)

- [x] Storefront conversations from a public shop page. evidence: tests/public-storefront-panel.test.tsx, tests/storefront-interaction-contracts.test.ts
- [ ] Order conversations covered by a test (the store accepts `kind: "order"`; no test exercises it).
- [x] The shop's agent answers buyers. evidence: tests/buyer-shopping-assistant.test.ts
- [x] Human messaging keeps working when the agent is down. evidence: tests/agent-outage-human-messaging.test.ts
- [x] External channels: WhatsApp linked device, Telegram, SMS gateway. evidence: tests/external-messaging-api.test.ts, tests/omnichannel-messaging-gateway.test.ts
- [x] Catalogue sharing. evidence: tests/catalogue-share-settings-card.test.tsx
- [x] Customers and invoices. evidence: tests/customer-management-card.test.ts, tests/invoice-management-card.test.ts
- [x] A customer's inbox listing or thread open on Edge marks a shop reply delivered. evidence: tests/edge-delivered-postgres.test.ts, tests/edge-delivering-read-scope.test.ts
- [ ] Receipt-to-commerce engine accepted (receipt-to-commerce-checklist-2026-11-16).
- [ ] Opt-in broadcast from a shop to its customers.

## Agents as participants (weight 15)

- [x] The agent is a first-class inbox participant. evidence: tests/cp20-unified-session-conversations.test.ts
- [x] Agent turns run asynchronously on Edge. evidence: tests/edge-async-agent-turns.test.ts
- [x] MCP tool gateway, including agent-to-agent secure channels. evidence: tests/cp23-mcp-tool-gateway.test.ts
- [x] Per-agent sessions with isolated context. evidence: tests/agent-session-context-isolation.test.ts
- [x] Versioned business runtime with rollback. evidence: tests/agent-business-runtime.test.ts
- [x] Owner corrections are kept and applied. evidence: tests/agent-owner-correction-retention.test.ts
- [x] Agent skills. evidence: tests/agent-skills.test.ts
- [ ] Periodic eval: agent replies stay correct after the send/turn split (instant-messaging-checklist).
- [ ] Send and reply timing marks (`message.send.ack_ms`, `agent.turn.reply_ms`) with a server log line (instant-messaging-checklist).

## Default app on phones (weight 15)

- [x] Android release identity and app links. evidence: tests/cp26-android-release-identity.test.ts
- [x] Native SMS/MMS channel. evidence: tests/android-native-sms-channel.test.ts
- [x] Account deletion purges our data and Brevo's, on a schedule. evidence: tests/cp27-account-purge.test.ts, tests/scheduled-maintenance-workflow.test.ts
- [x] Web app and API deploy from one build. evidence: tests/production-build-pipeline.test.ts
- [ ] Play legal approvals pass `verify-play-legal-readiness.mjs --require-approved`.
- [ ] Android release manifest passes `verify-android-release-manifest.mjs --require-release`.
- [ ] Message acknowledgement measured from a Kenyan network.
- [-] Physical low-end Android device on a Kenyan carrier. reason: Julien chose to skip it on 2026-11-22.
