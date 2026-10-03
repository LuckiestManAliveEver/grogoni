# Routes modularization roadmap

**Status: complete.** All 15 domains extracted. `routes.ts` went from
9,622 lines (one exported function, `registerCp2Routes`, ~8,500 lines,
registering all 307 Fastify routes inline) to 2,139 lines - a thin
composition root that creates the store, derives a handful of
composition-root values (`emailProvider`, `oauthAllowedRedirectOrigins`,
`authAttemptsByIp`, etc.), calls each domain's `registerXRoutes(...)`,
and keeps only the genuinely irreducible CORE auth/session/account/
business/membership routes.

## Why this exists

`services/api/src/cp2/routes.ts` is the HTTP layer's counterpart to
`services/api/src/cp2/store.ts` (see `domain-modularization-roadmap.md`,
completed earlier - all 15 business-logic domains extracted into
`services/api/src/cp2/domains/<name>/store.ts`). `routes.ts` itself had
never been split, even though the store-side logic each route calls into
was already cleanly domain-owned. This roadmap did the same
**in-process modularization** for routes: one `registerXRoutes(app,
store, ...)` function per domain, living in
`services/api/src/cp2/domains/<name>/routes.ts` next to that domain's
existing `store.ts`/`shared.ts`.

## The pattern (established by the first slice: Logistics)

`services/api/src/cp2/route-helpers.ts` was split out first, before any
domain route file existed - the same "move-it-out-first" reasoning that
produced `cp2-error.ts`/`text-normalization.ts` on the store.ts side. It
holds the genuinely domain-agnostic request-parsing and error-response
helpers used across nearly every route: `sendCp2Error`, the string/number/
boolean parsers, `BusinessParams`, and - added incrementally as later
rows found genuine cross-domain need - `ContactRecordBody`,
`StorefrontParams`, `CustomerParams`, `parseAuthChannel`, and
`enforceAuthIpRate`. Every domain route file imports from
`route-helpers.ts`, never from `routes.ts` itself, avoiding a circular
import back into the file being split apart. Final size: 245 lines.

Each domain file follows the same shape: an exported
`registerXRoutes(app, store, ...extraDeps)` function containing that
domain's route registrations, plus domain-local param/body interfaces
and body-parsing helpers used only by that domain.
`registerCp2Routes` calls `registerXRoutes(app, store, ...)` in place of
the routes that used to be inline.

**Two sharing patterns recurred across almost every row:**

1. **"Genuinely shared → route-helpers.ts."** When a type or helper is
   used by two or more domains (or by CORE and a domain), it lives in
   `route-helpers.ts`, not in either caller. Used for `StorefrontParams`
   (CORE + sales + messaging), `CustomerParams` (sales + messaging),
   `ContactRecordBody` (suppliers + sales + the sync-mutation
   dispatcher), `parseAuthChannel` (CORE + otp), and `enforceAuthIpRate`
   (CORE + device-bootstrap, the latter needed it converted from a
   closure over `authAttemptsByIp` into a plain function taking the map
   explicitly).
2. **"Export from the owning domain, re-import into the caller."** When
   a helper is conceptually owned by one domain but called by another
   (usually `routes.ts`'s own `parseSyncMutationPayload`, the offline
   sync-queue mutation-replay dispatcher, or a route that still lives in
   `routes.ts`), the owning domain exports it and the caller imports it
   back. Hit repeatedly: `parseLogisticsBody`/`parseLogisticsStatusBody`
   (logistics, for the sync dispatcher), `decodeReceiptBase64`
   (suppliers, chained through document-imports and commerce),
   `parseDocumentImportBody`/`assertDocumentOcrSignature`
   (document-imports, for suppliers/commerce), `defaultOAuthRedirectUri`
   (oauth, for messaging's connected-mailbox OAuth flow),
   `parseProductBody`/`parseStockAdjustmentBody`/`parseInvoiceBody`/
   `parsePaymentBody` (sales, for the sync dispatcher), and
   `parseRuntimeTurnBody`/`RuntimeTurnBody` (agent-runtime, for
   messaging's `POST /v1/messages`, which parses an embedded
   agent-authored turn).

**Every domain extraction with sync-queue support should grep
`parseSyncMutationPayload`'s `switch` first** - logistics and sales both
had cases there; most domains didn't.

## Domain route slices, in the order actually extracted

| Order | Domain                  | Routes | File        | Coupling found                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ----------------------- | ------ | ----------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Logistics** ✅        | 3      | 132 lines   | Low, confirmed                         | Reference implementation. `parseLogisticsBody`/`parseLogisticsStatusBody` exported for the sync-mutation dispatcher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2     | **Notifications** ✅    | 2      | 63 lines    | Low, confirmed                         | Smallest slice. Zero cross-domain calls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3     | **Passkeys** ✅         | 8      | 209 lines   | Low                                    | `passkeyRelyingParty` closure moved with the domain, no external callers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4     | **Network** ✅          | 11     | 326 lines   | Low                                    | Self-contained, as predicted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 5     | **Suppliers** ✅        | 17     | 467 lines   | Medium, confirmed                      | `decodeReceiptBase64` exported for document-imports/commerce chain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 6     | **Document imports** ✅ | 10     | 527 lines   | Medium, confirmed                      | `parseDocumentImportBody`/`assertDocumentOcrSignature`/`ProductCatalogueImportBody` exported for suppliers/commerce.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7     | **Commerce** ✅         | 18     | 535 lines   | Medium, confirmed                      | Product-captures route needed document-imports's guard, imported per the plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8     | **OAuth** ✅            | 21     | 513 lines   | Medium, confirmed                      | `defaultOAuthRedirectUri` exported - later needed again by messaging (row 12), not just at extraction time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9     | **Compliance** ✅       | 20     | 897 lines   | Low-Medium, confirmed                  | Large single-use body-parser cluster moved wholesale, no cross-domain routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 10    | **Sales** ✅            | 26     | 652 lines   | Medium-High, confirmed                 | Least contiguous domain to date at the time - interleaved with CORE's public-storefront handling, messaging's channel-link-grant, and a network-invites cluster. `StorefrontParams`/`CustomerParams` moved to `route-helpers.ts`; a **pre-existing duplicate `CustomerParams` interface** (declared twice verbatim in `routes.ts`) was found and consolidated as a side effect. `parseProductBody`/`parseStockAdjustmentBody`/`parseInvoiceBody`/`parsePaymentBody` exported for the sync dispatcher. `tests/frontend-user-guidance.test.ts`'s `saveProductFieldSchema`/`product_fields_not_implemented` assertions repointed to the new file.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 11    | **Agent-runtime** ✅    | 37     | 1,605 lines | Medium-High, confirmed                 | Split into two widely separated clusters (AI-models/agent-model/browser-inference/profile, then runtime sessions/turns much later) - combined into one `registerAgentRuntimeRoutes` call. `parseRuntimeTurnBody`/`RuntimeTurnBody` exported - needed by messaging (row 12), confirming the row-11 prediction. mcp-tokens had zero coupling as predicted (it has no routes in this file at all).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12    | **Messaging** ✅        | 40     | 1,525 lines | High, confirmed - the largest slice    | Also split into two clusters, the second tightly interleaved with CORE/sales/network routes. Grepped every messaging-only identifier and every other domain file for the 42 `MessagingDomain` store-method names before concluding nothing needed exporting - clean extraction, nothing to re-import elsewhere. `PATCH /v1/session/context`'s internal call into `messagingDomain.requireAccountConversation(...)` is store-side only, confirmed to need no route-level change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 13    | **OTP** ✅              | 8      | 234 lines   | **Low, not High as predicted**         | The "high coupling, shared-closure entanglement" flag was a false positive from route-name pattern-matching, not from reading the route bodies. The 5 CORE routes assumed to share `requestOtpForBody`/`verifyOtpForBody` (`/auth/email/verification/start`, `/auth/identity/email/start`, `/auth/recovery/start`, `/auth/recovery/verify`, `/auth/identity/email/merge/verify`) turned out to call `store.requestOtp`/`store.verifyPendingEmail`/`store.verifyEmailIdentityMerge` directly, with their own bespoke orchestration - ordinary cross-domain store calls. The two closures had exactly 8 call sites, all inside this domain's own routes - a fully self-contained extraction with nothing to export back. `parseAuthChannel` moved to `route-helpers.ts` (genuinely shared with CORE's identify/PIN-login/merge routes). **Lesson reconfirmed**: verify a flagged coupling by reading the actual route bodies before believing the flag, the same lesson the doc already stated in its "Ground rule" section and had proven once already on the store.ts side. |
| 14    | **Device bootstrap** ✅ | 3      | 166 lines   | **Low-Medium, smaller than predicted** | `store.prepareDeviceSession`/`readDeviceSessionMetadata` were non-issues (ordinary store method + already-shared helper). `enforceAuthIpRate` was the one real shared closure (9 other CORE routes call it) - moved to `route-helpers.ts` as a plain function taking `authAttemptsByIp` as an explicit parameter instead of closure capture, mirroring the OTP row's `requestOtpForBody`/`verifyOtpForBody` treatment. Last domain extracted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**mcp-tokens has no row** - it has 0 HTTP routes in this file; token
issuance lives entirely in the separate `services/api/src/mcp/routes.ts`
file, already its own module. Confirmed at row 11, as predicted.

## What's left in `routes.ts` (irreducible CORE)

Auth/session/account/business/membership routes, plus the shared
composition-root closures and helpers that don't belong to any single
domain: `requireAuthFeature`, `readIdentifier`, `normalizeAuthPhone`,
`handleSessionRefresh`, `parseSyncMutationPayload` and its dispatcher
siblings, `businessPermissions`/`parseOptionalPermission`, and the
`/v1/realtime` + owner-node inference cluster (an unclaimed cluster
related to agent-runtime/inference dispatch, discovered during the
messaging row's research but out of scope for this roadmap - flagged as
a candidate for a future `owner-node`/`inference-broker` domain if
`routes.ts` ever needs to shrink further).

## Ground rule that held for every slice

One domain per PR, same as the store.ts side. Full test suite stayed at
the same pass/skip/fail count before and after every single row: **657
passed / 27 skipped / 1 pre-existing unrelated failure** (the
migration-051 checksum test, unrelated to this refactor) - unchanged
from the first commit to the last. Typecheck
(`pnpm --filter @grogoni/api typecheck`) and lint
(`pnpm exec eslint <changed files> --max-warnings=0`) were the two
reliable mechanical gates; `tests/frontend-user-guidance.test.ts`'s
literal-string assertions against `routes.ts`'s raw source text broke
exactly three times across all 15 rows (network's
`store.syncConnectedSocialProvider`/`network_provider_sync_not_implemented`,
sales's `saveProductFieldSchema`/`product_fields_not_implemented`, and
OTP's `phone_pin_only`) - each fixed by adding a second `readFileSync` of
the new domain file and repointing the specific assertion, never by
changing product behavior.

No live-Postgres re-verification was needed for any row - this refactor
only moved HTTP route registration and request parsing, never touched
`Cp2Snapshot`, `snapshot()`, `hydrateSnapshot()`, or any persistence
sweep. The regular test suite (which exercises routes end-to-end via
`app.inject(...)`) was the correct and sufficient gate throughout.
