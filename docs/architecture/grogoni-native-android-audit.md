# Grogoni Native Android Audit

**Checkpoint:** pre-implementation audit for the "Grogoni Native Android — Capacitor, SMS Gateway,
Contacts, Offline Messaging and Agent Runtime" directive.
**Method:** static inspection of the checked-in repository at the time of writing. No production
behavior was modified to produce this document.
**Rule applied:** repository reality takes precedence over assumptions in the directive. Where the
directive's premises conflict with the code, the code wins and the conflict is recorded explicitly.

---

## 0. Executive summary

The directive assumes a React/Vite PWA that must be wrapped in Capacitor and extended with a new
native SMS gateway, contacts bridge, offline queue, and Android installation prompt.

**The repository is substantially further along than that premise, and in one central respect it
has deliberately chosen a different architecture.**

What actually exists today:

- A monorepo (`pnpm` workspaces) with a React 19 / Vite PWA in `apps/web`, a Fastify backend in
  `services/api`, shared packages in `packages/*`, and two extra services
  (`services/sync`, `services/computer-runtime`).
- A **standalone, native Kotlin Android application** in `apps/android` (Gradle, `market.grogoni.app`,
  compileSdk/targetSdk 35, minSdk 23). It is **not** a Capacitor shell and the repo records that
  choice intentionally (see `docs/messaging/cross-device-sms.md`,
  `docs/android/external-sms-composer-handoff.md`, `docs/architecture/unified-commerce-audit.md`).
- A working **native SMS gateway**, end to end:
  - Android receives via `NativeSmsReceiver` (`SMS_DELIVER`), assembles multipart, normalizes to
    E.164, encrypts at rest in a Keystore-backed SQLite store (`NativeSmsStore`), and syncs via
    `NativeSmsSyncWorker`.
  - The backend exposes a full command/ingest surface under `/v1/devices/native-sms*` in
    `services/api/src/cp2/domains/messaging/routes.ts`, backed by migration
    `054_android_native_sms_channel.sql` (`native_sms_devices`, `native_sms_device_commands`).
  - Outbound flows through the existing `channel-gateway.ts` as a `native_sms` provider, delegated
    to a single authenticated device with a replay-safe command lifecycle.
  - Tests exist: `tests/android-native-sms-channel.test.ts`, `tests/offline-order-reconciliation.test.ts`,
    plus Kotlin JVM and instrumented tests under `apps/android/app/src/{test,androidTest}`.
- A cross-device SMS web contract (`apps/web/src/messaging/sms-handoff.ts`, `window.GrogoniDevice` /
  `window.GrogoniAndroid`), which is an **OS-composer handoff**, not a WebView bridge.
- An `/install` web route (`apps/web/src/InstallPage.tsx`, `routes.ts`) that explains PWA vs APK
  install, plus release tooling (`scripts/verify-android-release-identity.mjs`,
  `scripts/generate-android-assetlinks.mjs`, `scripts/verify-play-legal-readiness.mjs`) and a
  release-identity manifest (`config/android-release-identity.json`, currently `proposed`).

**The largest divergences from the directive, stated plainly:**

1. **Capacitor is not part of this architecture and should not be introduced.** The web PWA and the
   Android app are separate deliverables on purpose. The PWA never receives telephony privileges;
   the native app never hosts the Grogoni web UI. This is a security and Play-policy decision, not
   an oversight. See §3.
2. **The native app is an SMS execution node, not a WebView client.** It does not render
   `apps/web` inside a WebView. There is no `capacitor.config.ts`, no native bridge, no native
   contacts provider integration, no BLE, and no WebView origin allowlist because there is no
   WebView.
3. **Contacts, BLE, and the `SHOP123` namespace routing described in the directive are absent**
   (see §5 for the per-capability matrix). `READ_CONTACTS` is declared and requested but no
   `ContactsContract` read path exists in Kotlin.
4. **The browser-side Android installation prompt described in Part C/§6 does not exist.** `/install`
   is a static explainer; there is no Android UA detection gate, no "Install APK" call to action
   gated by release availability, and no dismissal persistence scoped to native (only the PWA
   prompt has dismissal persistence today).

> **Update (Phase 1, implemented):** the browser-side Android native-install experience from
> Part C/§6 now exists, gated on a real release manifest. See §6.1 and §9. The remaining blocker is
> the _release identity_ (real keystore + approved application id + fingerprints): until
> `apps/web/public/android/release.json` carries a verified release, the install call-to-action
> stays hidden by design. That is the correct, honest state and not a regression.

The audit below records, per capability, whether it is **Implemented and reusable**, **Partially
implemented**, **Missing**, **Duplicated or conflicting**, or **Blocked by platform restrictions**.

---

## 1. Repository structure and toolchain (audited facts)

| Fact            | Value                                                                                  | Source                                                                          |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Package manager | pnpm 10.28.2                                                                           | `package.json` `packageManager`                                                 |
| Node            | `>=22.19.0 <23.0.0`                                                                    | `package.json` `engines`, `.nvmrc`, `.node-version`                             |
| Workspaces      | `apps/*`, `services/*`, `packages/*`                                                   | `pnpm-workspace.yaml`                                                           |
| Frontend        | React 19 + Vite 6 (`apps/web`)                                                         | `apps/web/package.json`, `vite.config.ts`                                       |
| Backend         | Fastify (`services/api`), Drizzle ORM, Neon Postgres                                   | `services/api/package.json`, `drizzle.config.ts`, `infra/db/`                   |
| Tests           | Vitest (root `tests/`), Playwright (`e2e/`), JUnit + AndroidJUnit (Android)            | `vitest.config.ts`, `playwright.config.ts`, `apps/android/app/build.gradle.kts` |
| Android         | Native Kotlin (`com.android.application` + `kotlin.android`, AGP 8.7.3, Kotlin 2.0.21) | `apps/android/build.gradle.kts`                                                 |
| Android app id  | `market.grogoni.app`                                                                   | `apps/android/app/build.gradle.kts`                                             |
| Capacitor       | **absent by design**                                                                   | grep: only mentions are "not a Capacitor" in docs                               |

Root scripts relevant to Android already exist: `android:release:apk`, `android:identity:gate`,
`android:identity:verify`, `android:legal:gate`, `android:legal:verify`,
`android:release:assetlinks`. `ci` already runs `android:identity:verify` and `android:legal:verify`.

---

## 2. Upstream projects reviewed (and the license/pattern decision)

Per the directive's requirement to study upstream before adopting patterns or code.

| Upstream                      | What was studied                                                                                                                                               | Decision for Grogoni                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ionic-team/capacitor`        | WebView host, bridge security model, native plugin model.                                                                                                      | **Do not adopt.** Grogoni's native app is not a WebView client. Introducing Capacitor would mean serving the full PWA inside a WebView that then also needs telephony privileges — the exact privilege-blending the repo avoids. The directive's own "Do not weaken Android security" rule is best honored by keeping the two apps separate. See ADR note in §3. |
| `capcom6/android-sms-gateway` | `SmsManager` multipart send, `SmsSentResultReceiver`/`SmsDeliveryResultReceiver`, default-SMS role handling, command polling, device registration, retry/sync. | **Patterns already adopted in spirit.** Grogoni implements the same primitives natively: `AndroidSmsSender`, `SmsResultReceivers`, `NativeSmsSyncWorker`, replay-guarded command claims. No source copied.                                                                                                                                                       |
| `davidamunga/pesacast`        | BLE foreground service, pairing, framing, PesaCast's SMS broadcast handling.                                                                                   | **Not adopted.** BLE is a genuine gap here (§5, §6). If pursued, borrow the _foreground-service + pairing_ pattern only, not the code, after a license review.                                                                                                                                                                                                   |
| `textbee/textbee`             | Android gateway + message synchronization patterns.                                                                                                            | **Reference only.** Confirms Grogoni's polling/command model is conventional. No source copied.                                                                                                                                                                                                                                                                  |

**License/attribution:** No third-party Android source has been copied into `apps/android`. The
Kotlin under `apps/android` and the backend `native_sms` code are original to this repository.
`THIRD_PARTY_NOTICES` and `THIRD_PARTY_NOTICES.md` exist at repo root as the attribution registry;
any future adoption of BLE code from PesaCast must add an entry there and pass the license check
before merge. This audit does not clear any upstream source for copying.

---

## 3. Architecture decision on the directive's central premise (Capacitor)

The directive says: "Reuse the current frontend. Do not build a second Android UI." and "Integrate
Capacitor into the existing monorepo."

The repository has already decided the opposite, and the decision is documented and defensible:

- `docs/messaging/cross-device-sms.md`: "The owner-facing product remains a React 19/Vite
  progressive web application in `apps/web`. It is **not** a Capacitor, React Native, Flutter, or
  Trusted Web Activity shell for the web app."
- `docs/architecture/unified-commerce-audit.md` (Android row): "Standalone native app, **not
  Capacitor**."
- `docs/android/external-sms-composer-handoff.md`: "It does not host the Grogoni web UI and the PWA
  never receives Android telephony privileges."

**Reasons this is the correct decision and should be preserved:**

1. **Least privilege.** A Capacitor shell would put the full web origin, all web JS, and the
   telephony bridge in one process with one attack surface. Keeping the native SMS node a separate,
   minimal app means the WebView origin that serves arbitrary web content never inherits `SEND_SMS`,
   `READ_SMS`, or the default-SMS role.
2. **Play policy.** The app already qualifies (narrowly) for SMS permissions only because it is the
   default-SMS handler. A WebView wrapper that also wants SMS permissions has a harder Play review,
   not an easier one.
3. **The frontend is already reused at the business layer, not the UI layer.** The native app talks
   to the _same_ backend (`/v1/devices/native-sms*`), the _same_ account/session system (cookie +
   `/auth/pin/login` + `/auth/session/refresh`), the _same_ conversation and message model. "One
   frontend" in the deployment sense is preserved; "the native app embeds the React bundle" is not
   required to achieve the directive's product goals.

**Recommendation:** Reject the Capacitor integration as written. If a future need arises for native
device capabilities _inside the web UI_ (contacts picker in the PWA, etc.), the correct pattern in
this repo is a **narrow typed handoff contract** like the existing `window.GrogoniDevice`, not a full
Capacitor host. This is recorded here as an explicit deviation request requiring owner sign-off
before Phase 1 is reinterpreted.

---

## 4. Capability matrix (directive Part B §3)

Legend: ✅ implemented and reusable · 🟡 partially implemented · ❌ missing · ⚠️ duplicated/conflicting ·
🚫 blocked by platform restriction.

| #   | Capability                                    | Status                       | Evidence / integration point                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Monorepo / package manager                    | ✅                           | `pnpm-workspace.yaml`, root `package.json`                                                                                                                                                                                                                                           |
| 2   | Frontend framework + build                    | ✅                           | `apps/web` React 19 + Vite 6                                                                                                                                                                                                                                                         |
| 3   | PWA manifest + service worker                 | ✅                           | `apps/web/public/manifest.webmanifest`, `apps/web/public/sw.js` (both present), `.well-known/` for assetlinks                                                                                                                                                                        |
| 4   | Existing mobile layouts                       | ✅                           | `MobileChatPanel.tsx`, responsive e2e `e2e/responsive-accessibility.spec.ts`                                                                                                                                                                                                         |
| 5   | Auth + session refresh                        | ✅                           | `services/api` auth; Android `NativeSmsApiClient.refreshSession()`; `GrogoniSessionStore`                                                                                                                                                                                            |
| 6   | Contact sync + identity resolution            | 🟡                           | Backend `phonebook-identity-resolution.md`, `google-contacts-network.test.ts`; web `contacts-access.ts`, `PhoneContactsCard.tsx`. **Android `ContactsContract` read path: ❌** — `READ_CONTACTS` declared + requested (`AndroidPermissionPolicy.kt`) but no provider read in Kotlin. |
| 7   | Message persistence + conversation schema     | ✅                           | `services/api/src/cp2/`, `infra/db/migrations/`, `packages/shared-types/src/index.ts`                                                                                                                                                                                                |
| 8   | Existing SMS adapters                         | ✅                           | `native_sms` provider in `channel-gateway.ts`; Android Kotlin SMS stack                                                                                                                                                                                                              |
| 9   | Agent capability declarations / authorization | ✅                           | `packages/tool-core`, `services/api/src/cp2/domains/agent-runtime/capabilities.ts`, `messaging.send` (high risk, needs confirmation)                                                                                                                                                 |
| 10  | Runtime handoff / device execution targets    | ✅                           | `runtime-handoff-protocol.md`, `cp2_native_execution_hosts`, `/v1/devices/native-sms` device registration                                                                                                                                                                            |
| 11  | Offline persistence + sync                    | ✅                           | Encrypted `NativeSmsStore` (SQLite, `SQLiteOpenHelper`), `NativeSmsSyncWorker` (WorkManager), backend command queue; `packages/offline-runtime`                                                                                                                                      |
| 12  | Notifications                                 | 🟡                           | `LocalSmsNotifications.kt` (Android, generic text only); web `NotificationsSurface.tsx`. No agent-originated native notification channel.                                                                                                                                            |
| 13  | Existing Android / Capacitor code             | ✅ (native) / ❌ (Capacitor) | Full native app in `apps/android`; no Capacitor module                                                                                                                                                                                                                               |
| 14  | Deployment + env vars                         | ✅                           | `render.yaml`, `vercel.json`, `docker-compose.yml`, `.env.example`, `config/`                                                                                                                                                                                                        |
| 15  | Test infrastructure                           | ✅                           | Vitest + Playwright + JUnit + AndroidJUnit; native tests listed in `apps/android`                                                                                                                                                                                                    |

---

## 5. Directive-specific gap analysis (Parts C–L)

### Part C — Android detection & installation (§5–7)

- **Android UA detection:** ❌ `.` `/install` does not gate on Android; `InstallPage.tsx` uses
  `navigator.userAgent` only for a cosmetic `isSupportedPlatform` boolean.
- **Release-availability check before offering APK:** ❌. No call to any release manifest or
  artifact index. The APK panel links to `/` (home), not a verified artifact.
- **"Install Grogoni Android" primary CTA with real release:** ❌. The APK link is a placeholder
  pointing at `/`.
- **Dismissal persistence for a native-install prompt:** ❌. Only the PWA prompt persists dismissal
  (`misc-browser-utils.ts` → `grogoni-install-prompt-dismissed`), unrelated to a native APK prompt.
- **Installed-Capacitor-app suppression:** ❌ (moot — no Capacitor app to detect; the native app
  never loads the web UI, so the prompt can never appear inside it — this requirement is satisfied
  _by construction_ in the native architecture).
- **Verified APK download path:** 🟡. Signing/gate scripts exist; `config/android-release-identity.json`
  is `proposed` with `applicationIdStatus: "proposed"` and null signing fingerprints. No real
  release artifact is checked in or referenced. **Blocked on real keystore + owner approval.**

### Part D — Capacitor (§8)

- ❌ by design (§3). No `capacitor.config.ts`, no plugin registration, no WebView config.

### Part E — Native SMS gateway (§9–12)

- **Receive:** ✅ `NativeSmsReceiver` (`SMS_DELIVER`, `BROADCAST_SMS` permission-guarded) →
  `MultipartSmsAssembler` → `NativePhoneNormalizer` → encrypted `NativeSmsStore.enqueueInbound`.
- **Send (multipart, SIM, states, retries):** ✅ `AndroidSmsSender.sendMultipartTextMessage`,
  `NativeSmsCapability` (SIM readiness), `SmsResultReceivers` (sent/delivery), replay via
  `claimCommand`/`execution_started` guard, uncertain-outcome → `SMS_DELIVERY_UNKNOWN` (never blind
  resend).
- **Idempotency at command layer:** ✅ `native_sms_device_commands` unique index on `messageId`;
  `markCommandExecutionStarted` state machine.
- **Default SMS role flow (RoleManager):** ✅ `MainActivity.requestSmsRole()` uses
  `RoleManager.ROLE_SMS` (Q+) / `ACTION_CHANGE_DEFAULT` (pre-Q); `NativeSmsCapability.inspect`
  reports role state. **Does not auto-replace default SMS app.** ✅
- **Play SMS/call-log restriction handling:** 🟡 documented
  (`apps/android/README.md`, `docs/direct-android-installation.md`, `play-legal-readiness` scripts),
  enforcement of distribution policy is process, not code.
- **Agent-initiated SMS approval:** 🟡. `messaging.send` is `high` risk and requires confirmation
  (`tests/runtime-tool-registry.test.ts`); but the directive's specific
  `device.sms.compose/send/read_authorized` tool family **does not exist** — SMS rides the generic
  `messaging.send` with `provider: "native_sms"`. See §7.

### Part F — Unified conversations & identity (§13–14)

- **One inbox / transport metadata:** ✅. `MessageChannel` includes `native_sms`; messages carry
  provider, direction, status, `providerMessageId`, timeout-aware delivery states. Unified
  conversation model in `cp2/`.
- **`SHOP123` namespace routing:** ❌. No parser for a business ID prefix inside an inbound SMS body.
  Inbound SMS is attributed to the business **selected on the device**
  (`GrogoniSessionStore.businessId`), not parsed from the message. This is a deliberate simpler model
  today: one gateway number → one selected business at a time. See §6 for the gap and the risk.

### Part G — Native contacts (§15)

- ❌. No `ContactsContract` read. `READ_CONTACTS`/`WRITE_CONTACTS` are declared and requested
  wholesale in `AndroidPermissionPolicy` but unused for a contacts picker. This is both a **gap** and
  a **permission-minimization concern** (declaring a permission that is not used weakens the privacy
  posture and the Play review).

### Part H — Offline & BLE (§16–17)

- **Durable offline SMS queue:** ✅. SQLite (`NativeSmsStore`) + WorkManager (`NativeSmsSyncWorker`,
  bounded exponential backoff, periodic 15-min recovery). Not `localStorage`. Process-death and
  uncertain-outcome handling documented in `android-native-sms-channel.md`.
- **BLE:** ❌. No BLE code, no `BLUETOOTH_*` permissions. Explicitly evaluated as optional in the
  directive; correctly treated as non-required.

### Part I — Native capability bridge (§18–19)

- 🟡. There is **no** `NativeDeviceCapabilities` typed bridge because there is no WebView. Capability
  state is reported to the backend via `NativeSmsApiClient.register()` (role, permissions, SIM,
  telephony) and evaluated by `NativeSmsCapability.evaluate`. Device registration as an execution
  target exists (`/v1/devices/native-sms`). The directive's TypeScript interface is a web-shell
  artifact that does not apply here.

### Part J — Daemon & Luna / agent SMS tools (§20–21)

- **Default agent/model/provider:** ✅ verified by test contract. `tests/openrouter-runtime.test.ts`
  pins `repositoryDefaultRuntimePolicy` to `agentRuntimeAdapterId: "grogoni"`, `modelId:
"gpt-6-luna"`, `executionTarget: "backend"` (OpenRouter). No change introduced by any Android work.
- **Agent SMS tools `device.sms.*`:** ❌ as named. SMS is reachable through `messaging.send`
  (`provider: native_sms`), which already enforces high-risk confirmation. The directive's finer
  `device.sms.compose` / `send` / `read_authorized` / `contacts.search_authorized` /
  `notifications.show` / `network.status` tool set is not present. Introducing them would be **new
  agent surface**, which must not duplicate `messaging.send`.
- **Approval binding to exact args + replay prevention:** 🟡. `messaging.send` confirmation exists;
  device commands are replay-guarded by `claimCommand`. Exact-argument binding for the _proposed_
  `device.sms.*` tools does not exist because the tools do not exist.

### Part K — Auth & security (§22–23)

- **Reuse existing auth in native:** ✅ PIN login, cookie handling, refresh, logout, session
  revocation cancels WorkManager.
- **Keystore-backed secret storage:** ✅ `AndroidSecretBox` (AES-GCM) for cookies, phone numbers,
  message bodies, carrier references.
- **WebView origin allowlisting / bridge hardening:** 🚫/❌ — **moot.** No WebView in the native app,
  so there is no JS bridge to protect. The directive's WebView tasks do not apply. ✅ by construction,
  but must be documented as "not applicable" rather than "done."
- **Inbound SMS treated as untrusted content:** 🟡. Messages are stored and surfaced; there is no
  evidence of prompt-injection shielding _specific to SMS content_ entering agent context. This is a
  real security item to verify (§8).

### Part L — APK build & distribution (§24–25)

- **Reproducible builds, signing config, identity gate:** ✅ scripts + Gradle signing config
  (env/keystore.properties, never committed). Real signing key: ❌ **not yet created/approved**
  (`applicationIdStatus: "proposed"`, `uploadCertificateSha256: null`).
- **Asset links generation:** ✅ `scripts/generate-android-assetlinks.mjs` (needs real fingerprint
  to run in CI gate).
- **Web-to-native install with verified artifact + dismissal:** ❌ (see Part C).

---

## 6. The two highest-value real gaps (recommended priority)

These are the only capabilities in the directive that represent genuine, actionable work rather than
"already done" or "does not apply":

§6.1 **Browser-side Android native-install experience (Part C §5–7, Part L §25) — IMPLEMENTED (Phase 1).**
`/install` now includes a real, gated Android install flow (additive; the PWA path is unchanged):

- **Detection:** `InstallPage.tsx` treats `/Android/i.test(navigator.userAgent)` as a _hint only_
  and only fetches the release manifest when it is true.
- **Release manifest:** `apps/web/public/android/release.json` (schema in
  `release.schema.json`) is the single source of truth. It ships with `"release": null`, so **no
  download is offered until a real, signed release is published**. Publishing means replacing
  `null` with `{ packageName, versionName, versionCode, downloadUrl, sha256, minSdk }`.
- **Validation:** `apps/web/src/android-release.ts` (`loadAndroidRelease` →
  `parseAndroidRelease`) requires an HTTPS `downloadUrl` on the Grogoni origin, the production
  package id `market.grogoni.app`, a positive integer `versionCode`, and a colon-separated
  uppercase SHA-256 fingerprint. Any failure (missing file, network error, bad field) resolves to
  "not published" and the CTA stays hidden — it never fabricates a link.
- **UI:** a nonintrusive "Get Grogoni for Android" card with **Install** (a real HTTPS
  `downloadUrl`, `rel="noopener noreferrer"`, `download`) and **Not now**. The card never
  auto-downloads and never redirects.
- **Dismissal:** `Not now` persists `grogoni.android-install-prompt-dismissed.v1` and the card
  stays hidden. The card is also suppressed once the app is installed.
- **CI guard:** `scripts/verify-android-release-manifest.mjs` (`android:manifest:verify`, added to
  `ci`) validates the file so a bad edit fails CI; `--require-release`
  (`android:manifest:gate`) is the strict pre-submission gate that fails while `release` is null.
- **Tests:** `tests/android-release-manifest.test.ts` covers parsing, host/package/version/SHA
  validation, trust rules, dismissal, the shipped-null default, and the CI script both ways.

What is still **blocked** (see §8.5): producing the real signed artifact and approved identity so
the manifest can carry a non-null release. Until then this is correct: the CTA is hidden.

2. **`SHOP123` inbound namespace routing (Part F §14).**
   Today: one device → one selected business. If a gateway number is shared, or if a customer texts
   `SHOP123 ...`, there is no parser and the message is attributed to the device's selected business.
   This is tenant-safe today only because each device is bound to one business. Any move toward a
   shared gateway number **must** implement namespace parsing + tenant validation on the backend
   before it is safe. Recorded as a **blocking dependency** for any shared-number feature.

---

## 7. Conflicts and what must NOT be built (anti-duplication record)

- ❌ **Do not add Capacitor.** Conflicting with the documented architecture and with least-privilege.
- ❌ **Do not add a second SMS backend or gateway service.** `native_sms` already flows through
  `channel-gateway.ts` and the canonical `cp2` store. Any "SMS adapter service" would duplicate it.
- ❌ **Do not add a `device.sms.*` tool family that re-implements `messaging.send`.** If per-argument
  approval binding for SMS send is desired, extend `messaging.send`'s existing confirmation, not a
  parallel tool. Adding six new high-risk tools without removing/aliasing `messaging.send` for the
  `native_sms` provider would create two authorization paths for the same side effect.
- ❌ **Do not create a second identity, conversation, or message store.** All go through `cp2` and
  `packages/shared-types`.
- ❌ **Do not build BLE unless a concrete device-runtime use case is approved.** It is optional in the
  directive and currently absent; adding it now increases attack surface with no demonstrated value.
- ⚠️ **`READ_CONTACTS`/`WRITE_CONTACTS`/`CALL_PHONE`/`READ_CALL_LOG`/`WRITE_CALL_LOG` are declared but
  only partially used.** For Play SMS/call-log policy this is a liability. Either implement contacts
  usage behind an explicit permission flow, or remove unused declarations. This audit flags it; it
  does not change it.

---

## 8. Open questions requiring owner decision before Phases proceed

1. **Reinterpret Phase 1:** Confirm Capacitor is replaced by "harden and complete the existing
   native node + web install experience" (§3, §6). This is the single biggest divergence.
2. **Default agent/model — RESOLVED by inspection.** `tests/openrouter-runtime.test.ts` asserts
   `repositoryDefaultRuntimePolicy` = `{ agentRuntimeAdapterId: "grogoni", modelId: "gpt-6-luna",
executionTarget: "backend" }`, and `tests/fixtures/local-default-store.ts` documents "Grogoni +
   GPT-6 Luna through OpenRouter (backend)" as the repository default. So **Grogoni Daemon / Luna /
   OpenRouter (backend) is confirmed as the default by test contract.** Remaining verification is
   only that a freshly migrated production DB still seeds this (run `pnpm db:verify-schema` + a
   daemon smoke), not a code question.
3. **Contacts direction:** Implement a native `ContactsContract` picker for the SMS node (fills the
   gap but touches unused permissions), **or** remove the unused contacts/call-log declarations
   (reduces policy risk). Do not do neither.
4. **SMS prompt-injection hardening:** Verify that `native_sms` inbound content entering the agent
   context is fenced as untrusted (Part K §23). If not, this is a security fix worth scheduling
   above the install prompt.
5. **Release identity:** The real keystore, application ID approval, and SHA-256 fingerprints must be
   produced and recorded in `config/android-release-identity.json` (`identityStatus: approved`)
   before the browser can offer a _verified_ native install. Until then, the Install CTA must stay
   hidden — which the recommended implementation already does by design.

---

## 9. Recommended implementation order (revised, evidence-based)

This replaces the directive's Phase 0–7 with one that matches the code:

| Phase                   | Work                                                                                                              | Rationale                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **P0 (done, this doc)** | Audit + upstream review + gap matrix                                                                              | —                                                                                       |
| **P1 (done)**           | Browser-side Android install experience gated on a real release manifest + dismissal (§6.1)                       | Highest-value _missing_ user-facing piece; purely additive to `/install`; safe for PWA. |
| **P2**                  | Decide + execute contacts direction (§8.3)                                                                        | Closes a privacy/policy liability either way.                                           |
| **P3**                  | SMS prompt-injection fencing for agent context (§8.4)                                                             | Security; verify then fix.                                                              |
| **P4**                  | `SHOP123` namespace routing (backend-first, tenant-safe) — **only if** shared gateway numbers are in scope (§6.2) | Blocks any shared-number feature; must be backend + tests before Android changes.       |
| **P5**                  | Release identity finalization (keystore, fingerprints, approval)                                                  | Unblocks verified APK distribution; keeps Install CTA hidden until ready.               |
| **Do not do**           | Capacitor, second SMS backend, parallel `device.sms.*` tool family, BLE (unscoped)                                | Anti-duplication and least-privilege (§7).                                              |

---

## 10. Verification performed for this audit

Static inspection only. The following were **read**, not executed:

- `apps/android/app/src/main/AndroidManifest.xml`, `MainActivity.kt`, `NativeSmsCapability.kt`,
  `AndroidPermissionPolicy.kt`, `NativeSmsStore.kt`, `NativeSmsApiClient.kt`.
- `services/api/src/cp2/domains/messaging/routes.ts` (native-sms route surface),
  `services/api/src/messaging/channel-gateway.ts`, `services/api/src/cp2/store.ts` (native_sms paths).
- `infra/db/migrations/054_android_native_sms_channel.sql`, `.down.sql`.
- `apps/web/src/InstallPage.tsx`, `routes.ts`, `messaging/sms-handoff.ts`, `misc-browser-utils.ts`.
- `config/android-release-identity.json`, `scripts/generate-android-assetlinks.mjs`,
  `scripts/verify-android-release-identity.mjs`.
- Docs: `android-native-sms-channel.md`, `cross-device-sms.md`, `direct-android-installation.md`,
  `external-sms-composer-handoff.md`.
- Tests presence: `tests/android-native-sms-channel.test.ts`,
  `tests/offline-order-reconciliation.test.ts`, `apps/android/app/src/test/...`,
  `apps/android/app/src/androidTest/...`.

**Baseline test run (executed, not assumed):**

```
pnpm vitest run tests/android-native-sms-channel.test.ts tests/openrouter-runtime.test.ts
→ Test Files 2 passed (2)
→ Tests 9 passed (9)
```

This confirms, at the backend contract level: capability registration from reported Android state,
inbound normalization + dedup into the canonical conversation, single-queue offline send + device
ownership enforcement + canonical delivery advance, and Grogoni/Luna/OpenRouter default policy. It
does **not** exercise real telephony.

**Not verified (must be executed, not assumed, before any "passing" claim):** real-device SMS
send/receive, emulator startup, WorkManager background behavior, signing, and a fresh
production-DB seed check. These remain **unverified** here.

---

## Appendix A — Files that an implementer must not duplicate

- SMS transport & routing: `services/api/src/messaging/channel-gateway.ts`, `.../external-channel-adapters.ts`.
- Native device protocol: `services/api/src/cp2/domains/messaging/routes.ts` (`/v1/devices/native-sms*`),
  `.../messaging/store.ts`.
- Schema: `infra/db/migrations/054_android_native_sms_channel.sql`.
- Android send/receive/persist: `apps/android/app/src/main/java/market/grogoni/app/sms/*.kt`.
- Agent authorization: `packages/tool-core`, `.../agent-runtime/capabilities.ts`.
- Web install: `apps/web/src/InstallPage.tsx`, `routes.ts`.

## Appendix B — Known platform restrictions (accurate as of this audit)

- **Google Play:** SMS permissions are restricted to default-SMS-handler apps; call-log permissions
  are separately restricted. Direct APK sideloading does not confer Play eligibility and does not
  bypass Play Protect or Android package-verification prompts.
- **Default SMS role:** On Android 10+ the role is granted only via `RoleManager`; the app must not
  auto-replace the user's messaging app. Below Q it uses `ACTION_CHANGE_DEFAULT`.
- **Background execution:** WorkManager is subject to Doze/App-Standby; the repo uses bounded backoff
  and a 15-minute periodic recovery, not a permanent foreground loop.
- **BLE:** requires runtime `BLUETOOTH_*` permissions on Android 12+ and foreground-service types;
  not implemented and not required.
- **Browser cannot see installed APKs:** the web app can only _offer_ a download; Android decides
  installation. UA cannot reliably detect an installed separate app.

---

_End of audit. Proceeding is gated on owner sign-off of §8 (notably the Capacitor reinterpretation),
per the directive's "stop for review before continuing" rule._
