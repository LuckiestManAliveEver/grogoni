# CP0 Risk Register

Status: passed
Date opened: 2026-07-01
Date passed: 2026-07-01

## Risk Ratings

- Probability: low, medium, high
- Impact: low, medium, high, critical
- Status: open, accepted, mitigated, closed

## Risks

| ID      | Risk                                                                             | Probability |   Impact | Status        | Mitigation                                                                                                                                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------- | ----------: | -------: | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP0-R01 | The project tries to build all architecture goals in MVP.                        |        high |     high | open          | Keep MVP scope explicit. Marketplace, TIEL, full digital twin, and advanced forecasting are post-launch.                                                                                                                                                                  |
| CP0-R02 | AI harness gains direct access to business mutation paths.                       |      medium | critical | open          | Require all mutations through Grogoni tools, Business Runtime validation, verification, events, and audit logs.                                                                                                                                                              |
| CP0-R03 | llama.cpp is forced into the first PWA before device feasibility is proven.      |      medium |     high | open          | Start with rule parser and cloud fallback. Add llama.cpp behind `ModelProviderAdapter` later.                                                                                                                                                                             |
| CP0-R04 | Offline sync corrupts payments, invoices, or inventory.                          |      medium | critical | open          | Implement authoritative conflict rules. Block auto-resolution for money, tax, invoice totals, discounts, and product quantities.                                                                                                                                          |
| CP0-R05 | M-Pesa webhook trust is implemented incorrectly.                                 |      medium | critical | open          | Never trust client status. Verify webhooks, idempotency keys, signatures, and transaction references.                                                                                                                                                                     |
| CP0-R06 | UI becomes dashboard-heavy and violates chat-first promise.                      |      medium |   medium | open          | Make every key workflow reachable from chat or quick action. Use cards/forms for confirmation and correction.                                                                                                                                                             |
| CP0-R07 | Low-end Android performance target is missed.                                    |      medium |     high | open          | Keep PWA shell small. Test early on 1 GB/2 GB devices or emulators. Delay heavy local AI.                                                                                                                                                                                 |
| CP0-R08 | Swahili and mixed-language support is treated as late polish.                    |      medium |     high | open          | Include Swahili in parser/eval datasets from CP4 onward.                                                                                                                                                                                                                  |
| CP0-R09 | Duplicate and stale documents confuse implementation.                            |        high |   medium | mitigated     | `documentation/README.md` now defines source authority and excludes broken placeholder.                                                                                                                                                                                   |
| CP0-R10 | Current folder cannot create Git checkpoint tags through the normal `.git` path. |        high |     high | closed (moot) | Correction: the `.repo.git` workaround was never actually created (no such directory exists, no tags exist). The current checkout's `.git` is a normal writable repository, so this risk no longer applies; create checkpoint tags directly against `.git` going forward. |
| CP0-R11 | Marketplace work starts before product-market fit.                               |      medium |     high | open          | Enforce Master Control trigger conditions before CP17.                                                                                                                                                                                                                    |
| CP0-R12 | TIEL blocks core commerce delivery.                                              |      medium |     high | open          | Treat TIEL as post-core-commerce hardening unless a specific payment/compliance dependency requires earlier work.                                                                                                                                                         |
| CP0-R13 | General-purpose agent tools create security exposure.                            |      medium | critical | open          | Disable shell/filesystem/browser tools for merchant-facing agents. Expose only Grogoni-owned tools.                                                                                                                                                                          |
| CP0-R14 | Rollback discards legally important records.                                     |      medium | critical | open          | Preserve events. Do not silently discard payment, invoice, tax, or inventory records. Prefer feature flags over destructive rollback.                                                                                                                                     |

## Immediate Risk Actions

Carried into CP1:

1. Resolve Git repository status.
2. Choose implementation stack.
3. Create feature flag policy.
4. Define tool permission schema.
5. Define local and cloud data ownership boundaries.
6. Decide whether the first implementation repository is this folder or another extracted source tree.
