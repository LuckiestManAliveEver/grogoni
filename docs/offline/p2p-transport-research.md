# P2P transport research and prototype

Bitchat uses nearby Bluetooth links to relay framed messages, with bounded forwarding and deduplication. Its project describes private messaging and protocol-level encryption; these are separate concerns from simply discovering a radio. The Grogoni prototype borrows the transport separation and bounded relay approach, without copying Bitchat source. Sources: [Bitchat repository](https://github.com/permissionlesstech/bitchat) and [protocol whitepaper](https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md), also mirrored locally at `eval docs/WHITEPAPER.md`.

Web Bluetooth exposes selected GATT peripherals and requires browser support and permission. It is not a portable peer advertising/background mesh API. MDN marks the API as limited availability and secure-context restricted. Source: [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

## Envelope and framing

Grogoni's existing `ConversationMessageSummary` in packages/shared-types/src/index.ts carries id, conversationId, clientMessageId, idempotencyKey, author, authorId, content and delivery metadata. A full JSON envelope cannot be assumed to fit a BLE packet. The adapter serializes UTF-8 JSON once, fragments bytes into transport-MTU-sized frames and reassembles them without altering the canonical object. Version 2 uses a 27-byte binary header containing protocol version, hop budget, message kind, a random transfer ID, fragment index/count and CRC32. The checksum deliberately excludes TTL so relays can decrement it. Receivers continue to accept the 23-byte v1 header during rollout. Payloads are limited to 64 KiB; files need another transport.

The prototype supports discovery and authenticated connection through an injected native transport. Its persistent outbox interface retains messages until explicit application acknowledgement, with a 24-hour expiry and a 100-message cap. Incomplete incoming transfers expire after 60 seconds, with bounded reassembly/deduplication tables and a seven-hop budget. No invoice, catalogue or payment operation is peer-capable. The resolver can accept this provider only for `conversations.message.send`.

## Platform boundary and recommendation

The current web Settings clearly reports nearby messaging as unavailable. There is no simulated browser radio and no production BLE binding. A native host must implement radio permissions, advertising, discovery, encrypted authenticated sessions and an outbox protected at rest. Peer identity must come from that authenticated transport, never a display name. Message content is still untrusted application input after transport decoding. The prototype's envelope validation is structural, not cryptographic verification or participant authorization.

Proceed with native-device experiments only. Keep PWA rollout limited to local business storage; do not claim production mesh support. Unit tests cover framing, UTF-8 reconstruction, duplicate suppression, disconnect queuing and acknowledgement. Real Android/iOS radios, adversarial peer authentication, battery drain and background relay require separate device testing before enabling peer calls in the application.

## BitChat reliability review (September 2026)

The current BitChat protocol was reviewed at the repository and whitepaper level. Its BLE layer
uses TTL-bounded controlled flooding, short randomized relay jitter, duplicate-triggered relay
cancellation, bounded fragment assembly, persistent sender outboxes, delivery receipts and
authenticated Noise sessions. Grogoni now adopts the pieces that fit its existing transport boundary:

- v2 frames carry a per-fragment CRC32, so corrupted headers or payloads are rejected before
  reassembly or application parsing;
- relays wait 10-220 ms and cancel their pending copy when the same fragment arrives first,
  reducing broadcast storms while retaining the seven-hop fallback;
- Web Bluetooth writes are serialized, preventing overlapping GATT operations from causing
  platform-dependent frame loss; and
- v1 decoding remains covered by a compatibility test, avoiding a flag-day upgrade.

BitChat's dual central/peripheral topology, adaptive fanout, source routes, Noise XX sessions and
courier storage were not transplanted. Web Bluetooth cannot advertise as a peripheral, and Grogoni's
`PeerTransport` contract already requires the native transport to authenticate and encrypt peers.
Implementing cryptography above that boundary would duplicate responsibilities and could imply
security guarantees the browser adapter cannot provide.

## Status: optional Bluetooth channel shipped (browser, GATT-central only)

The envelope/relay/outbox layer above (`PeerProvider`) is no longer a stubbed prototype only - it
is wired to a real, working transport and exposed as an explicit, off-by-default opt-in:

- **Resend cap.** `PeerQueuedMessage` now tracks `attempts`; a message still unacknowledged after
  `PEER_OUTBOX_RESEND_CAP` (8, matching whitepaper §6.1) transmit attempts is dropped and reported
  through a new `onDeliveryFailed` handler, instead of retrying forever with no visible failure.
- **Concrete transport: Web Bluetooth.** `apps/web/src/peer-bluetooth-transport.ts` implements
  `PeerTransport` over the browser's Web Bluetooth API against a fixed Grogoni GATT layout
  (`GROGONI_NEARBY_SERVICE_UUID` with TX/RX characteristics). This is real, tested code, not a
  simulation - but it inherits Web Bluetooth's actual ceiling: browsers expose the **central**
  role only, never peripheral/server, so a Grogoni web tab can connect outward to one
  explicitly-picked Grogoni-compatible BLE peripheral per session (a future native Android/iOS host
  implementing the same GATT layout, or a physical device), never to another browser tab, and
  never in the background - `discover()` opens the browser's own device chooser and must run
  inside a user gesture. This is the platform's real limit, not a simplification made for this
  pass.
- **Opt-in surface.** `apps/web/src/peer-messaging.ts` gates the whole channel behind
  `VITE_PEER_MESSAGING_ENABLED` (default off, same pattern as `VITE_OFFLINE_RUNTIME_ENABLED`) and
  offline mode being active. The Settings panel (`OfflineRuntimeSettings.tsx`) exposes a
  "Message a nearby device (Bluetooth, experimental)" section: connect/disconnect, a send box, a
  received-messages list, and a delivery-failed notice. It intentionally does **not** route
  through `resolveProviderChain` for the main chat pipeline - it is a separate, disclosed surface
  a merchant opts into per message, not a silent fallback for regular conversations. Revisit that
  boundary only as a deliberate follow-up, not as a side effect of another change.

What is still explicitly out of scope, per the platform boundary above: a background/mesh-style
network (impossible from a browser tab, since there is no peripheral role), and the whitepaper's
encryption/identity/courier layers (Noise sessions, Ed25519 signing, spray-and-wait copy budgets)

- those remain a native host's responsibility if and when one exists; this transport's own
  docstring says so (`PeerTransport`: "Must authenticate peers and encrypt the link before exposing
  it to this adapter").
