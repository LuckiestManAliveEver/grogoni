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

## Section 22 — acknowledge only confirmed writes

Fixed the API response deadline path: a stalled persistence queue returns HTTP 503 with
`PERSISTENCE_CONFIRMATION_PENDING` and removes authentication cookies. The write can still finish
in the background; callers must inspect state and reuse their idempotency key on retry. Runtime
handoffs retain their existing `RUNTIME_PERSISTENCE_PENDING` code. Normal success remains blocked
until the flush resolves. This replaces the previous deadline behavior that returned success
based only on process memory.

Verification: API acknowledgment barrier, runtime handoff protocol and persistence boundary:
21 tests pass, including delayed success, stalled mutation, stalled login and failed write cases.
This fixes one acknowledged-write-loss path; PostgreSQL crash recovery, all mutating GETs, and
multi-instance concurrency still require verification before section 22 can be certified.

## Section 5 — explicit offline shell privacy and interruption recovery

The separate opt-in shell installer now requests its manifest and resources without account
credentials and refuses private/no-store, redirected, opaque, cookie-setting or Vary responses.
It validates declared download size, file bounds, duplicate entries and shell content type.
Immutable assets install before the root HTML, so an interrupted download does not replace the
previous shell with references to absent new assets. Pinned OCR/model artifact downloads already
omit credentials and verify content hashes; they do not cache arbitrary application responses.

Verification: 10 offline-shell privacy/recovery tests pass. Installed-browser eviction and crash
recovery remain separate acceptance tests. Network-first shell caching and explicit user-requested
offline downloads intentionally differ: an anonymous static shell marked no-cache may be saved
by the explicit offline installer; private and no-store responses are always rejected.

## Section 8 — dependency and secret scanning

Implemented a dedicated security workflow for pushes, PRs, weekly and manual runs, with
read-only permissions, a commit-pinned Gitleaks action and production dependency auditing.
[Configuration and initial findings](../security-scanning.md) record the commands and results.
Local scans executed against real history and registry data: 70 untriaged historical secret-rule
findings; 22 high production dependency advisories. Findings remain release work, not passing
security certification. No scanner exclusions or vulnerability ignores were introduced.

## Section 5 — HTTP cache privacy

API responses now default to `Cache-Control: no-store` and `Pragma: no-cache`, including errors,
unmatched routes and downloads without an explicit static policy. JSON responses always receive
no-store even if a handler supplies another policy. Static bundles retain their explicit caching
policy. This complements the service-worker and offline installer exclusions.

Verification: API cache privacy and authentication security-hardening suites: 11 tests pass.

## Section 5 — production shell cache-policy regression correction

Anonymous installation now permits storing the known static shell when production sends
`no-cache, must-revalidate`; ordinary navigation remains network-first. The previous blanket
no-cache rejection could leave a production install without HTML for an offline fallback.
Private/no-store, redirected, opaque, cookie-setting and Vary responses remain excluded.
Runtime static-asset caching still rejects no-cache. The exception applies only to the fixed
shell allowlist fetched with omitted credentials, never navigation responses or APIs.

Verification: production-policy regression tests cover an offline navigation after anonymous
installation and rejection of private/no-store shells, alongside the existing lifecycle tests.

## Section 5 — manifest audit

Audited stable application identity, browser entry-point linkage, installation scope, shortcuts,
standalone display, and icon availability. Automated checks now inspect PNG signatures and real
image dimensions against the manifest rather than trusting filenames. The description reflects
the browser-first messaging and commerce application. Four installability tests pass.
The installability test no longer depends on the presence of an uncommitted update-notice component;
update behavior is covered separately by registration/lifecycle tests.

## Section 8 — dependency advisory remediation

Updated Fastify in API, sync and computer-runtime services to the patched 5.12 series, upgraded
the static-file plugin, and pinned safe minimums for URI parsing, XML parsing, brace expansion and
IP-address parsing. The isolated committed-manifest dependency graph reports zero production
advisories at every severity. The working lockfile retains pre-existing UI dependency additions;
only the security graph is staged in this commit.

Verification: 49 targeted tests pass across authentication, persistence acknowledgments, HTTP
cache privacy, document imports, file delivery and inference-provider security. Workspace packages
build in the isolated checkout. A stable full-suite run is underway separately; it is not yet a
passing release gate.
