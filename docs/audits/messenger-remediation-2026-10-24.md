# Messenger remediation — October 24, 2026

**Release update:** refreshed Vercel credentials restored deployment access; frontend publication and further live-browser fixes are tracked in [the production release follow-up](messenger-release-followup-2026-10-24.md). Vercel-blocked statements below describe the earlier remediation stage.

Follow-up to [the original review](mobile-messenger-integration.md). Changes are in the working tree; pre-existing work was preserved. Production API deployment: `api`, version 99; candidate acceptance used `api-candidate`, version 56. This report distinguishes source fixes from production rollout and physical-device acceptance.

## Gap disposition

| Gap | Remediation / remaining evidence                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01 | Restored owner-only durable business-agent toggle and execution checks, including low-level agent writes.                                                                                                                                                               |
| G02 | Revalidate current membership, blocks and conversation deletion at notification delivery and retry. Revoked deliveries become dead letters.                                                                                                                             |
| G03 | Plaintext agent prohibition applies to personal direct threads; authorized BUSINESS agent responses remain supported.                                                                                                                                                   |
| G04 | Restore contact associations in each owner's inbox projection. Private phonebook node IDs are never shared with the other participant.                                                                                                                                  |
| G05 | Server-keyed HMAC contact fingerprints, legacy hydration and explicit database migration utility. Stable server key is required in production. Existing audit HMAC key is the fallback. Migration must use that same key.                                               |
| G06 | Disconnect removes unreferenced owned contact fingerprints and imported identities. PostgreSQL reload tests cover persistence.                                                                                                                                          |
| G07 | Add discoverability preferences, private blocked-contact management and symmetric enforcement in discovery, direct/group creation, writes, connections and push delivery. Private preferences survive authoritative-user hydration.                                     |
| G08 | Deduplicate complete normalized phone numbers; preserve international numbers sharing a suffix. Normalize selected local numbers using the account's country.                                                                                                           |
| G09 | Correct contact transmission/storage wording: identifiers are sent for server matching; fingerprints persist.                                                                                                                                                           |
| G10 | First-run file fallback, explicit partial/failure handling, account-specific dismissal and contact retry.                                                                                                                                                               |
| G11 | Shared injectable contact-access interface plus CSV/vCard fallback. Actual native picker implementation and Android permission flows remain unverified.                                                                                                                 |
| G12 | Physical Android/installed-PWA push receipt and permission denial/cancel require device validation. Browser automation does not establish receipt.                                                                                                                      |
| G13 | Browser probes require actual saved conversation IDs. Added desktop and phone all-three-type inbox/reload acceptance tests. Production frontend remains a separate deployment gate.                                                                                     |
| G14 | Recovery tests updated to current eager task recovery while preserving submit/tool-call assertions.                                                                                                                                                                     |
| G15 | Playwright explicitly targets local API in local browser tests; mobile authentication and buyer/seller navigation pass.                                                                                                                                                 |
| G16 | Original audit retained, this disposition and fresh evidence added.                                                                                                                                                                                                     |
| G17 | Primary inbox includes DAEMON, DIRECT and BUSINESS conversations.                                                                                                                                                                                                       |
| G18 | Isolate invalid model configuration from unrelated API initialization; retry transient session-context failures and prevent Help initialization from delaying inbox loading. Original production 503 has no confirmed root cause; availability still needs observation. |

Additional gaps found and repaired: account-qualified inbox/cache keys and in-flight account-switch guards; overlapping inbox polls; daemon-owner notification exclusion; and server-loaded conversation history for real multi-turn daemon execution. The history loader validates ownership, excludes the current/future messages, and survives runtime restart without a second message store. Conversation-linked inference fails closed when its loader is absent.

## Validation

- Full suite: 425 suites passed, 29 skipped; 2,748 tests passed, 331 skipped. One Help test hit the five-second limit under full-suite load, then passed alone in 734 ms. This is a timeout/retest, not an uninterrupted full-suite pass.
- PostgreSQL focused privacy/context tests: three passed, including scoped reload and reverse blocking.
- Mobile Chromium: three passed. Unified inbox desktop/390px phone: two passed.
- Real provider integration: two checks passed using `gpt-6-luna`, including semantic recall after a fresh runtime and server projection; disposable fixtures deleted and verified. [Report](../testing/messenger-remediation-2026-10-24/real-model-context-report.json).
- API/web TypeScript and scoped ESLint passed. Edge bundle and production web build passed (existing large-chunk warning remains).
- Candidate readiness/database/live checks passed. Extended candidate acceptance and full PostgreSQL integration results are recorded below when complete.

## Deployment and credential status

The supplied Supabase management credential was installed only in the ignored private local environment (mode 0600) and verified against the project API. Repository and all four GitHub deployment environments contain no Supabase management-token secret; workflows do not reference one. Unrelated service-role, public client and database keys were preserved. No management credential is included in frontend code or this report.

The Vercel token authenticates successfully as the expected user, but lists no teams; project listing and project access currently return HTTP 403 for the owning scope `nairbeiraik-6236s-projects`. This prevents updating affiliated Vercel secrets or publishing the frontend until the workspace credential has the required project access. Candidate API deployment alone does not publish frontend changes.

`migrate-contact-fingerprints.mjs` defaults to dry-run and preserves graph/hash IDs. Before applying to production, verify its HMAC secret matches the Edge runtime; do not generate or change the key casually. No new SQL schema is required for private preferences: existing private user JSON stores them.

## Additional live findings and fixes

Candidate version 54 acceptance: 24 passed / 2 failed, with fixture deletion verified. Business inference failed because runtime ownership checks assumed that a shared thread's creator (the customer) must execute the turn. This was repaired across provisioning/resolution and runtime-turn fencing, permitting only current participating business members, preserving the persisted customer identity and strict personal/cross-tenant checks. Seventy-five targeted runtime/membership/handoff tests passed, including a new regression. Version 56 successfully executed the real business model response in that customer thread. Push failed at browser registration with permission denied; actual notification receipt remains open. The live inbox browser step was explicitly skipped because the production frontend is still the earlier build; the report's zero unverified count does not establish that skipped check.

Candidate contact privacy checks passed: discovery preference persisted, opted-out accounts could not be opened by contact discovery, symmetric blocking survived separate requests and prevented reverse creation, and unblocking restored creation. All disposable accounts were deleted and removal verified. Empty PUT/DELETE requests were rejected by the deployed bridge; frontend block controls now send JSON bodies. [Privacy report](../testing/messenger-remediation-2026-10-24/candidate-contact-privacy-report.json).

The full PostgreSQL run initially passed 413 tests, skipped three, and failed four. Three failures required the existing migration-108 opt-in on this isolated test database. The fourth exposed fingerprint ID replacement during phonebook replace sync; identifiers are now retained through replacement and unreferenced hashes pruned afterward. Fifty-one focused contact tests passed; database rerun results follow below.

**Fingerprint migration verification:** local key metadata differed from the deployed key, so no local-key rewrite was attempted. A temporary authenticated Edge job used the existing deployed key and dry-run queried production: **zero legacy phone/email fingerprints remain**. No rewrite was needed, no key was downloaded or changed, and the temporary function was deleted. `migrate-contact-fingerprints-edge.mjs` retains this server-key-safe migration path for future imports. [Dry-run evidence](../testing/messenger-remediation-2026-10-24/contact-fingerprint-migration-dry-run.json).

Database rerun: all four suites passed, **135 tests**. Combined with the other 32 passing suites, all previously failed PostgreSQL cases have passed. The migration opt-in applied only to the isolated local test database.

Candidate version 56 acceptance: **25 passed / one failed** (browser push registration permission denied), disposable fixtures deleted and verified. Business-agent real inference now passes. Browser inbox acceptance was skipped because production frontend has not been published. [Report](../testing/messenger-remediation-2026-10-24/candidate-v56-report.json).

## Production rollout

Production API version **99** is ACTIVE. Live/database/readiness and a routed public request all returned HTTP 200. The first attempt timed out on the initial management read; retry completed successfully. [Deployment evidence](../testing/messenger-remediation-2026-10-24/production-deployment.json). Public-domain fixture acceptance follows below. Frontend source is built and checked but is **not deployed** because the configured Vercel token cannot access the project.

Production-domain acceptance initially recorded **23 passed / three failed**, with cleanup verified. Failures were (1) one 503 instead of an authorization 404 while a simultaneous fixture cleanup held the global exclusive store lock, (2) a business model response that did not satisfy the exact-token assertion, and (3) browser push registration permission denied. The overlap suggests lock contention for the 503 but does not independently prove its cause. A subsequent isolated production probe confirmed foreign-account reads/writes to DIRECT and DAEMON return 404. [Full production report](../testing/messenger-remediation-2026-10-24/production-v99-report.json).

Production discovery privacy, symmetric block persistence, reverse-creation denial and unblock restoration all passed; fixtures were deleted and verified. [Production privacy report](../testing/messenger-remediation-2026-10-24/production-contact-privacy-report.json). Final contact/onboarding/card regressions: **16 passed**.

The isolated production rerun passed **all three checks**, including cleanup verification: foreign reads/writes are denied; disabled business-agent inference is rejected; the customer cannot enable the agent; and the participating business owner receives a real shared-thread response. Model trace: `gpt-6-luna`, provider `openrouter`, processing completed, no error and no fallback. The earlier exact-token mismatch remains a transient observation with no captured processing trace; probe instrumentation now retains that metadata on future runs. [Isolated results](../testing/messenger-remediation-2026-10-24/production-isolated-authorization-report.json), [model trace](../testing/messenger-remediation-2026-10-24/production-isolated-business-runtime.json).

## Remaining acceptance limits

- Frontend fixes are local and build-validated; Vercel denies project access despite authenticating the user. No frontend deployment or Vercel secret change is claimed.
- Physical Android contact selection/permission allow, deny and cancel, native adapter integration, installed-PWA lifecycle and actual private push receipt require device acceptance. Automated push registration is denied here.
- Intermittent 503/maintenance contention and the one production business-model exact-token mismatch remain reliability observations to monitor. Isolated retests passed; no claim of a resolved universal outage cause is made.
- The full-suite Help timeout passed alone; the original aggregate run is retained rather than presented as uninterrupted green.

Working-tree source hashes and base commit are recorded in [source snapshot](../testing/messenger-remediation-2026-10-24/source-snapshot.json). The frontend build marker `messenger-remediation-20261024` labels a local build, not a Git commit. Changes remain uncommitted, including preserved pre-existing edits. Supabase CLI credential files were absent; no additional local CLI token store required replacement.
