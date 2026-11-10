# PWA commerce readiness implementation evidence

Specification: [10 November 2026 checklist](../architecture/pwa-commerce-readiness-checklist.md).
The supplied baseline `5992c3a` is historical; work began from `7db30a3d` with pre-existing
uncommitted changes. Those changes are not evidence of completed checks and are excluded from
these commits. Every requirement remains open unless this ledger records its verification.

| Requirement                                                      | Status                           | Evidence                                                                                                       | Verification                                                                                                |
| ---------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 4. Establish `apps/web` as the canonical user-facing application | Complete (architecture decision) | [Canonical browser application](../architecture/pwa-first.md); existing `dev:web` and production build scripts | Checked root and web package scripts and browser entry point; no native build in production workspace build |

## Section 5 — sensitive cache protection

Implemented: API routes (including public storefront APIs) are network-only; private exclusions
run before navigation and explicit-offline lookups. Installation requests omit credentials.
Runtime caches reject private/no-store/no-cache, redirected, opaque, Set-Cookie and Vary responses.
Only clean root navigation can refresh the shared HTML shell; callback and query-bearing HTML
cannot replace it. Cache version 14 removes prior public API caches on activation.

Verification: service-worker lifecycle, policy and push suites: 40 tests pass. Other offline
stores have separate policies and are not certified by this change. The section 5 requirement
remains open pending review of those stores.

## External verification dependencies

Independent cryptographic/security review, two-physical-device encryption testing, legal review,
provider onboarding, a real payment/refund, and H5 with independent businesses require external
participants or configured services. They remain open. Automated mocks cannot satisfy those gates.

No milestone or harness gate is certified by this ledger.
