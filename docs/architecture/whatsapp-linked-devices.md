# WhatsApp Linked Devices: implementation checkpoint

Date: 2026-11-06. **Incomplete feature; disabled by default. Not production certified.**

Initial audit commit: `6b1ba02bd9f4f020d8cfc3e815faef2ed1539c40`.
The shared checkout advanced during this work to `797af49b9a251d616da02fd1d8725b2edb9a701c`
(Android release build 5). Existing release edits were not overwritten.
The pasted audit's `3fe1a266` is not the implementation baseline.

## Audit and gap matrix

| Area            | Existing architecture inspected                                                                                                  | Delivered here                                                                                                                           | Remaining                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Android         | Native Kotlin host of the packaged shared web app; minSdk 23, target 36; pinned-origin message-port bridge                       | Targeted package queries, installation/enabled detection, ordinary WhatsApp launcher, pairing control in shared messaging panel          | Physical-device linking, startup chat prompt, APK verification, local ARM64 connector                 |
| Authentication  | Cookie sessions, native encrypted cookie storage, device registration, account switching and PIN verification                    | Owner-only connection/scope routes; worker revalidates business ownership and deletion/quarantine before ingress and send                | Device-to-local-worker enrollment, ownership-transfer cleanup UI                                      |
| SMS/offline     | WorkManager, encrypted session storage, durable incoming SMS journal and account-scoped commands                                 | Existing transports unchanged; regression suites executed                                                                                | WhatsApp process-death/offline replay tests on devices                                                |
| Gateway         | `channel-gateway.ts`, `external-channel-adapters.ts`, canonical provider identities/conversations, dedup receipts, send attempts | Distinct `whatsapp_linked` adapter, approved text ingestion, manual outbound through existing channel delivery                           | Media, quote rendering, edits/deletes and delivery acknowledgments                                    |
| CRM             | Tenant/customer identities created by provider ID, not display name                                                              | Reuses `createProviderConversation`; approval creates an external guest identity                                                         | Low-friction contact/group selection, explicit existing-customer linking UI                           |
| Sessions        | No Linked Devices credential lifecycle                                                                                           | AES-256-GCM private-volume vault, pairing codes, expiry, restoration, bounded reconnect, revocation, disconnect and stale-socket fencing | Lease wiring in `routes.ts`, shared-volume topology, independent remote-worker protocol               |
| Daemon          | `services/api/src/daemon`: durable task queue, browser/Edge/native lanes and owner-scoped conversation delivery                  | Owner-scoped immediate tasks and opt-in replies reuse the existing queue and runtime                                                     | Live model/account round-trip certification remains outstanding                                       |
| Luna            | `inference/openrouter-model-runtime.ts` binds `gpt-6-luna`; daemon uses existing runtime policy                                  | Preserved; existing OpenRouter tests executed                                                                                            | End-to-end WhatsApp → Daemon → Luna → WhatsApp test                                                   |
| Commerce/agents | Existing capability registry, runtime approval and business-task harness                                                         | Preserved                                                                                                                                | Delegated capability scopes and approval UX for WhatsApp contacts/groups; commerce and speech routing |
| Storage         | CP2 snapshot/normalized message persistence, legacy channel CHECK constraints                                                    | Adds worker ingress to Postgres mutation tracking; migration 133 expands channel literals                                                | Live Postgres migration/rollback verification                                                         |

A provider identity is an external address, never proof of a Grogoni account or authority to
operate its business tools. A conversation approval currently permits inbox import and manual
replies only. It does not grant the sender the owner's runtime identity. Automatic replies and
all group agent execution remain unavailable. These are unfinished implementation items, not
external blockers or functionality proven by interface definitions.

## Connector selection

The exact dependency is `baileys@7.0.0-rc14` (MIT), pinned with its transitive graph. This is a
release candidate; it must pass live-account validation before rollout. Its pinned `libsignal@6.0.0` dependency declares GPL-3.0, while the native `whatsapp-rust-bridge@0.5.4` declares MIT. Distribution license review remains a release prerequisite; Baileys being MIT does not settle its dependency obligations. Its current upstream
[package manifest](https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/package.json)
requires Node >=20, while Grogoni pins 22.19.0. Its
[example](https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts) demonstrates
pairing codes, credential updates, history events and reconnect handling. This implementation
uses its own encrypted key store, not plaintext `useMultiFileAuthState`.

Baileys supports QR/code authorization and text/group/media protocol primitives. This delivery
implements pairing **codes and text only**. The driver does not sync histories, enumerate
contacts, download media, or activate automation. Group messages require explicit approval to
enter the inbox. Mention/reply metadata is parsed for a future authorized routing layer; it
currently triggers no execution.

The alternative [whatsapp-web.js](https://docs.wwebjs.dev/) uses Puppeteer and a browser. Avoiding
that browser is the reason to prefer Baileys for this Node connector; no comparative live-memory
benchmark was performed. Neither implementation establishes native Kotlin or Android ARM64
compatibility. Baileys' native Rust dependency loads on the tested Linux x64 Node 22 runtime;
other ABIs need separate verification. Neither library provides official WhatsApp authorization
or a guarantee against account restrictions.

## Runtime and security boundary

`LinkedDriver` separates protocol handling from connection management and the canonical gateway.
The supplied driver runs in the persistent Node API process. The same build can run on a user's
Node-capable local host or an expressly chosen hosted Node deployment. There is **no packaged
Android Node sidecar and no standalone remote-worker RPC/enrollment implementation**. Android
currently needs a reachable persistent Node host. The normal serverless/Edge deployment cannot
hold these sockets; leave its feature flag disabled. This is not yet the requested complete
local-first Android deployment architecture.

One process owns each private session volume. An exclusive `worker.lock` refuses a second
process using Linux `flock`; the kernel releases ownership on process death. Never unlink the
lock file to bypass an active worker. This requires util-linux and a local filesystem. The flock is only a same-host volume guard; ownership across processes and hosts is the Postgres lease described in [Multi-worker leasing](#multi-worker-leasing). Do not share the volume across replicas. The encrypted index allows
startup restoration only for saved authorized sessions. Provider logout, bad session, replaced
device and multidevice mismatch require authorization rather than automatic relinking.

Authentication and Signal keys, scope grants, and outbound delivery journal are encrypted in one
private per-business file. Each write uses a fresh 96-bit nonce, a GCM tag, and tenant-bound AAD.
Filenames hash the business identifier; the startup index is encrypted too. The encryption key
must be held outside the volume in a secret manager. Root-directory mode must be 0700; new files
are 0600. Writes use encrypted temporary files, fsync, atomic rename and directory fsync. Optional previous keys rewrap records on read using the current key. Filesystem power-loss durability
has not been certified. No credential or pairing-code logging is enabled in the protocol driver.
State diagnostics log only business ID and state. Pairing responses use `Cache-Control: no-store`;
the frontend keeps codes in component memory, never localStorage.

The provider's connection-open event establishes protocol authorization. The account is bound
to the authenticated business owner who initiated pairing. No account number is inferred from
Android package discovery. Android declares only `com.whatsapp` and `com.whatsapp.w4b` queries,
as supported by [Android package visibility](https://developer.android.com/training/package-visibility/declaring).
It launches the app using PackageManager; it does not assume an undocumented Linked Devices deep
link. Users navigate to Linked devices and approve WhatsApp's code themselves. No Accessibility
Service, private app storage access, or silent linking is used.

A remotely hosted connector holds decryptable device credentials and sees approved message
plaintext. WhatsApp transport encryption ends at that linked device; canonical Grogoni messages
follow existing server storage/access policies. Consent names this credential custody. Existing
Grogoni E2EE direct-message rules are untouched; this channel does not promise that server-side
provider messages are Grogoni end-to-end encrypted.

Inbound events are journaled in the encrypted vault before canonical ingestion, serialized, bounded to 64 pending events, and stop in SUSPENDED on overflow. Journal entries are removed only after canonical storage flush succeeds and replay after restoration. Production startup requires durable canonical storage.
Only approved chat IDs are accepted; self messages, broadcasts, histories and oversized/non-text
messages are ignored. Provider IDs are namespaced with business/chat/sender before canonical
deduplication. Provider time is preserved in the existing `clientTimestamp`; receipt/sync times use the server clock. LID-addressed contacts resolve through protocol-supplied aliases, its identity cache, or a bounded lookup of explicitly approved phone scopes only; each socket coalesces that lookup and caps unresolved identity work at 64 events. Display names never merge customers. Scope removal is checked again before a
queued event executes. Worker ingress/sends revalidate current business ownership and account
deletion/quarantine. Socket epochs fence events after reconnect, timeout, disconnect and shutdown.
Each host is capped at eight account sessions; this is a bound, not an experimentally certified capacity. Scopes are capped at 100, the encrypted file at 16 MiB, and the delivery journal at 10,000 sends.

Outgoing text is bounded to 4,000 characters. The existing gateway persists delivery attempts.
The connector additionally persists a pending idempotency entry **before** calling WhatsApp;
concurrent/repeated attempts cannot duplicate sends. A network failure after handoff remains
uncertain and is not automatically resent. Check WhatsApp before sending a new message. The
journal refuses additional entries when full rather than evicting keys and risking replay.

Residual risks: unofficial protocol changes/restrictions, release-candidate dependencies and
native-code supply chain, host/key compromise, private-volume loss, unmeasured live
resource consumption, no independent worker isolation, no provider-level live compatibility proof,
events lost before the protocol callback reaches the durable journal. Connection state events reuse the existing persistent
audit-event store; structured state logs also support operational diagnostics.

## Multi-worker leasing

Code: `services/api/src/messaging/whatsapp-linked/lease.ts`, integrated in `connector.ts`.
Schema: `infra/db/migrations/136_whatsapp_linked_leases.sql` (rollback
`infra/db/rollbacks/136_whatsapp_linked_leases.down.sql`).

Two linked sockets for one WhatsApp account on two workers duplicate ingress, race the delivery
journal and can send the same reply twice. The flock cannot prevent that across hosts. The
lease can.

### Design

`whatsapp_linked_leases` has one row per business: `holder_id` (worker instance id),
`generation` (bigint), `expires_at`, `heartbeat_at`, `acquired_at`. Rows are never deleted, so
`generation` only grows and a stale generation can never match again. Every statement is a
single compare-and-set, and every expiry comparison uses the database clock (`now()`):

| Operation | Succeeds when                                               | Effect                                     |
| --------- | ----------------------------------------------------------- | ------------------------------------------ |
| acquire   | row absent, `expires_at <= now()`, or same `holder_id`      | `generation + 1`, `expires_at = now()+ttl` |
| renew     | same holder **and** generation **and** `expires_at > now()` | `expires_at = now()+ttl`                   |
| release   | same holder and generation, unexpired                       | `expires_at = now()`                       |
| verify    | same holder and generation, unexpired                       | none (read)                                |

Acquire is one `INSERT .. ON CONFLICT DO UPDATE .. WHERE`. Concurrent acquirers serialize on
the primary key: the loser waits for the winner's commit, then re-checks the `WHERE` against the
winner's unexpired row and gets nothing back. An expired lease cannot be renewed, even when
nobody took it over. The holder re-acquires and gets a new generation, which fences its own
previous tenure.

`LinkedLeaseKeeper` holds the leases for one worker. It treats a lease as valid locally only
until `t_sent + ttl - skew`, where `t_sent` is the monotonic time at which the acquire or renew
request was **sent**. The database computed `expires_at` later than that, so the local window
closes before the database window, as long as the worker's monotonic clock and the database
clock disagree by less than `skew` over one TTL. The keeper renews every `heartbeatMs`, pulled
forward when a slow round trip left less of the window, so that at least two renewals land
inside it. It reports a loss when a renewal is rejected, when no renewal succeeds before the
local deadline, or when `verify` finds the row gone. On loss it releases the row (best effort,
conditional on its own generation) so a standby does not wait a full TTL.

The connector, with `lease` configured:

- **Opens only under the lease.** `connect`, reconnect timers and standby retries acquire
  before any socket exists. If another worker holds it, `connect` throws
  `LinkedLeaseUnavailable` (`CHANNEL_UNAVAILABLE`, retryable) and `restore` goes to standby.
- **Generation feeds the epoch.** The socket epoch is `<lease generation>:<uuid>`, and every
  socket callback checks the epoch and `holds(generation)` on each event. Canonical `receive`
  gets that epoch, so ingress can be traced to a tenure.
- **Loss fences everything.** Losing the lease closes the socket, aborts media downloads,
  rotates the epoch (stopping drain and every callback), cancels timers and refuses vault
  writes. Unacknowledged inbound stays in the encrypted journal for the next tenure. A worker
  that loses during pairing goes to `AUTH_REQUIRED`; an authorized session goes to `SUSPENDED`
  and retries acquisition every `retryMs` as a standby.
- **Sends check the database.** Before every send, `verify` confirms holder and generation
  against Postgres. A database error fails closed and nothing is sent. The idempotency journal
  check runs after that `await`, with no further `await` before `socket.send`, so concurrent
  sends stay atomic.
- **Takeover reloads the record.** After acquiring, the connector re-reads the business's vault
  record before opening, so it never resumes from a cache older than its predecessor's writes.
- **Release on exit.** `DISCONNECTED`, `AUTH_REQUIRED`, `REVOKED`, `SUSPENDED` and `ERROR`
  (no socket, no reconnect scheduled) hand the lease back. Ordinary reconnects keep the lease
  and its generation. `stop()` releases everything.

Without `lease` (single-process mode, the default), behaviour is unchanged: the flock is the
only guard and the epoch is a plain UUID.

### Failure modes

| Event                                           | What happens                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holder process dies (SIGKILL, host loss)        | Row expires within `ttl`; a standby acquires `generation + 1` within `ttl + retryMs` and resumes.                                                                                                                                |
| Holder partitioned from Postgres, still running | Stops at `ttl - skew` (local); database expiry at `ttl`; takeover after. No overlap.                                                                                                                                             |
| Postgres down for every worker                  | Every holder fences itself at `ttl - skew`. No WhatsApp traffic until it returns (fail closed).                                                                                                                                  |
| Postgres down at startup                        | `restore` puts sessions in standby; they open on the first successful retry.                                                                                                                                                     |
| Renewal answered after the local deadline       | Discarded; the lease stays lost.                                                                                                                                                                                                 |
| Two workers acquire at the same instant         | Exactly one gets a generation (tested on real Postgres with 10 parallel connections).                                                                                                                                            |
| Clock drift or a pause longer than `skew`       | **The bound is broken.** The old holder can act past database expiry. Sends still fail on `verify`; ingress is deduplicated by provider id. A suspended VM is the realistic cause: Linux `CLOCK_MONOTONIC` stops during suspend. |
| Operator or bug re-grants the row               | The next renewal or send verification fails; the old holder fences itself.                                                                                                                                                       |

The remaining unfenced windows are short. One is between a successful `verify` and the
provider receiving the send. The other is a canonical write that started just before loss.
Both rely on the existing idempotency and deduplication rather than on the lease.

### Topologies

- **One worker per private volume (supported).** Each worker's sessions live on its own
  volume. The lease guarantees that at most one socket per business runs across all workers,
  even when two volumes hold records for the same business (two companion devices). Failover
  only reaches a worker whose volume has a record for that business.
- **Shared encrypted volume across hosts (not yet).** The connector is ready for it: it re-reads
  after takeover and refuses writes after loss. `routes.ts` still takes one `worker.lock` per
  volume root, though, which would admit only one process to a shared volume. Scoping that lock
  per worker when lease mode is on is an open item.

### Operator settings

All are host settings. The defaults are safe. Invalid values refuse startup.

| Variable                             | Default                    | Meaning                                                             |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------- |
| `WHATSAPP_LINKED_LEASE_MODE`         | `off`                      | `off`: single process, flock only. `postgres`: lease every session. |
| `WHATSAPP_LINKED_WORKER_ID`          | `<hostname>:<pid>:<rand8>` | Unique per process. Never reuse one id for two live processes.      |
| `WHATSAPP_LINKED_LEASE_TTL_MS`       | `30000`                    | Database lease duration (5000 to 600000).                           |
| `WHATSAPP_LINKED_LEASE_HEARTBEAT_MS` | `8000`                     | Renewal period; must be ≤ (TTL − skew) / 3.                         |
| `WHATSAPP_LINKED_LEASE_SKEW_MS`      | `5000`                     | Tolerated clock disagreement or pause per TTL; 1000 to TTL / 2.     |
| `WHATSAPP_LINKED_LEASE_RETRY_MS`     | `10000`                    | Standby acquisition retry period (1000 to 4 × TTL).                 |

Failover time after a crash is at most `TTL + RETRY` (40 s by default). Raising `SKEW` makes the
system tolerate longer pauses, but each tenure's usable window shrinks. Each acquisition, loss
and release emits a `whatsapp_linked.lease` log event (business, holder, generation, action,
reason).

Wiring: `createLinkedLeaseKeeper(environment, pool)` returns `undefined` in `off` mode.
Otherwise it returns a keeper, which is passed to `new LinkedWhatsAppConnector({ ..., lease })`.
`routes.ts` does not call it yet (see open items). Until it does, `WHATSAPP_LINKED_LEASE_MODE`
has no effect, and you must run exactly one connector process.

Rollback: stop every connector, or return to `off` with one worker, before applying
`136_whatsapp_linked_leases.down.sql`.

Verification: `lease.test.ts` (keeper and in-memory contract), `lease.postgres.test.ts` (the same
contract plus racing keepers on real SQL, gated on `CP2_POSTGRES_TEST_DATABASE_URL`), and
`tests/whatsapp-linked-lease-connector.test.ts` (connector takeover, fencing and release).

## Deployment and rollback

Do not deploy or enable for customer accounts until live pairing/transport, persistence and
resource checks pass. For a controlled test installation:

1. Install the lockfile dependencies on Node 22.19.0 (`pnpm install --frozen-lockfile`).
2. Apply `133_whatsapp_linked_channel.sql`, `134_daemon_immediate_user_tasks.sql` and `136_whatsapp_linked_leases.sql` with the existing migration runner.
3. Provision an empty private persistent directory (0700), mounted to one Node API process.
4. Set `WHATSAPP_LINKED_ENABLED=true`, `WHATSAPP_LINKED_SESSION_DIR` to that absolute path,
   and `WHATSAPP_LINKED_SESSION_KEY` to a securely generated 32-byte key encoded as 64 hex digits.
   These are host settings, never values for the Android app or frontend bundle.
5. Start the existing Node API. Its startup hook restores authorized sessions. Open the existing
   business messaging connections as the owner, consent, enter the number including country code,
   and complete WhatsApp's device authorization. No Meta credentials/webhooks are needed.
6. Approve individual external contact/group IDs. Only those messages enter the canonical inbox.
   The ID-entry UI is an interim advanced control, not the final minimal onboarding experience.
7. Send replies through the existing channel-message API with provider `whatsapp_linked` and a
   stable idempotency key. Optional assistant replies require `WHATSAPP_LINKED_DAEMON_URL`, matching server-side `DAEMON_SERVICE_TOKEN`, and explicit per-chat automation consent. Each task uses the current conversation model and adapter, the owner queue cap, and a 60 replies/business/hour admission cap. Group replies require a mention, Grogoni command, or reply to an automated message. STOP disables automation immediately. No business tools or private records are delegated.
8. Rebuild Android web assets with `pnpm android:web:bundle` before assembling an APK. The existing
   bundle script pins `https://grogoni.com/api`; this checkpoint provides no automatic discovery
   of a separate local/remote worker. A test PWA can target the persistent Node API through its
   existing API-base build setting. Do not assume the production Edge host can hold the socket.

API endpoints under `/businesses/:businessId/channels/whatsapp-linked`:
GET status; POST `/connect` `{consent:true,phone:"254…"}`; POST `/scopes`
`{chat:"…@s.whatsapp.net"|"…@g.us",approved:true|false,automation:false|true}`; DELETE disconnect/delete credentials.
All require an authenticated business owner. No public protocol-event ingress endpoint exists.

Emergency disable: stop the connector process, set `WHATSAPP_LINKED_ENABLED=false`, and restart.
The connection control disappears; official WhatsApp, SMS, Telegram and the inbox remain usable.
To erase a session, disconnect while enabled. Logout failure never prevents local deletion;
WhatsApp may still list the linked device if remote logout fails, so revoke it there as well.
Protect encrypted backups under the same deletion policy. Rollback migration 133 only after
explicitly archiving/removing linked-provider rows: its narrowed CHECK constraints intentionally
refuse to hide/delete existing data. Leaving the additive migration applied is the safer feature
rollback. Do not use rollback as a way to erase credential backups.

## Resource measurements and verification

`node --expose-gc scripts/benchmark-whatsapp-linked.mjs` measures an offline import, never connects
an account, and prints no credentials. Recorded Linux x64 / Node 22.19.0 result:
2,247 ms import, RSS 45,117,440 → 141,340,672 bytes (delta 96,223,232 bytes, ~91.8 MiB),
heap delta 22,208,928 bytes; fresh credential JSON 1,145 bytes; encryption envelope overhead
29 bytes. See `docs/benchmarks/whatsapp-linked-offline-node.json`. This is not a steady-state
connected-session benchmark or evidence that a low-memory Android device can host the connector.

Live account/device tests completed: **none**. No authorized WhatsApp test account was supplied or
used. No existing account credentials were read. Real pairing, account approval, loss/recovery of
mobile data, process kill, LID identity changes, reconnect latency, Android ARM64 native loading,
battery use and connected memory/storage remain external validation work. Do not call mocked
success a successful real WhatsApp authorization.

Automated test/check outcomes and file inventory are recorded in
`docs/architecture/whatsapp-linked-implementation-report.md`.

## End-to-end assistant reply coverage

`tests/whatsapp-linked-daemon-e2e.test.ts` runs the whole opt-in assistant-reply bridge in one
process. Only the two edges are fake: a mocked `LinkedDriver` socket and a stubbed OpenRouter
`chat/completions` endpoint (global `fetch`; any other URL fails the test). Everything between
them is production code: the connector's `shouldAutomate` decision and 60-per-hour admission
cap, the `respond`/`deliver` bridge in `routes.ts`, a real `LinkedDaemonClient`, the Daemon
gateway, the PostgreSQL task queue, `runDaemonWorker`, `createDaemonExecutor` with the Grogoni
engine and `gpt-6-luna`, `daemonResultText`, and `deliverLinkedWhatsAppReply` into the
connector's outbound journal.

`registerLinkedWhatsAppRoutes` takes an optional fifth argument,
`{ daemonClient?: LinkedAssistantDaemon }`. The test passes a real `LinkedDaemonClient` whose
`fetcher` is Fastify `inject` into the in-process gateway, so no socket opens. Production never
passes it: the client is still built only when `WHATSAPP_LINKED_DAEMON_URL` is set.

The suite asserts:

- one inbound text produces one completed, owner-scoped, server-lane Daemon task and exactly one
  socket `send`; a provider redelivery of the same event re-runs nothing;
- the OpenRouter request names `openai/gpt-6-luna` and carries no tools;
- `STOP` turns automation off: that message and later ones are ingested, nothing is queued or sent;
- an approved group message without a mention, `grogoni` prefix or reply-to is ingested but
  queues nothing; a mention in the same group does reply;
- 61 messages in one hour yield 60 tasks and 60 sends; the 61st is ingested and never reaches
  the model;
- a failed task (OpenRouter 401, `PROVIDER_AUTH_FAILED`) keeps the inbound message, sends
  nothing and leaves the connection `CONNECTED`;
- an unavailable gateway (HTTP 503) keeps the inbound message, sends nothing, queues nothing and
  moves the connection to `RECONNECTING` so the journaled message is retried.

It needs `CP2_POSTGRES_TEST_DATABASE_URL` (each run uses its own schema and drops it) and skips
without it, like the other Daemon queue suites; CI sets the variable.

## Delegated business tools and the owner's decision

An owner can grant one approved WhatsApp contact or group a fixed set of commerce tools
(`linkedToolChoices` in `services/api/src/messaging/whatsapp-linked/tool-grants.ts`). The grant
needs assistant replies enabled for that chat plus an explicit `consent: true`. It is stored on the
conversation channel as `linkedToolGrant` with a fresh grant id each time. Pausing replies,
removing the conversation approval, disconnecting, a re-grant, or the recipient's `STOP` all
replace or disable that grant, so older delegations stop validating
(`validateLinkedToolDelegation` in `services/api/src/cp2/store.ts`).

**Read tools expose data without asking the owner each time.** `products.list`, `invoices.list`,
`sales.history` and `purchase.history` run as soon as the participant asks. The grant panel in
`apps/web/src/WhatsAppLinkedConnection.tsx` says what each read tool reveals, shows a warning
naming the contact (or "everyone in this WhatsApp group") whenever a read tool is selected, and
keeps "Allow selected capabilities" disabled until the owner ticks the approval box. Changing
the selection clears that tick. "Remove all capabilities" revokes the grant without a new
approval, since revoking only reduces access.

**Write tools wait for the owner.** `executeLinkedToolTurn` turns a delegated write into a
`needs_confirmation` runtime turn, posts an approval card in the Grogoni conversation, and
tells WhatsApp the action is waiting for the shop owner's approval.

### Telling WhatsApp how the owner decided

When the owner resolves that card, the originating chat gets exactly one reply:

| Owner action                                           | WhatsApp text                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Approves and the tool runs                             | `Done: <fixed tool summary>.`, e.g. `Done: the new catalogue item was added.` |
| Approves but execution is blocked (e.g. grant revoked) | `The shop owner approved this request, but it could not be completed.`        |
| Rejects                                                | `The shop owner declined this request.`                                       |

The texts are fixed strings (`services/api/src/messaging/whatsapp-linked/delegation-result.ts`).
No tool input, tool result, record id, owner name or model output is put into them, so the
reply cannot leak owner-only context.

How the reply is sent:

1. `confirmRuntimeAction` (approval) and `rejectRuntimeApproval` (rejection) in
   `services/api/src/cp2/domains/agent-runtime/` call `reportChannelDelegationResolution`
   (`channel-delegation-result.ts`) once the decision is committed. It does nothing unless the
   plan has a `channelDelegation`. It finds the originating proposal turn (same business, action
   id, source message, grant and channel) and calls the `deliverChannelDelegationResult` domain
   dependency. It never throws: a failure is audited as
   `runtime.channel_delegation_result_undelivered` and the owner's action still succeeds.
2. `Cp2Store.deliverLinkedDelegationResult` checks authority again at send time. The channel
   must still be this owner's `whatsapp_linked` channel, the recipient must not have sent `STOP`,
   and `validateLinkedToolDelegation` must still pass for the same grant id, tool and live source
   message. If any check fails, nothing is sent and
   `whatsapp_linked.delegated_result_suppressed` is audited with the `reason`
   (`recipient_opted_out`, `whatsapp_tool_grant_revoked`, `channel_unavailable`, ...).
3. Otherwise it sends through `deliverLinkedWhatsAppReply` with idempotency key
   `whatsapp-result:<originating turn id>` and audits `whatsapp_linked.delegated_result_sent`.
   A send error is audited as `whatsapp_linked.delegated_result_failed`.

Duplicates are blocked twice. The approval store lets a token be claimed or rejected only once,
so a second approve or reject returns 404 before any reply is attempted. A replayed delivery for
the same originating turn reuses the stored message for that idempotency key and does not call
WhatsApp again.

Persistence: with Postgres, `business_runtime_approvals` rejection now uses
`returning action`, so the delegation reference survives the durable path.
`rejectRuntimeAction` and `deliverLinkedDelegationResult` are in `mutatingMethodNames`
(`services/api/src/cp2/postgres-store.ts`), so the outbound message and audit events are saved
in the snapshot. Approval already goes through `createRuntimeTurn`, which is listed.

Limits: the reply is not threaded as a WhatsApp quote of the original request. If the decision
is made on a host with no registered linked-device connector (the Edge lane), the send fails, is
audited as `delegated_result_failed`, and is not retried.

Tests: `services/api/src/messaging/whatsapp-linked/delegation-result.test.ts` (approve, reject,
revoked grant, STOP, duplicate resolution, non-delegated turns, bounded text, routing, failure
isolation), the delegated flow in `routes.test.ts`, the Postgres rejection return in
`runtime-approval-store.test.ts`, and the grant UI in `tests/whatsapp-linked-connection-ui.test.tsx`.
