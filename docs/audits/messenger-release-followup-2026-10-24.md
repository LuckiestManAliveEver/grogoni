# Messenger production release follow-up — October 24, 2026

**Current production release:** `messenger-release-20261024-context` on [grogoni.com](https://grogoni.com), with Supabase API version 99. Real phone-viewport/desktop encrypted messaging, business replies and bounded parallel reads passed; fixture deletion was verified. Physical Android/PWA testing is deferred because no device is available. See the final contextual-release evidence at the end of this report.

Follow-up to [the remediation report](messenger-remediation-2026-10-24.md).

## Deployment access and publication

The refreshed Vercel credential successfully accessed `grogoni-frontend`. It is stored only in the ignored private local environment, mode 0600. No credential matches were found in reviewable repository files. Vercel had no Supabase management-token environment entry requiring replacement. Repository and CLI credential-store checks were completed in the previous report.

Following [Vercel’s documented deployment workflow](https://vercel.com/docs/deployments/overview), the prepared static frontend was uploaded with SHA references using `scripts/deploy-vercel-frontend.mjs`; deployment `dpl_C3oRFbk9XcQZVH8iyEUTkHtsEVYz` reached READY and was assigned `grogoni.com`, `www.grogoni.com` and the project domain. Normal project source-build settings were checked afterward and remained unchanged. Public build metadata matched the artifact; `/api/health/ready` returned JSON 200. Supabase production API remains version 99.

The four public authentication-entry checks passed: desktop and 390px phone signup and login discovery, including real API requests and fixture cleanup. These are entry checks, not complete public-form signup or physical Android acceptance.

## Additional production browser defect

Strict live inbox probes found all three saved conversation types visibly present before and after reload, on desktop and phone viewport. Both probes then failed their no-page-errors assertion because the client called `WebSocket.close(1011)`, which browsers reject. Transport selection also incorrectly chose WebSockets for absolute `https://grogoni.com/api`, despite already choosing HTTP polling for relative `/api` and Edge-function URLs.

The client now identifies absolute API proxy paths and uses HTTP polling; direct WebSocket backends remain supported. Its error close uses browser-valid private code 4000. Nine realtime tests passed, covering transport selection, reconnection after an error, teardown, authenticated socket admission and account isolation. Web typecheck, scoped lint and build validation follow below.

## Reliability work

Fixture cleanup previously made per-table database round trips while holding the global exclusive store lock, potentially blocking interactive requests long enough to hit their ten-second lock timeout. `scripts/live-fixture-cleanup.mjs` now batches ordered deletes, derives schema metadata in one request, and retains transaction scope, parameter binding and account isolation. Five real PostgreSQL tests passed, including removal of one account's handoff records while preserving another account's records.

A fresh isolated production authorization/business-inference probe passed all three checks with cleanup verified. Its measured cleanup lock interval was **6,297 ms**. This is one measured duration, not a worst-case guarantee. Disabled business-agent execution was rejected, customer enablement was forbidden, owner execution produced a real `gpt-6-luna` response with no error/fallback, and foreign DIRECT/DAEMON reads and writes returned 404. [Results](../testing/messenger-release-2026-10-24/production-reliability-report.json).

The earlier 503 overlapped a separate cleanup's global lock. That correlation and the cleanup improvement do not independently prove every earlier 503 had the same cause. The earlier exact-token model mismatch passed isolated reruns; processing/model metadata is now retained by future probes. No unsupported universal reliability guarantee is made.

## Physical-device acceptance

The Android SDK and ADB are present, but `adb devices -l` reports no connected devices. Physical contact-permission allow/deny/cancel, native adapter integration, installed-PWA lifecycle and actual notification receipt remain unverified. Desktop/phone-viewport browser automation does not close these physical-device checks. Automated desktop push subscription was previously denied.

## Corrected frontend deployment

Deployment **`dpl_5B8R2pV4jy8gjSZq7voYnJLohqYs`** reached READY and is assigned to the production domains. Public `build-meta.json` now reports **`messenger-release-20261024-realtime`**, and the production API readiness response remains JSON 200. Web TypeScript, scoped ESLint and the corrected production build passed. The build retains the pre-existing large-chunk warning. [Deployment](../testing/messenger-release-2026-10-24/final-frontend-deployment.json), [source/artifact hashes](../testing/messenger-release-2026-10-24/release-source-snapshot.json).

The user confirmed no Android device is available. Physical-device acceptance remains explicitly deferred rather than treated as passed. Final post-fix live inbox results follow below.

## Final live results

The corrected production frontend passed both strict saved-inbox probes: **1280px desktop and 390px phone viewport**, with all DAEMON, DIRECT and BUSINESS rows visibly present, conversation search visible, successful reload restoration, and **zero page errors**. Both disposable accounts and their business were removed and deletion verified. [Final live report](../testing/messenger-release-2026-10-24/final-inbox-report.json), [desktop screenshot](../testing/messenger-release-2026-10-24/final-inbox-1280.png), [phone screenshot](../testing/messenger-release-2026-10-24/final-inbox-390.png).

Validation: nine realtime tests, five PostgreSQL scope/cleanup tests, four public authentication-entry checks, two live inbox checks, web TypeScript, scoped ESLint, production build and diff whitespace checks passed. The published artifact contained zero matches for either private deployment token. Source remains in the working tree; no Git commit is claimed.

Remaining acceptance: physical Android contact permissions/native adapter and installed-PWA push receipt are unverified because no device is available. Earlier intermittent backend/model observations remain monitoring items; repeated isolated authorization and real inference checks passed. The frontend permission block and the reproduced browser realtime exception are resolved.

## Continued messaging validation

A real two-browser send/reply probe initially timed out waiting for an active inbox row on the phone while its drawer was closed. That selector failure **does not establish a failed conversation selection**; both fixtures and the business were deleted and verified. The probe now opens the phone inbox before verifying selection and closes it before typing. [Original probe result](../testing/messenger-release-2026-10-24/two-browser-initial-probe-report.json).

Independent source/regression review confirmed that initial account-wide session restoration could override an explicit conversation URL. Initial restore now requests `/v1/session/context?conversationId=...` for that route, while refresh-only retries continue updating data without moving the user. Twenty-nine session restoration/retry/staff-context tests passed, including explicit-link precedence and late-response navigation protection. Web TypeScript, lint and production build passed. Publication and corrected two-browser validation follow below.

The conversation-link fix was published as `messenger-release-20261024-links`, deployment `dpl_BFZmSv4en89c4UZ8v5xkZWo2No8i`; the public domain confirmed that marker. One upload attempt failed DNS resolution before deployment creation; its retry succeeded.

The corrected real two-browser probe then passed **all five checks**: encrypted direct send/reply with ciphertext verified in requests and persisted messages; both browsers decrypted after reload; customer and owner exchanged ordinary replies in the same business thread without agent inference; six parallel session/inbox reads returned 200; no browser page errors; and account/business cleanup verified. The checks group messaging, reads, page errors and cleanup into five entries. The cleanup lock measured 5,903 ms. [Report](../testing/messenger-release-2026-10-24/two-browser-report.json). Read samples are bounded observations, not an uptime guarantee.

### Contextual controls

Source review against specification 6.4 found that an empty DIRECT/BUSINESS conversation inherited the assistant greeting, and a shop owner's human chat could expose model-library/runtime controls and command suggestions. Human conversations now retain their contextual header even before the first message, suppress the synthetic assistant welcome, use a neutral message prompt and audience label, and hide composer model/command controls. Explicit authorized business-agent controls remain in the business header, and daemon controls remain available in daemon conversations.

Eight focused composer/home tests passed, including a shop-owning human-chat fixture. Two local browser cases at 1280px and 390px passed, covering empty direct/business headers, neutral prompts, and reload restoration. Web typecheck and scoped lint passed. The final contextual release and public verification follow below.

## Final contextual release and production validation

Deployment **`dpl_4XD93XrZ3DEvc6tKPiC34hHUm3sb`** published build **`messenger-release-20261024-context`**. The public domain returned that marker, and the strict browser probe checked contextual headers, neutral prompts, absent synthetic assistant greetings and hidden model controls in actual human conversations before sending.

The final-release two-browser run passed **all five check groups**: real two-way encrypted direct send/reply with ciphertext verified in requests and stored messages; decryption after reload in both browsers; customer/owner replies in one business thread without agent inference; six parallel session/inbox requests returning 200; zero page errors; and cleanup verified. [Production report](../testing/messenger-release-2026-10-24/context-live-report.json), [phone direct](../testing/messenger-release-2026-10-24/context-live-direct-phone.png), [desktop business](../testing/messenger-release-2026-10-24/context-live-business-desktop.png).

Additional validation: 29 session-context tests, eight composer/home tests, two local desktop/phone browser cases, web TypeScript, scoped ESLint and the production build passed. The explicit-link regression distinguishes account-default context from the requested conversation; its seven-test file was rerun after tightening the fixture and passed. The current artifact contains no private deployment-token matches. [Validation summary](../testing/messenger-release-2026-10-24/continuation-validation-summary.json).

The earlier transient 503/model-response observations were not reproduced by these bounded checks; this is not a continuous uptime guarantee. Physical Android/PWA acceptance remains unverified by agreement, with an executable-by-a-tester [device acceptance matrix](../testing/android-pwa-messenger-acceptance.md). Source changes remain uncommitted in the preserved working tree.

### Final cleanup contention reduction

The final browser run measured a **9,407 ms** cleanup lock interval, close to the API's ten-second lock timeout. The cleanup helper was therefore tightened again: temporary-table/schema setup and account/user/task-ID collection now require only **three database round trips total**, followed by commit in the caller's transaction. All five PostgreSQL scope tests passed again, including an explicit three-round-trip budget, complete fixture handoff deletion and preservation of another account's handoff records. Lint and diff checks passed. This final helper optimization was validated on the isolated local database; no new production duration is claimed. [Cleanup validation](../testing/messenger-release-2026-10-24/cleanup-roundtrip-validation.json).

Physical acceptance remains deferred, not failed, because the user confirmed no device is available. Historical intermittent backend/model observations remain documented monitoring items; the latest bounded production messaging/availability run passed without errors.
