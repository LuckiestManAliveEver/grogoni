# Phase 6 production verification — October 22, 2026

Result: **Phase 6 acceptance failed on the deployed application.**

The primary run exercised `https://grogoni.com/api`, the actual frontend proxy, with three
new disposable accounts and one disposable business. It did not deploy local code or change
production configuration. The frontend reported build
`00c0ddb22f8b0d6c9027806f20a65bc140b514e0`, built at `2026-10-22T15:21:33.434Z`.
The Phase 6 implementation remains in uncommitted local edits; its API metadata and routing
behavior were not observed in this production build.

## Primary run

Evidence: `/tmp/phase6-production/aef1c1ba-e6ae-4545-940f-e71c8c951c10/report.json`.
The run completed at `2026-10-22T19:24:50.724Z` (3:24 p.m. America/New_York).
The report contains 5 passing probes, 14 failing probes and 4 unverified groups. These are
individual probes, not a count of the ten acceptance workflows. Several failures have shared
causes; they must not be interpreted as fourteen independent defects.

| Acceptance workflow                                      | Production result                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. A messages B; B receives and replies                  | Failed: encrypted submission returned `409 e2ee_recipient_unavailable` after registering both devices. Plaintext correctly returned `400 e2ee_required`.                                                                                                                                              |
| 2. Daemon responds within its conversation               | Partial: real `gpt-6-luna` inference returned `PHASE6-PRODUCTION` and the task result survived a reload. The task discarded its conversation association, and no assistant response appeared in the conversation history.                                                                             |
| 3. Switch model while preserving the same daemon history | Unverified. No shared/global binding was changed to simulate an account-specific switch.                                                                                                                                                                                                              |
| 4. Customer message reaches correct business inbox       | Failed: a customer opening a newly registered business via `activeShopId` received `404 business_not_found`.                                                                                                                                                                                          |
| 5. Authorized business agent responds                    | Partial: the focused diagnostic received a real `PHASE6-OWNER-RUNTIME` response from `gpt-6-luna` in an authorized owner session. The shared customer/business thread failed owner access.                                                                                                            |
| 6. Reload restores all three types                       | Partial: the settled authenticated browser restored three existing personal/direct/scoped-business rows before and after reload. Authoritative `conversationType` and `isPermanentDaemon` metadata were absent; labels remained `Chat`, `Buy`, `Buy`. The initial premature screenshot is superseded. |
| 7. Concurrent submissions avoid duplicates               | Failed for conversations: four requests for the same pair produced four distinct conversations. Normal encrypted-message deduplication could not be verified because message submission failed first.                                                                                                 |
| 8. Unauthorized participants cannot read/write           | Passed for stranger access to direct and personal daemon threads: reads and writes returned 404. Business and revoked-membership cases remain unverified.                                                                                                                                             |
| 9. Failed daemon task visible and safely retryable       | Partial: an explicitly failed fixture task remained readable with `PHASE6_TEST_FAILURE`. Its owned retry endpoint returned `404 route_not_found`.                                                                                                                                                     |
| 10. Model/daemon outage does not block direct messaging  | Unverified: production provider/daemon availability was not deliberately disrupted. Direct messaging already failed without inducing an outage.                                                                                                                                                       |

Additional findings:

- Selecting a synced contact using `network-node:<id>` returned `400 INVALID_PHONE_NUMBER`.
  The phonebook sync itself succeeded; conversation creation rejected the node recipient.
- The direct and daemon API views had no `DIRECT` / `DAEMON` type metadata. The type assertions
  stopped at that mismatch, so the main probe alone does not independently prove whether every
  legacy direct thread has an agent participant or runtime binding.
- The daemon accepted a submission containing another account's conversation ID, but discarded
  the association metadata. This proves absent association validation/support, **not** that a
  caller obtained access to the other account's messages or model context.
- A normal authenticated session could read completed and failed task records. Task persistence
  is functioning; projection into conversation history and owned retry are separate missing paths.
- No real push subscription was registered. Notification receipt, membership revocation,
  concurrent requests across identified workers, and an induced provider outage remain unverified.

## Follow-up diagnostics

Final diagnostic evidence:
`/tmp/phase6-production/331b5a9c-38e4-4184-bfce-cdcb353dae37/diagnostics.json`.
It contains five passing probes, five failing probes and three observations. It is a separate
run from the primary matrix, not additional independent acceptance workflows.

- Recipient encryption-device access returned `404 conversation_not_found`.
- Sender enumeration contained only the sender's device. The recipient's enumeration could not
  succeed. Combining the two actual registration records and supplying a recipient scope hint
  still resulted in `409 e2ee_recipient_unavailable` on submission.
- Standard customer business creation again returned `404 business_not_found`. Supplying an
  additional `businessId` equal to `activeShopId` allowed creation and customer message persistence.
  This isolates a request-scope dependency; it does not make the standard client flow pass.
- Even with that diagnostic conversation persisted, the actual business owner's inbox omitted it
  and reading it returned `404 conversation_not_found`. The customer-to-business reply path failed.
- Authorized inference in a separate owner session returned `PHASE6-OWNER-RUNTIME` from
  `gpt-6-luna`. This proves the owner runtime works, not customer-thread authorization or delivery.
- The settled Chromium check verified `/api/auth/bootstrap` and inbox HTTP 200, waited for rows,
  and observed three rows before and after reload. It showed the scoped customer conversation,
  direct thread and personal agent thread with legacy labels `Chat`, `Buy`, `Buy`. It did not
  verify account-home filtering, model switching, or complete typed conversation UX.

The initial browser screenshot was taken before inbox data had settled. **Do not interpret it
as proof that production fails to render or reload existing conversations.** The final diagnostic
supersedes that observation. Its screenshots are:

- `/tmp/phase6-production/331b5a9c-38e4-4184-bfce-cdcb353dae37/before-reload.png`
- `/tmp/phase6-production/331b5a9c-38e4-4184-bfce-cdcb353dae37/after-reload.png`

The combined machine-readable report is [saved beside these notes](phase-6-production-2026-10-22.json).

## Cleanup and reproduction

The primary run removed all three fixture accounts and the fixture business, then verified that
none of those account IDs remained. The cleanup helper also removes their sessions, messaging
records and daemon tasks. Each diagnostic run performs the same fixture-scoped cleanup. The final diagnostic removed its
two accounts and one business and verified that none of those account IDs remained.

Primary command:

```bash
node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/test-phase6-production.mjs --live
```

Focused diagnostic command:

```bash
node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/diagnose-phase6-production.mjs --live
```

Both scripts require outbound network access. They use the existing production API and Neon
credentials, keep cookies/keys out of reports, and delete only IDs created by their own run.
Neither script deploys code, changes shared model bindings or changes provider configuration.
