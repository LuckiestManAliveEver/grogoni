# PWA commerce readiness — final review of this implementation batch

Review date: 15 November 2026. This is implementation evidence, not production certification.
The reviewed code is on `main`. Uncommitted reply-version/chat modernization work was preserved
and excluded from the isolated validation snapshot and these commits.

## Implemented controls

| Checklist area             | Result                                                                                           | Evidence                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 4. Canonical PWA           | Browser application established as canonical                                                     | `bcc8c6a0`; architecture/pwa-first.md                                    |
| 5. Manifest                | Identity, scope, shortcuts and real PNG dimensions audited                                       | `2ea8671d`; pwa-installability tests                                     |
| 5. Cache privacy           | API exclusions, anonymous shell installation, private/no-store rejection, HTTP no-store defaults | `36d743b8`, `8b39f911`, `41e971d2`                                       |
| 5. Offline regression      | Production no-cache HTML can populate the anonymous offline shell                                | `a52080b8`; service-worker lifecycle regressions                         |
| 8. Dependency security     | Patched all production advisory findings; static-plugin callback adapted                         | `6002eb87`, `d23dd265`                                                   |
| 8. Browser security        | Production HSTS and matching restrictive CSP on Vercel/API-hosted HTML                           | `ba599252`, `62672dd1`; Chromium CSP integration tests                   |
| 8. Secret scanning         | Automated scanning and exact-fingerprint non-secret triage                                       | `787c3dde`, `2e6a93c6`; secret-scan-triage.json                          |
| 22. Durable acknowledgment | Pending persistence returns 503 and withholds uncommitted auth cookies                           | `485ee08a`; api-persistence-ack tests                                    |
| 23. Runtime regressions    | Missing email-error export restored, MCP budget assertion corrected, native panel restored       | `80ddfa5f`, `7909eec8`, `deb453b3`; startup/recovery/MCP/native UI tests |

## Verification

- Fresh production dependency audit: zero findings at every severity.
- Production web build: passed. API and web TypeScript checks: passed in the isolated snapshot.
- Browser CSP/static/HSTS tests: 6 passed, including an actual Chromium inline-script rejection.
- Bundle budgets: passed; initial JavaScript 103.07 KiB gzip, initial CSS 24.83 KiB gzip,
  owner route 181.48 KiB gzip. Some optional chunks still trigger Vite's large-chunk warning.
- Full snapshot run: 558 test files; 3,813 tests passed, 8 failed, 374 skipped.
- All failing suites then passed in a serial rerun: 51 tests. The failures were one stale MCP
  budget assertion, six assertions against a native panel replaced by a merge stub, and one
  media integration timeout during the concurrent build/test workload. No timeout ceiling was
  increased to obtain the passing rerun. The panel was recovered from its earlier checkpoint.
- The isolated snapshot excludes uncommitted feature work. This is a full run plus targeted
  failure reruns; it is not represented as a second, entirely green full-suite invocation.

## Open release conditions

A repeat current-branch historical scan still reports five unsuppressed example-credential
findings. The retired inference service is absent and its old configuration is rejected in the
current source. External shutdown/credential rotation still needs verification. No blanket secret
baseline or directory exclusion was introduced.

PostgreSQL failure/concurrency/restoration tests, real payment/refund verification, two-physical-
device encryption tests, low-end hardware/browser validation, independent security review and
legal/provider approvals are not certified by this work. H1 through H5 and milestones A through C
remain open. The acknowledged-write deadline fix is not proof of complete transaction durability
or safe multi-instance commerce. Installation/CSP tests are not proof of every browser workflow.

Only narrowly verified requirements are checked in the source checklist. Unchecked requirements
remain open or unassessed; the feature's presence in older code is not evidence that it passes.

## Subsequent verification

The [database continuation](pwa-commerce-readiness-database-review-2026-11-15.md) adds real local
PostgreSQL testing, durability/rollback fixes, a successful logical backup restoration and the
reviewed reply-version integration. It also records the integrated-build budget regression and
its verified workspace-loading fix. Earlier snapshot numbers above remain historical.
