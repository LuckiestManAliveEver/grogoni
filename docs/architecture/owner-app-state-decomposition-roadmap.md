# OwnerApp state decomposition roadmap

**Status: complete.** `OwnerApp` (`apps/web/src/GrogoniApplication.tsx`) went
from 6,521 lines to about 2,050 lines - a 69% reduction. All 20 state domains
identified by the original exploration pass are now their own hooks under
`apps/web/src/hooks/`, plus one `OwnerCoreContext` for the 4 pieces of state
almost every surface reads. `GrogoniApplication.tsx` is now genuinely a
composition root: hook calls, the generic polling/prefetch effect
machinery, `resetClientToStartup`'s irreducible remainder, and
the final shell composition. The view switch lives in `OwnerWorkspace.tsx`,
and chat-composer state and rendering live in `useChatComposerState.ts` and
`ChatComposer.tsx`.

## Why this exists

The prior effort (`frontend-modularization-roadmap.md`) pulled all 34
presentational components out of `GrogoniApplication.tsx` but explicitly left
`OwnerApp` itself untouched - 90 `useState`, 9 `useRef`, 23 `useEffect`,
148 handler closures, 24 feature-state clusters, all still one function.
That roadmap's own closing section named this as the natural next target
and flagged it as a real architecture decision, not a file move: unlike
component extraction, decomposing `OwnerApp`'s state means introducing
custom hooks (this codebase's only local precedent was `useAsyncActions`,
a single small hook) or React Context (zero prior usage anywhere in the
frontend), with genuine UI-visible risk if a dependency gets missed.

## The architecture

**Hooks-only for 20 of 24 clusters, plus one small `OwnerCoreContext`**
(`session`, `grogoniSessionContext`, `business`, `agentSettings`, `view`,
`mode`) for the 4 clusters nearly every surface reads. `ChatSurface` isn't
a peer of the other 15 domain surfaces it wraps - it's their
architectural parent (the workspace switch's result renders
_inside_ `ChatSurface`'s children) - so it had 101 flat props, mostly
identity/business/nav state it only forwarded. Hooks alone don't fix
forwarding through an unrelated parent; only removing the prop entirely
does. A single big `OwnerAppContext` for all 24 clusters was rejected too:
it would reintroduce ambient `this.*`-style reach (any component could
silently start reading state never in its prop contract) and cause
unnecessary re-renders across unrelated domains unless every field were
independently memoized.

`ChatSurface`'s prop count dropped from 101 to ~80 (Phase 16): the
identity/business/agent/nav-derived props moved to `useOwnerCore()` reads
inside `ChatSurface` itself; the remaining ~80 (chat messages,
conversations, cart, buy-feed, domain action callbacks) are genuinely
`ChatSurface`'s own concern and stayed as props. Stated as a deliberate
partial fix from the start, not a claim to have solved "ChatSurface has a
lot of props" in general.

## The two cross-cutting mechanisms

**`useDomainReset.ts`**: a registry - `registerReset(key, fn)` /
`resetAll()` backed by a `useRef<Map>`. Every domain hook registers its own
`reset*` closure; `resetClientToStartup` calls `resetAll()` instead of 55+
inline setters, preceded by `setSession(null)`/`setBusiness(null)` (kept
first and inline - guards elsewhere check `business === null` to avoid a
post-logout repopulation race from an in-flight request).

**`useViewRefresh.ts`**: a registry - `registerRefresh(views[], fn)` /
`refreshersFor(view)`. Each domain hook registers its `load*` against the
view(s) that should trigger it. The generic polling/visibility/online-
listener machinery in `refreshActiveView`'s effect (interval, visibility
change, focus, online listeners) stayed in the composition root - it's
genuinely cross-cutting orchestration - and only its per-domain `if
(view === X)` branches moved out.

## What was extracted, in the order it actually happened

| Phase | Domain                         | Hook file (lines)                                                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundation                     | `OwnerCoreContext.tsx` (47), `useDomainReset.ts` (17), `useViewRefresh.ts` (29)  | Provider wired, registries empty, zero behavior change - the safest possible first commit. Confirmed `react-hooks/exhaustive-deps` was enabled before any hook-dependency risk existed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 1     | Notifications                  | `useNotificationsState.ts` (68)                                                  | Proved both registries end-to-end on the simplest cluster.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2     | Logistics                      | `useLogisticsState.ts` (136)                                                     | First cross-domain read (`invoices`), via an injected `getInvoices` getter - not a raw value dep, since Invoices wasn't extracted yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3     | Customers                      | `useCustomersState.ts` (92)                                                      | Clean no-cross-domain case, confirmed the state+form shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4     | Suppliers                      | `useSuppliersState.ts` (334)                                                     | First two-way cross-domain case (network-graph lookups via injected callback). Found and fixed: `purchaseReceipts` was never reset on logout - added to the domain's own registered reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5     | Payments/debt                  | `usePaymentsState.ts` (117)                                                      | Reads `invoices` for debt computation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6     | Import jobs                    | `useImportsState.ts` (180)                                                       | Calls back into suppliers/products creation on confirm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7     | Sync/offline queue             | `useSyncState.ts` (268)                                                          | First `useRef` (IndexedDB handle) moved into a domain hook. Established the **escape-hatch pattern**: `syncRepositoryRef` exposed raw for not-yet-extracted OwnerApp code that needs direct write access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8     | Products/inventory             | `useProductsState.ts` (300 lines)                                                | Reference shape every later phase followed: state + form + load/save/delete actions + registered reset + registered refresh. Found and fixed: `stockProductId`/`stockQuantityAfter`/`stockReason` never reset. Found and **flagged, not fixed**: `adjustStock`'s and `deleteProduct`'s catch blocks both queue a `"supplier.create"`/`"inventory.adjust"`-mismatched offline-retry mutation on failure - a pre-existing bug needing a product judgment call on the correct retry shape, not a mechanical fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 9     | Invoices/sales                 | `useInvoicesState.ts` (170)                                                      | Reads products/customers via injected callbacks. Established the **getter pattern**: `useLogisticsState` retrofitted from a raw `invoices` value dep to `getInvoices: () => invoices`, since a plain dep would have needed Invoices extracted first - closures don't evaluate their body until called, so a getter sidesteps the temporal-dead-zone ordering constraint entirely.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 10    | Network graph                  | `useNetworkState.ts` (371 lines)                                                 | Sequenced before its two consumers at the time (Suppliers via forward-declared callback; Chat came later). Established the second **escape-hatch** case: `setNetworkGraph` exposed raw.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11    | Reports & knowledge            | `useReportsState.ts` (47)                                                        | Read-only aggregation, no cross-domain state reads - the smallest hook in the whole effort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 12    | Runtime/agent session history  | `useRuntimeHistoryState.ts` (163)                                                | Second ref-heavy phase (3 refs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13    | Storefront/customer-care inbox | `useStorefrontCareState.ts` (56)                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 14    | Compliance + Beta + Launch     | `useReadinessState.ts` (510)                                                     | One combined hook, mirroring the backend roadmap's own decision to keep these three together (shared readiness-dashboard shape).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15    | Business setup/onboarding      | `useBusinessSetupState.ts` (211)                                                 | First phase writing into `OwnerCoreContext` (`business`). Found and fixed: `language`/`businessSetupStep`/`shopPhoneCountryCode`/`isBusinessSetupOpen` never reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 16    | Chat/messaging/conversations   | `useChatState.ts` (2,054 - the largest hook, `sendChatDraft` alone ~1,000 lines) | The load-bearing phase: every cross-domain callback it needed was proven in isolation on an earlier phase first. `ChatSurface`'s prop reduction (101 → ~80) landed in this same commit. Introduced **bulk-copy + compiler-driven extraction** for the first time: copy the candidate block wholesale, ask `tsc` what's missing, categorize each missing name against the source file's own already-correct imports via a small script, fix, repeat - turned an intractable 26-function/133-cross-reference manual trace into a fast, mechanically-verifiable one. Also introduced the **destructuring-once pattern** for large blocks (one `const { a, b, c } = deps` at the top instead of prefixing every reference with `deps.`, behaviorally identical since the hook re-runs fresh every render). Found and fixed: `clarificationCount`/`isContactTyping`/`isMessagingInboxOpen`/`isBrowserGenerating` never reset.                                                                                                                                                                                                                                                                                                                                               |
| 17    | Agent/model config             | `useAgentModelState.ts` (119)                                                    | Writes into `OwnerCoreContext`'s `agentSettings`. Found and fixed: `deviceCloudFallbackModelId` never reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 18    | Auth/identity/session          | `useAuthState.ts` (521)                                                          | Writes into `OwnerCoreContext`'s `session`/`grogoniSessionContext`. Caught before writing broken code: `requireMessagingSignIn`/`openAuth`/`browseAsGuest` looked auth-adjacent enough to extract here, which would have created a 3-way circular dependency with BusinessSetup and Chat - re-checked the _original_ exploration report's own clustering (done before any phase began) and found it had correctly bucketed these three under Navigation, not Auth. Left them inline for Phase 19 instead of re-deriving a wrong bucket. Resolved a genuine circular dependency between Auth and Network with the call-time-argument pattern: `useNetworkState`'s `syncSocialNetwork` took `authenticateSocialProfile` (Auth's) as a hook dep, while Auth's `completeOAuthSession` needed `setNetworkGraph` (Network's escape-hatch setter) - converted `authenticateSocialProfile` from a hook-level dep into a parameter `syncSocialNetwork` receives at its one call site instead.                                                                                                                                                                                                                                                                                   |
| 19    | Navigation/view/shell chrome   | `useNavigationState.ts` (262)                                                    | The highest-blast-radius phase, exactly as the original plan predicted. Chat and Auth both reference `navigateToView`/`requireMessagingSignIn` in their own deps objects at hook-call time, forcing Navigation to run before both - but Navigation's own `openAuth`/`browseAsGuest`/`switchMode` need setters that live in Auth, BusinessSetup, and Chat, all called later. Resolved by extending the getter pattern from plain values (Phase 9) to cross-domain _setters_: `getAuthSetters`/`getBusinessSetupSetters`/`getChatSetters` closures defer the actual read to when those three functions run (always after every hook in the render has completed), not at Navigation's own hook-call time. The same shape of cycle existed with Products (`deleteProduct` needs `routedProductId`/`setRoutedProductId`/`navigateToView`, all now Navigation's, while Navigation's `openProduct` needs Products' `populateProductForm`) - resolved the same way, converting Products' dependency into a single `getNavigationHelpers()` getter. `routedProductId`, `isMarketplaceShortcutOpen`, `shopPresenceStatus`, and `screenStateCacheRef`/`activeViewRef` all moved from raw OwnerApp state into this hook, since only Navigation's own functions ever touched them. |
| 20    | Marketplace/buy-side           | `useMarketplaceState.ts` (147)                                                   | Called right after Navigation (needs its setters via a `getNavigationSetters()` getter) and before Chat/Auth (both take Marketplace's output as eager deps: Chat needs `buyFeed`/`setBuyCart`/`setBuyFeed` directly, Auth needs `loadMarketplaceIntroState`/`validateStoredBusiness` directly, unchanged from how Auth already referenced them since Phase 18). Navigation's own `switchMode` reads `isMarketplaceIntroComplete` (now Marketplace's) despite running _before_ Marketplace - resolved with a `getIsMarketplaceIntroComplete()` getter, the same pattern in the opposite direction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 21    | Cleanup                        | (no new file)                                                                    | `resetClientToStartup` already called `domainResetRegistry.resetAll()` since Phase 0, but three explicit setter calls after it had become dead duplicates of what a domain's own registered reset already does (`setRoutedProductId(null)`, `setIsBusinessSetupOpen(false)`, `setIsAccountRestorationOpen(false)`) - removed. `setIsAuthOpen(true)`/`setAuthenticationView("signup")` stayed: a deliberate override of Auth's own reset (which closes the auth screen), not a duplicate. `switchActiveBusiness`/`createBusiness` were reviewed and needed no changes - both only touch core-context values, which correctly stay inline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Patterns established, reused throughout

1. **Core-context values never relocate.** `session`, `business`,
   `agentSettings`, `view`, `mode` (plus `grogoniSessionContext`, which turned
   out to belong in the same bucket once `OwnerCoreContext.tsx` was read
   as ground truth rather than the plan's looser illustrative prose) stay
   permanent raw `useState` in `OwnerApp`, declared before any domain
   hook. Every domain hook takes them as injected plain-value deps; only
   the domain's _actions_ that mutate them get extracted, taking the
   relevant setter as a dep.
2. **Getter pattern** (Phase 9, extended in Phase 19/20 to setters): when
   a hook needs something from a hook called _later_ in the call
   sequence, inject a closure (`() => value` or `() => setter`/`() =>
({setters})`) instead of the raw thing. The closure's body doesn't
   evaluate until actually invoked - by definition after every hook in
   that render has run - which sidesteps the `const`-before-declaration
   temporal-dead-zone error entirely.
3. **Call-time-argument pattern** (Phases 7, 9, 16, 18): when a function
   needs a setter from a hook called later, and that function is only
   ever invoked from a JSX handler or still-inline effect (not from
   inside another hook's own body), change its signature to accept the
   setter as a parameter and supply it at each call site instead of at
   hook-invocation time.
4. **Escape-hatch pattern** (Phases 7, 10): when not-yet-extracted inline
   OwnerApp code needs raw write access to a hook's internal state
   setter, the hook exposes that raw setter directly in its return value
   rather than wrapping it.
5. **Bulk-copy + compiler-driven extraction** (Phase 16, reused for every
   large/complex remaining phase): copy the whole candidate block first,
   run `tsc`, categorize each "Cannot find name" error against the source
   file's own already-correct imports via a small script, fix, repeat.
   Turns an error-prone manual trace into a fast, mechanically-verifiable
   one - the single highest-leverage technique this effort produced.
6. **Destructuring-once** (Phase 16): for large extracted blocks, one
   `const { a, b, c } = deps` at the top of the hook body instead of
   prefixing every internal reference with `deps.` - behaviorally
   identical (the hook re-runs fresh every render, same as `deps`) but a
   much smaller, safer diff against the original code.
7. **Trust the original exploration report over re-derivation.** The one
   near-miss this effort had (Phase 18's `requireMessagingSignIn`/
   `openAuth`/`browseAsGuest`) came from re-bucketing a function by its
   _name_ instead of checking the careful clustering done once, up front,
   before any phase began. Caught before any broken code was written by
   re-reading that original report instead of trusting a fresh guess.

## Verification gate that held for every phase

1. `pnpm --filter @grogoni/web typecheck` clean.
2. `pnpm exec eslint apps/web/src --max-warnings=0` clean (full-package
   sweep after every phase, not just changed files).
3. **Source-text test sweep**, unique to this effort (state moves, not
   file moves - literal-string assertions against `GrogoniApplication.tsx`
   break differently than JSX-move assertions did in the prior roadmap).
   11 known test files assert directly on `GrogoniApplication.tsx`'s raw
   source text; before each phase, grep which ones touch content about to
   move, and after, repoint any broken assertion to the new hook file (or
   fix a stale slice-boundary marker) in the same commit. Broke in most
   phases that moved a function referenced by name in an existing
   `.indexOf(...)`/`.slice(...)` test helper - always a mechanical fix
   once the new file location was known.
4. `pnpm exec prettier --write` on changed files, re-verify 1-2.
5. **Exact baseline, not "no new failures."** Full test suite
   (`pnpm vitest run tests/`) reproduced **657 passed / 27 skipped / 1
   pre-existing unrelated failure** (the migration-051 checksum test in
   `tests/database-connections.test.ts`) before and after every single
   phase - unchanged from the first commit to the last, across 22 phases.
6. `pnpm build` (production build) succeeds.
7. **Dev-server transform check**, same caveat as the prior roadmap: no
   browser-automation tool is available in this environment, so UI
   correctness was verified by starting the Vite dev server and fetching
   every changed file through its real transform pipeline (confirms
   Rollup/esbuild resolve the whole module graph, which a clean `tsc`
   alone does not guarantee) - not a substitute for a human clicking
   through the actual UI, and not claimed as one.

The pre-existing `ownerRouteGzip` bundle-budget overage (172.35 KiB at
this effort's Phase 0 baseline, 179.28 KiB by Phase 22) was confirmed
unrelated at Phase 0 via a stash-and-rebuild test against `main` at HEAD,
and re-checked (not re-litigated) at the end - the growth across the
effort tracks normal code volume shifting between chunks as functions
moved files, not a code-splitting regression this refactor introduced or
could fix; the actual fix (dynamic `import()`/`manualChunks`) is a
separate, unrelated piece of work.

## Bugs found and fixed (small, obviously-correct reset-sweep gaps)

Same class of gap the backend `domain-modularization-roadmap.md` found
repeatedly in its own extraction (state that should be cleared on logout
but never was, because no single file's diff made the omission visible
until the domain got a dedicated home): `purchaseReceipts` (Phase 4),
`stockProductId`/`stockQuantityAfter`/`stockReason` (Phase 8),
`language`/`businessSetupStep`/`shopPhoneCountryCode`/`isBusinessSetupOpen`
(Phase 15), `clarificationCount`/`isContactTyping`/`isMessagingInboxOpen`/
`isBrowserGenerating` (Phase 16), `deviceCloudFallbackModelId` (Phase 17).
All five fixed as small additions to the extracting hook's own registered
reset, not deferred.

## Bugs found and deliberately left unfixed, flagged in commit messages

`adjustStock`'s and `deleteProduct`'s catch blocks (`useProductsState.ts`,
Phase 8) both queue an offline-retry mutation shaped for a different
operation than the one that actually failed (a `"supplier.create"`/
`"inventory.adjust"` mismatch). Correct behavior requires a product
judgment call on what the right retry payload should be, not a mechanical
fix - carried over unchanged from the pre-extraction code, same as the
backend roadmap's own precedent for flagging rather than silently
redesigning behavior it didn't fully own.

## Capability-first follow-up (complete)

Chat no longer receives or writes the product, customer, invoice, invoice-preview, or payment form
setters. Supported business mutations go through the canonical runtime/capability path; optional
domain refresh, generated cards, and navigation remain presentation concerns. Read-only local
hook-order bridges used by conventional UI are documented transitional coupling, not mutation
authority. Product, supplier, customer, invoice, debt, and network snapshots/operations are no
longer injected into Chat for local interpretation. See `capability-first-runtime.md`.

## Follow-up decomposition

The next scoped JSX decomposition is complete. The 18-view workspace switch moved to
`OwnerWorkspace.tsx`; `ChatSurface` delegates its composer controls to `ChatComposer.tsx`; and the
composer's transient state moved to `useChatComposerState.ts`. Static line budgets cover all four
new boundaries so they cannot silently collapse back into either composition root. The remaining
`GrogoniApplication.tsx` body is primarily hook wiring, lifecycle coordination, and the final shell
tree; further reduction should follow a newly identified ownership boundary rather than a target
line count.
