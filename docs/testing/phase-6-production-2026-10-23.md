# Phase 6 production verification — October 23, 2026

Production: `https://grogoni.com`; API version 95; frontend `4471fcbd214a5e29a7f4b5dbdbac61d20e311ed6`.

**Result: 26 checks passed; one browser push-registration check failed.** The complete acceptance gate remains open for actual device push receipt.

## Verified

- Encrypted two-account send/reply/decryption and plaintext rejection.
- Concurrent direct creation in both directions reuses one pair; phonebook selection resolves the same conversation.
- Permanent daemon identity, shared inbox types, history restoration and browser reload.
- Customer/business shared replies, explicit business-agent enablement and real authorized business inference.
- Tenant isolation and removal of business staff read/write/inbox access.
- Authorized daemon association, real inference, server-side conversation projection without a browser, visible failure and owned retry.
- Direct encrypted messaging while an isolated daemon task is failed.
- Real model switching from `gpt-6-luna` to `gpt-oss-20b-openrouter`, preserving the same daemon history.
- All three disposable accounts and the disposable business were removed and removal verified.

## Remaining verification

Actual push receipt is unverified. The production VAPID configuration is installed and the public push-config endpoint is enabled. Chrome rejected PushManager registration with `Registration failed - permission denied`; a separate Firefox attempt failed with `Error retrieving push subscription`. Both browsers were tried against the live application. No notification receipt is claimed.

Global provider outages were not induced. Isolated adapter tests cover model unavailability, unchanged selection after a failed switch, and continued encrypted messaging. The live controlled task-failure check verifies task failure isolation.

## Evidence

The [machine-readable report](phase-6-production-2026-10-23.json) retains every step and its original status, including the failed push-registration check. It contains no session cookies or API keys.

## Local checks

74 focused regression tests and 50 PostgreSQL queue/scope tests passed. Further checks passed 12 messaging/model/delivery tests, the shared-model PostgreSQL regression, and 10 recovery/contact UI tests. API/web/shared-type checks, scoped lint, route coverage and production web build passed. Existing large bundle warnings remain.

## Additional browser control check

A separate production browser run opened the daemon conversation, displayed its saved message,
selected `gpt-oss-20b-openrouter` through the real model dropdown, verified the server selection,
reloaded, and restored the same thread and message. The disposable account was removed and its
removal verified. See the [daemon controls screenshot](phase-6-daemon-controls-2026-10-23.png).
