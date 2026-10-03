# Connected email channel

## Repository audit

Grogoni's registered email is account identity data. `Cp2Store` normalizes it through the existing
email identity and OTP flows in `services/api/src/cp2/store.ts`; the routes in
`services/api/src/cp2/routes.ts` use it for sign-in, verification, recovery, and account linking.
`services/api/src/cp2/email-provider.ts` is a transactional Resend adapter for OTP and account
notifications. Neither record authorizes Grogoni to read or send mailbox mail.

Google and Microsoft login OAuth already existed in `services/api/src/cp2/oauth.ts`, but its
tokens and scopes represent login identities. Connected mailbox OAuth therefore uses separate
sessions, credentials, scopes, and encrypted token records. It may share an OAuth client
configuration, but never promotes a login identity into mailbox authorization.

The implementation reuses the existing domain:

- customers and their email field in `services/api/src/cp2/store.ts`;
- `platformIdentities` for the provider-neutral email identity;
- `conversationChannels` for mailbox/thread bindings;
- `conversationMessages` and provider update receipts for canonical messages and deduplication;
- `messaging.send` in `packages/tool-core/src/index.ts`;
- the adapter registry and selection policy in `services/api/src/messaging/channel-gateway.ts`;
- the existing conversation inbox and composer in `apps/web/src/GrogoniApplication.tsx`.

No email-specific customer, CRM, inbox, agent runtime, or top-level provider tool was added.

## Design

A `ConnectedMailbox` is business-scoped and account-owned. It records provider-neutral Gmail or
Outlook identity, readiness, send/receive capability, one business default, sync policy, encrypted
access and refresh tokens, and lifecycle timestamps. OAuth state and PKCE verifier records are
short-lived and single-use. Provider passwords are never requested or stored.

Email addresses are trimmed and validated. Domain casing is normalized while local-part casing is
preserved. Customer and platform identity lookups are business-scoped. Display names never merge
customers. A known customer email is reused; an explicitly addressed outbound email may create the
same minimal canonical customer used by other external channels. Unknown inbound senders are
filtered by default and may be enabled per mailbox.

`email` is a normal Channel Gateway provider with send, receive, initiate, reply, subject, and
thread capabilities. The generic gateway selects a mailbox-backed endpoint, while
`EnvironmentEmailMailboxProviderClient` contains Gmail and Microsoft Graph details. Canonical
messages use normalized `subject`, `externalThreadId`, `providerMessageId`, sender and recipient
fields. Email sends stop at `sent`; the providers used here do not prove recipient delivery.

## Outbound and inbound paths

Outbound:

```text
Grogoni user or authorized agent proposal
  -> messaging.send
  -> Cp2Store.sendChannelMessage
  -> ChannelGateway.send
  -> email channel adapter
  -> connected-mailbox transport
  -> Gmail API or Microsoft Graph
  -> canonical message state
```

Inbound:

```text
explicit controlled mailbox sync
  -> Gmail API or Microsoft Graph inbox fetch
  -> provider-neutral normalization and automated-mail filtering
  -> mailbox + external message deduplication
  -> tenant-scoped email identity/customer resolution
  -> conversation channel thread binding
  -> canonical conversation message
  -> existing unified inbox and agent context
```

Synchronization runs through the existing API-process runner pattern every five minutes by
default, with overlap prevention and a per-run mailbox cap. Incremental batches read at most 25
inbox messages since the last-sync watermark. An explicit history action can import up to 30 days
and 100 messages at a time. Both paths exclude spam/junk, remove quoted thread text, and deduplicate
provider events.

Automatic acknowledgements are disabled by default. A mailbox owner may explicitly enable a
bounded acknowledgement, which is sent only for an established Grogoni email thread, never for mail
classified as automated, and at most once per thread every 24 hours. The acknowledgement uses the
same canonical message, provider authorization, idempotency, audit, and delivery pipeline.

Confirmed Grogoni invoices can be selected in the email composer. The API resolves the invoice in the
current tenant, generates a bounded text document server-side, and passes only normalized bytes to
Gmail or Microsoft Graph. Client paths and arbitrary attachment URLs are never accepted.

## Provider configuration

Set the mailbox-specific OAuth variables documented in `.env.example`. The API prefers
`MAILBOX_GOOGLE_*` and `MAILBOX_MICROSOFT_*`; existing login client settings are only a client-ID
fallback. Configure the exact callback URI exposed by `/v1/mailboxes/oauth/:provider/callback`.
Tokens are encrypted with the repository OAuth encryption key and are never returned to the web
client, model, tool arguments, logs, or analytics.

Gmail uses offline OAuth with `gmail.send` and `gmail.readonly`. Outlook uses
`offline_access`, `Mail.Send`, and `Mail.Read`. Refresh is attempted before expiry; a permanent
refresh failure marks the mailbox `REAUTHORIZATION_REQUIRED` and prevents more sends.

## Security boundaries

- SMTP and mailbox passwords remain disabled because the repository has no secure generic SMTP
  credential lifecycle. Gmail and Outlook OAuth cover the implemented providers.
- Bulk campaigns remain blocked because the repository has no marketing-consent or unsubscribe
  model. This channel is limited to canonical customer conversations.
- Provider HTML is accepted but normalized to safe text; executable or arbitrary email HTML is
  never rendered in Grogoni.
- Attachments are limited to confirmed Grogoni invoices resolved server-side. Arbitrary files and
  paths remain rejected.
- Live Gmail and Outlook behavior requires configured provider applications and test accounts; a
  fake adapter is used in automated integration tests.
