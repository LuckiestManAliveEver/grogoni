# Physical Android/PWA messenger acceptance

Status: **unverified**. On October 24, 2026, ADB found no connected devices and the user confirmed no device was available. Phone-viewport browser results do not substitute for this run.

Use two disposable accounts and a test business. Record device model, Android/Chrome versions, installed/browser mode, production build ID, account/conversation IDs and result evidence. Keep PINs, session cookies and private keys out of evidence. Complete cleanup and verify test accounts/business removal afterward.

| Check                            | Expected result                                                                                                                             | Actual / evidence |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Contact selection allow          | Only explicitly selected contacts import; saved names open the existing direct conversation.                                                | Pending           |
| Contact selection deny/cancel    | No silent import; messaging remains usable and file import/retry remains available.                                                         | Pending           |
| Unsupported picker               | CSV/vCard import remains usable and reports failures accurately.                                                                            | Pending           |
| Phone-first sign-in and return   | Sign in, open all three thread types, background/reopen, then reload without losing conversation identity.                                  | Pending           |
| Real encrypted direct send/reply | Account A sends to B, B reads/replies, A reads; both reload and still decrypt.                                                              | Pending           |
| Business conversation            | Customer and authorized owner reply in the same thread; ordinary messages do not invoke AI.                                                 | Pending           |
| Push permission denied           | App remains usable; it does not claim registration or receipt succeeded.                                                                    | Pending           |
| Installed-PWA push allowed       | A real notification arrives for the other account's message while the PWA is backgrounded; its content follows private-notification policy. | Pending           |
| Notification open                | Tapping notification opens the existing originating conversation, including after a cold launch.                                            | Pending           |
| Installed-PWA lifecycle          | Reopen after background/termination; verify authentication, inbox, encrypted history and current release marker.                            | Pending           |
| Account switch                   | A second account sees its own inbox and drafts; the previous account's cached threads do not appear.                                        | Pending           |

Retain the exact release marker with each result. A passing desktop push subscription or a mocked service-worker event alone does not establish physical Android delivery. If the native contacts adapter is unavailable, record that separately from successful browser-file fallback.
