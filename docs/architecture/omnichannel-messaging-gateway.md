# Omnichannel messaging gateway

## Audit result

Grogoni already had a useful canonical conversation and message model, delivery attempts,
provider-update receipts, a unified inbox, and a confirmation-aware agent runtime. The missing
boundary was a real channel gateway: provider identities were not attached to CRM customers,
Telegram had no authenticated webhook or send adapter, external sends stopped at a queued
placeholder, and the composer could not select a connected transport.

The implementation reuses those foundations. It does not introduce a second inbox or a second
message store.

| Concern                | Canonical implementation                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Customer               | `CustomerSummary`, optionally linked to one Grogoni account                              |
| Provider identity      | `PlatformIdentitySummary`, scoped by business and linked to one customer                 |
| Conversation transport | `ConversationChannelSummary`                                                             |
| Message                | `ConversationMessageSummary`, including provider, direction, lifecycle, and external IDs |
| Provider deduplication | `ProviderUpdateReceiptSummary`                                                           |
| Outbound idempotency   | conversation-scoped message `idempotencyKey`                                             |
| Delivery observability | `MessageDeliveryAttemptSummary` and structured audit events                              |
| Agent action           | confirmation-gated `messaging.send` runtime tool                                         |

## Identity rules

- An external provider identifier is never treated as a Grogoni account identifier.
- A new storefront or provider contact creates one guest customer when no canonical customer was
  selected.
- Additional channel identities selected for that customer reuse its canonical conversation.
- A provider identity already linked to another customer is rejected with
  `CHANNEL_IDENTITY_ALREADY_LINKED`.
- Telegram linking uses a 256-bit, 15-minute, one-use token. Only its hash is persisted. The token
  is redacted from the canonical message body.
- A guest customer can later be explicitly linked to a Grogoni account without creating a replacement
  customer. Conflicting account links are rejected.
- Every lookup and write is business-scoped; an account from another tenant cannot use a channel
  relationship merely by knowing its external identifier.

## Gateway contract and selection

`services/api/src/messaging/channel-gateway.ts` owns adapter registration, capability discovery,
webhook normalization, and transport selection. A provider adapter must report readiness and
capabilities and must return a normalized provider message identifier.

Selection is deterministic:

1. An explicitly selected provider is used or rejected; it never silently falls back.
2. The current conversation provider is preferred when supplied and eligible.
3. Otherwise, the most recently active reachable channel is used.
4. A reachable Grogoni identity is next.
5. The remaining first eligible linked endpoint is used.

Opt-out, missing authorization, missing configuration, an expired reply window, missing opt-in, and
provider initiation restrictions produce normalized errors. Failed attempts remain visible and
retain retryability metadata.

## Provider readiness

This matrix describes repository and runtime readiness, not a claim that production credentials or
provider review have been completed.

| Provider            | Inbound | Reply           | Initiate | Configured        | Contract/mock tested | Live verified |
| ------------------- | ------: | --------------- | -------: | ----------------- | -------------------- | ------------- |
| Grogoni             |     Yes | Yes             |      Yes | Yes               | Yes                  | Internal only |
| Telegram            |     Yes | Existing thread |       No | Runtime-dependent | Yes                  | No            |
| WhatsApp Business   |      No | No              |       No | No                | Fail-closed only     | No            |
| Facebook Messenger  |      No | No              |       No | No                | Fail-closed only     | No            |
| Instagram Messaging |      No | No              |       No | No                | Fail-closed only     | No            |
| TikTok              |      No | No              |       No | No                | Fail-closed only     | No            |
| X DMs               |      No | No              |       No | No                | Fail-closed only     | No            |
| SMS                 |      No | No              |       No | No                | Fail-closed only     | No            |

Telegram requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`; link URLs additionally
require `TELEGRAM_BOT_USERNAME`. WhatsApp requires official Cloud API authorization, a phone-number
ID, authenticated webhooks, consent records, and approved templates where policy requires them.
Messenger requires Page messaging authorization and reply-window enforcement. Instagram requires
a professional-account messaging authorization. TikTok remains disabled until a provider-approved
bidirectional business messaging API is available to the deployment. X requires an API tier and
user-context authorization with Direct Message access. SMS requires an official server-side
provider or a trusted native bridge.

Relevant official constraints include Telegram bots requiring the user to start the relationship
and supporting a webhook secret header, Meta message templates for WhatsApp business-initiated
flows, Messenger recipient/window restrictions, X user-context authentication and DM rate limits,
and TikTok's currently documented data-portability DM access being an export rather than a
bidirectional business messaging channel.

Official references:

- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram bot relationship rules: https://core.telegram.org/bots
- Meta WhatsApp Cloud API collection: https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
- Meta Messenger Send API collection: https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api
- TikTok API scopes: https://developers.tiktok.com/doc/tiktok-api-scopes
- X Direct Message send API: https://developer.x.com/en/docs/direct-messages/sending-and-receiving/api-reference/new-message

## HTTP surface

- `GET /businesses/:businessId/channels/readiness`
- `GET /businesses/:businessId/channel-endpoints`
- `POST /businesses/:businessId/customers/:customerId/channel-link-grants`
- `POST /businesses/:businessId/customers/:customerId/account-link`
- `POST /businesses/:businessId/channel-messages`
- `POST /v1/webhooks/channels/:provider`

The unified conversation view includes its eligible endpoints. The web composer shows their
availability and sends an external conversation through the selected server adapter. Attachments
are blocked until the selected adapter implements canonical media upload and delivery.

## Operations and release checks

1. Apply migration `053_omnichannel_messaging_gateway.sql`.
2. Configure both Telegram token and webhook secret; startup fails if only one is present.
3. Register the Telegram webhook URL and the exact secret with the official Bot API.
4. Create a customer link and complete `/start <token>` before attempting an outbound Telegram
   message. Telegram bots cannot initiate an unlinked user relationship.
5. Check the readiness endpoint and send a non-production canary. Confirm inbound, outbound,
   duplicate webhook, invalid-secret, and provider-failure events before enabling users.
6. Leave every other provider disabled until its official adapter, credentials, policy checks,
   webhook verification, and sandbox/live tests are complete.

Automated coverage is in `tests/omnichannel-messaging-gateway.test.ts` and the existing canonical
chat tests.
