# Android native SMS channel

## Audit result

Before this implementation Grogoni was a React/Vite PWA plus Node services. It had no Android Gradle
module, manifest, Kotlin client, or trusted native device transport. The web SMS feature in
`apps/web/src/messaging/sms-handoff.ts` only opened the operating system composer. It could not read
the SMS inbox, receive carrier broadcasts, or execute a server-delegated send.

Grogoni already had the pieces that should remain authoritative:

- canonical conversations, customers, messages, session families, and sync records in
  `services/api/src/cp2/store.ts`;
- normalized channel selection in `services/api/src/messaging/channel-gateway.ts`;
- the authorized `messaging.send` tool in `packages/tool-core/src/index.ts`;
- API routes and durable PostgreSQL snapshot persistence in `services/api/src/cp2/routes.ts` and
  `services/api/src/cp2/postgres-store.ts`;
- account sync and realtime browser change notification, but no native command transport.

The root gap was therefore an execution environment gap: neither a browser nor the Render backend
can call Android telephony, and no authenticated Android device was registered to execute canonical
commands.

## Architecture

`native_sms` is a Channel Gateway provider whose execution environment is `android-device`. The
backend stores the canonical outbound message first, chooses one deterministic preferred eligible
device, and stores a command containing the canonical message reference. The message text is read
only when that authenticated device fetches the command.

Inbound path:

```text
SIM / Android SMS_DELIVER
→ NativeSmsReceiver
→ MultipartSmsAssembler + NativePhoneNormalizer
→ encrypted NativeSmsStore offline event
→ NativeSmsSyncWorker
→ POST /v1/devices/native-sms/messages
→ ingestNativeSmsMessage / ingestProviderMessage
→ canonical customer + provider identity + conversation message
→ normal conversation history, sync, unified UI, and authorized agent runtime context
```

Automatic carrier replies remain off. An inbound SMS is available to the normal agent runtime, but
an SMS send still requires the existing structured `messaging.send` authorization/confirmation
path.

Outbound path:

```text
Grogoni UI or agent-approved messaging.send
→ ChannelGateway native_sms adapter
→ canonical outbound message + one NativeSmsDeviceCommand
→ WAITING_FOR_DEVICE when the selected Android node is offline
→ authenticated Android command fetch
→ local command claim (replay guard)
→ SmsManager.sendMultipartTextMessage
→ sent/delivery BroadcastReceiver callbacks
→ normalized result endpoint
→ canonical Grogoni message status
```

The Android app persists the outgoing row required of the default SMS handler. Multipart carrier
segments remain implementation details; Grogoni stores one canonical message.

## Readiness and security

Readiness is derived from the authenticated Android-native session, active session family, SMS role,
SEND/RECEIVE permissions, telephony support, deterministic default subscription, and recent device
sync. Platform type alone grants no capability. Commands are tenant/account/device scoped, expire,
and are never broadcast to multiple phones. Logout revokes the session family and cancels Android
work, so the node cannot fetch more commands.

Android uses Keystore-backed AES-GCM field encryption for session cookies, inbound phone numbers and
message bodies, and carrier references. Backend logs contain identifiers and normalized error codes,
not message content. Incoming messages are only synchronized after sign-in and explicit business
selection. Historical inbox import and OS Contacts creation are intentionally absent.

## Reliability boundaries

Inbound events remain encrypted and unsynced locally until WorkManager has connectivity. Outbound
commands remain durable on the backend and are fetched after reconnect. WorkManager uses a unique
immediate work chain, retries with bounded exponential backoff, and one connected 15-minute
periodic recovery job; there is no permanent foreground poll loop. A local command left in
`execution_started` waits two minutes for carrier callbacks, then yields `SMS_DELIVERY_UNKNOWN`
on recovery, never an automatic second carrier send.

Immediate sync requests append behind running work so inbound events and carrier callbacks cannot
lose their wakeup. Periodic and immediate workers serialize command execution. A command interrupted
before `execution_started` can resume after its acknowledgement reconnects; it has not reached the
modem. Inbound and result backlogs continue across batches without waiting for the periodic job.
Result uploads delete only the revision acknowledged by the backend, preserving callbacks that
arrive during an upload. The pending-results database migrates to version 4 without clearing queues.

The phone still needs internet to reach the backend. These recovery paths preserve queued work
during an outage; they do not run backend order processing or AI inference over cellular SMS alone.

Delivery receipts are best-effort because carrier support varies. No server SMS gateway, PWA
telephony API, bulk inbox import, MMS transport, arbitrary SIM-slot fallback, or iOS equivalent is
introduced here.
