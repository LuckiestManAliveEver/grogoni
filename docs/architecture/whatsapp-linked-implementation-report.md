# WhatsApp Linked Devices implementation report

This is an **incomplete, disabled-by-default implementation checkpoint**. It does not meet the
full acceptance criteria in the request. No production deployment is claimed. The owner authorized the emulator and test account; live pairing and encrypted session restoration after an API restart both succeeded on November 7, 2026. The temporary linked device was logged out after verification.
See [architecture, gap matrix and operating instructions](whatsapp-linked-devices.md).

## Audited repository and reused components

Initial HEAD: `6b1ba02bd9f4f020d8cfc3e815faef2ed1539c40`; concurrent Android release work advanced
HEAD to `797af49b9a251d616da02fd1d8725b2edb9a701c`. Unrelated ongoing changes in chat-runtime hooks
were preserved and are excluded from this inventory.

Reused: native Kotlin/WebView shell and its trusted message-port bridge; React messaging
connections; business-owner authentication; canonical provider/customer identity and conversation
creation; inbound receipt deduplication; existing gateway selection and send/delivery attempts;
Postgres snapshot mutation tracking; existing audit events. Existing Daemon, capability registry,
commerce, SMS, Telegram, official WhatsApp and OpenRouter/Luna runtime code is preserved.

## Files created

- `services/api/src/messaging/whatsapp-linked/connector.ts`
- `services/api/src/messaging/whatsapp-linked/vault.ts`
- `services/api/src/messaging/whatsapp-linked/baileys-driver.ts`
- `services/api/src/messaging/whatsapp-linked/routes.ts`
- `services/api/src/messaging/whatsapp-linked/routes.test.ts`
- `services/api/src/messaging/whatsapp-linked/baileys-driver.test.ts`
- `apps/web/src/WhatsAppLinkedConnection.tsx`
- `apps/android/app/src/main/java/market/grogoni/app/whatsapp/WhatsAppAvailability.kt`
- `apps/android/app/src/main/java/market/grogoni/app/whatsapp/WhatsAppPackagePolicy.kt`
- `apps/android/app/src/test/java/market/grogoni/app/whatsapp/WhatsAppPackagePolicyTest.kt`
- `tests/whatsapp-linked-connector.test.ts`
- `tests/whatsapp-linked-connection-ui.test.tsx`
- `infra/db/migrations/133_whatsapp_linked_channel.sql`
- `infra/db/rollbacks/133_whatsapp_linked_channel.down.sql`
- `scripts/benchmark-whatsapp-linked.mjs`
- `docs/benchmarks/whatsapp-linked-offline-node.json`
- `docs/licenses/Baileys-MIT.txt`
- `docs/licenses/libsignal-GPL-3.0.txt`
- `docs/architecture/whatsapp-linked-devices.md`
- This report.

## Files modified

- `docs/architecture/omnichannel-messaging-gateway.md`, `docs/architecture/grogoni-native-android-audit.md` — links to the current checkpoint and its limitations.
- `.env.example` — default-off feature flag and host settings; no actual secrets.
- `THIRD_PARTY_NOTICES.md` — connector and transitive dependency licenses.
- `services/api/package.json`, `pnpm-lock.yaml` — pinned Baileys release candidate and dependency graph.
- `packages/shared-types/src/index.ts` — distinct provider/message-channel literals.
- `services/api/src/messaging/channel-gateway.ts` — linked-provider channel mapping.
- `services/api/src/cp2/store.ts` — trusted ingress/owner validation, adapter registration, audit events.
- `services/api/src/cp2/postgres-store.ts` — persist linked ingress and state audit mutations.
- `services/api/src/cp2/domains/messaging/routes.ts` — connection routes and provider parsing.
- `services/api/src/cp2/domains/messaging/store.ts` — linked-provider STOP/START opt-out handling.
- `apps/web/src/MessagingConnectionsPanel.tsx` — small connection control inside the existing interface.
- `apps/web/src/formatters.ts` — distinct linked-device channel label.
- `apps/android/app/src/main/AndroidManifest.xml` — targeted WhatsApp package visibility.
- `apps/android/app/src/main/java/market/grogoni/app/MainActivity.kt` — discovery/launcher bridge methods.

Migration 133 expands the existing provider/selected/actual channel constraints. Credentials are
stored only in an encrypted private host volume. No parallel inbox, agent catalogue, model
runtime, speech engine or commerce schema was introduced. Migration/rollback was not applied to
a live database.

## Delivered functionality

- A real Baileys driver with pairing-code requests, encrypted credential/Signal-key persistence,
  connection restoration and text transport. This is executable protocol code, not a UI-only mock;
  live pairing and session restoration succeeded; broader transport compatibility remains under test.
- Owner-consented linking in the existing messaging panel and targeted native Android discovery.
- Pairing timeout, bounded reconnect backoff, revoked-session handling, credential deletion,
  stale-socket fencing, private-volume exclusivity and structured/persisted connection events.
- Explicit contact/group inbox approval, external identity creation, original-language text
  preservation, canonical deduplication and manual outbound gateway delivery.
- Persistent outbound idempotency with concurrent-send protection and conservative handling of
  uncertain deliveries; no blind resend after a lost acknowledgment.
- STOP/START opt-out handling through the existing gateway's recipient checks.
- Default-off rollout flag; disabling leaves core messaging routes available.

## Unfinished implementation

- Live certification of the WhatsApp-to-Daemon automatic reply bridge.
- Luna replies originating from WhatsApp; existing OpenRouter tests do not establish this path.
- Per-capability business delegation; group mention/reply/command triggers are implemented.
- Commerce tool execution/confirmation over WhatsApp and bounded business-context retrieval.
- Images/documents/voice-note ingestion, speech fallback, quote rendering, edits/deletions,
  delivery acknowledgments.
- Full minimal Android startup onboarding, contact/group picker, native local ARM64 sidecar,
  local-worker enrollment and independent remote-worker transport.
- Owner-transfer cleanup, worker process isolation and production resource certification.

These are implementation gaps, not claims that an interface completed a feature. Opt-in assistant replies now reuse the existing Daemon queue; business-tool execution remains unavailable.

## Tests and checks

Latest results are summarized below. Test artifacts were kept in `/tmp/whatsapp-*.log` during the
session; those paths are local diagnostics, not committed CI artifacts.

- New connector (16), protocol-boundary (10), authenticated API/inbox (4), and React controls (3):
  **33 passed** across four suites, using protocol mocks.
- Existing gateway (Telegram/official adapter contracts): 4 passed.
- Existing native Android SMS channel: 4 passed.
- Existing connected email channel: 7 passed.
- Existing authentication/business: 11 passed.
- Existing OpenRouter runtime: 5 passed; no real inference request or API-key use.
- Existing workspace conversation delivery: 4 passed when rerun alone.
- Existing DB startup/retry: 56 passed, 1 skipped with local socket access.
- API and web TypeScript checks, changed-code ESLint, Prettier and ESM import gate: passed.
- Android manifest verification passed.
- Android Kotlin and Java compilation plus JVM unit tests: passed; 39 tests across 7 suites, 0 failures, 0 errors, 0 skipped. Includes 3 new WhatsApp package-policy tests. No APK assembly or instrumentation/device test is claimed.
  Command: Gradle 8.11.1, JDK 17, `:app:compileDebugKotlin :app:testDebugUnitTest`.
  Resolving the existing build required downloading AndroidX dependencies and explicitly selecting the installed SDK/JDK; no release/signing settings were changed.

A full Vitest run was attempted with two workers and interrupted after 53 passing test files
and two failing files. Three tests timed out: two real PostgreSQL refusal checks in the sandbox,
and one workspace delivery test during the concurrent run. Both failing files subsequently
passed in isolation (the DB checks required local socket access). The **complete 527-file suite
was not completed**, and no full-suite green result is claimed.

## External validation, measurements and risks

Real WhatsApp account linking and API-restart session restoration: **passed** with explicit owner approval on November 7, 2026. Emulator instrumentation: **3 passed** on the authorized Android emulator with the official WhatsApp APK installed. Real physical Android device tests: **none**. No account credentials
were extracted or reused. Authorized account/device access is required to validate first linking,
reconnection, revocation, actual inbound/outbound delivery, mobile-network recovery and process kill.

Offline Linux x64 import only: 2,247 ms, ~91.8 MiB additional RSS, 1,145-byte fresh auth JSON,
29-byte encryption envelope overhead. Connected-session storage, live socket memory, Android
startup/reconnect latency and battery usage are unmeasured. No Node runtime is embedded in the APK.

Residual risks include unofficial protocol instability/account restrictions, the pinned release
candidate/native dependencies, host credential custody, private-volume loss, uncertified live crash recovery and untested ARM64 operation. `libsignal@6.0.0` declares GPL-3.0; distribution-license review
is a release prerequisite. Remote hosting gives that host access to device credentials and
approved plaintext messages. This checkpoint is not production-ready.

## Deployment and rollback

The architecture document contains exact environment settings and test-host steps. Use one
persistent Node API process and a private encrypted session volume. The serverless/Edge host must
leave the feature disabled. Do not enable customer accounts before the outstanding validation
and implementation work is finished.

Emergency rollback: stop the connector host, set `WHATSAPP_LINKED_ENABLED=false`, restart. Existing
inbox data remains. Disconnect deletes local live credentials even if remote logout fails; revoke
the device in WhatsApp as well and apply the same deletion policy to backups. Keep additive
migration 133 applied when possible. Its down migration intentionally fails while linked-provider
rows remain; archive them explicitly before narrowing the CHECK constraints.

## Production-hardening continuation

Added encrypted durable inbound journaling with canonical flush before acknowledgment, fsync of
files/directories, current/previous session-key rotation, and a Linux kernel flock that releases
on process death. Startup rejects an in-memory canonical store in production.

Optional per-chat assistant consent now submits owner-scoped immediate tasks through the existing
Daemon service and honors the conversation model/adapter. Migration 134 preserves browser-first
behavior for ordinary user tasks. Group triggers, STOP fencing, stable task keys, bounded responses,
owner queue caps and a persistent 60/hour business admission cap constrain automatic replies.
No commerce tools or private records are delegated. The service token stays server-side.

New files include `daemon-client.ts` and tests, `worker-lock.ts` and tests, shared
`daemon/result-text.ts`, migration/rollback 134, the operator-only live test script, and Android
WhatsApp discovery instrumentation. Existing Daemon gateway, task store and lanes were extended
to support trusted immediate owner tasks.

API/web type checks passed after this continuation. Android debug and instrumentation APKs built;
all three installed-app discovery/permission/launcher emulator tests passed. These checks do not
certify message delivery, inference, current bundled web UI, battery or physical devices.
The PostgreSQL-backed run passed 36 Edge-lane tests and 16 task-store tests, including the new
immediate-task behavior; two existing process lifecycle tests failed (startup timeout and native
SIGTERM exit assertion). A full-suite green result is not claimed.

Latest targeted connector/API/UI run: **46 passed across six files**, including durable inbox replay, consent fencing, encrypted key rotation, exclusive worker recovery, protocol boundaries and canonical gateway behavior. The Daemon client timeout fix was separately rechecked: **4 passed**.

Two PostgreSQL integration checks passed separately: immediate owner task claiming and authenticated
gateway admission/idempotency/owner conflict enforcement (17 unrelated tests skipped by filter).
Protocol contact identity now resolves LID-addressed messages through the protocol-supplied phone
alias only; no display-name or username identity merging is allowed. Final protocol/client checks:
16 passed. Owner-cap exhaustion skips an assistant reply without failing canonical ingestion.
Changed connector/Daemon code passed ESLint. A later API type check failed in concurrently changed
passkey code at `services/api/src/cp2/store.ts:1426` (WebAuthn options type mismatch); the earlier
API/web type-check success does not establish that the current combined workspace passes.

The subsequent API type check passed after the concurrent passkey edits were completed. The
Android web-asset production build also passed with the current connection controls; the existing
production API origin remains unchanged. The earlier live single-contact delivery attempt timed
out without a canonical inbound event; a contact-ID alias fix and a new authorized test are in
progress. No outbound message delivery is claimed from that failed attempt.

## Latest verification and remaining release gate

The live diagnostic run proved that the approved test contact's fresh text arrived as an unmapped
WhatsApp LID, so the phone-number scope rejected it. The driver now queries WhatsApp's identity
mapping only for explicitly approved phone scopes (at most 100), coalesces each socket/scope-set
lookup, bounds it to 20 seconds, and bounds unresolved identity work to 64 events. Unknown senders
cannot expand the approved lookup list. No display names or usernames establish identity.

Pairing expiry now stops once registered credentials confirm owner approval, allowing WhatsApp's
required authorized socket restart to finish. Storage failures in connection event callbacks fail
closed without escaping as an uncaught EventEmitter exception.

Latest checks: 52 tests passed across six connector/API/UI suites before the additional identity
resource-bound test; the final protocol file separately passed all 14 tests. The final API type
check passed. Android web assets rebuilt, the debug APK assembled successfully and was installed
on the authorized emulator; the three discovery/permission/launcher instrumentation checks had
already passed. The existing production API origin was preserved.

Pairing and encrypted session restoration are verified. A real Daemon/model reply remains a release gate. Canonical live text ingress and a single gateway reply were subsequently verified below. Earlier message attempts timed out without
canonical ingestion and sent no test reply. No customer rollout or production deployment occurred;
the feature remains disabled by default. The unfinished capability/media/local-worker work listed
above remains outstanding.

## Confirmed live text transport and logging fix

On November 7, 2026, the authorized account matched the requested phone number, paired, and
restored its encrypted session after an API restart. A fresh message from the explicitly approved
test contact arrived as a LID. The new approved-phone protocol lookup resolved it, the scope
matched, and the message entered the canonical inbox. The existing gateway sent exactly one fixed
confirmation reply, and the operator confirmed receipt at the test contact. This was a text
transport test, not an inference/model or commerce test. The temporary linked device was logged
out and its temporary encrypted session directory deleted.

That live send exposed libsignal's direct console diagnostics, which bypass Baileys' silent
logger and print session internals. The temporary device was revoked. Grogoni now applies
`patches/libsignal@6.0.0.patch` through pinned pnpm patchedDependencies and the lockfile, removing
those console diagnostics while preserving protocol/cryptographic behavior. The source patch,
modification notice and GPL license are included. Render's build filter includes patch changes.
An actual-installed-library regression test exercises close/reopen/prune paths with secret
canaries and confirms no console output. No live credentials are committed.

Final targeted run after the patch: **54 passed across seven suites**. API type checking and
changed-code ESLint passed. Full release readiness still requires the remaining implementation,
model round-trip, resource and deployment gates in this report.
