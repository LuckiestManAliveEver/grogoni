# Frontend modularization roadmap

**Status: complete.** All 34 originally-identified presentational
components extracted, plus 11 shared-foundation files split out ahead of
them. `apps/web/src/GrogoniApplication.tsx` went from 22,869 lines to 6,521
lines - now containing only `OwnerApp` itself, the `PublicStorefrontChat`
re-export (for `AppRouter.tsx`), and the imports both need.

## Why this exists

`apps/web/src/GrogoniApplication.tsx` was the frontend counterpart to the
now-fully-modularized `services/api/src/cp2/store.ts` and `routes.ts`.
Unlike those two, it had never been split at all.

The file had three parts:

1. **Import block + shared types/constants**: 56 npm/local imports, then
   107 interfaces, 33 type aliases, and 51 consts (including ~10
   `lazy()`-loaded component references) used across almost everything
   below.
2. **`OwnerApp`** (~6,143 lines): one giant stateful root component -
   all the app's `useState`/`useEffect`/event-handler logic lives here as
   closures. Confirmed out of scope for this roadmap from the start -
   decomposing its state would mean introducing custom hooks or context,
   a real architecture decision with UI-visible risk, and is a candidate
   for a separate, later effort.
3. **34 presentational components** (~14,500 lines): already-separate
   top-level function components taking typed props, each rendered by
   `OwnerApp` by name (or, for `PublicStorefrontChat`, consumed
   externally by `AppRouter.tsx`). **This was the scope of this
   roadmap, and it's now fully extracted.**

A full structural research pass (every boundary line-verified against
the live file before any edit) confirmed none of the 34 components were
nested inside one another or inside `OwnerApp` - every one was a
top-level sibling declaration. That made this mechanically similar to
the backend's domain extraction (find the boundary, move it, wire
imports) but with one added wrinkle the backend never had: ~150 shared
identifiers (formatters, API helpers, bootstrap functions, the
merchant-command NLU engine, etc.) lived as free functions in a tail
block, interleaved with 6 of the 34 components themselves.

## The circular-import trap this roadmap was built to avoid

If shared helpers had stayed in `GrogoniApplication.tsx` with each
extracted component importing them from `"./GrogoniApplication.tsx"`, that
would have created a real module-level circular import:
`GrogoniApplication.tsx` imports the components it renders from their new
files, and those files import shared helpers back from
`GrogoniApplication.tsx`. Fixed the same way the backend's
`route-helpers.ts` was: every genuinely shared piece was pulled into its
own neutral file _before_ any component moved, so both
`GrogoniApplication.tsx` and every new component file import from the same
neutral source - never from each other. This held for all 5 phases with
one exception (§ Phase 4 below), caught and fixed the same way.

## What was extracted, in the order it actually happened

| Phase | What                      | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a    | Shared types/constants    | `grogoni-application-shared.ts` (1,941 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | All 107 interfaces + 33 type aliases + 51 consts, exported and re-imported via a single generated import statement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 0b    | Shared utility modules    | `api-helpers.ts`, `formatters.ts`, `grogoniid-and-storefront.ts`, `country-dial-codes.ts`, `owner-app-bootstrap.ts` (512 lines), `agent-command-engine.ts` (395 lines), `chat-message-plumbing.ts` (435 lines), `contacts-import.ts` (188 lines), `misc-browser-utils.ts`                                                                                                                                                                                                                                                                                                                                                 | 8 files. Several functions turned out to be transitively needed by more than one of these modules (`ensureRequiredAgentContextScripts`, `sanitizeContextScripts`, `isAgentModel`, `dataUrlPayload`, `createProductFieldDraft`) - caught by tsc name-resolution errors, moved to whichever new file needed them first, still available for the not-yet-extracted components that also needed them.                                                                                                                                                                                                                                                                                                                                                    |
| 1     | 8 low-coupling components | `PrimaryNavigation.tsx`, `NetworkNodeList.tsx`, `LogisticsSurface.tsx`, `CustomerSurface.tsx`, `InvoiceDocument.tsx`, `ReportRow.tsx`, `ShopPresenceButtons.tsx`, `EmptyStateSurface.tsx`                                                                                                                                                                                                                                                                                                                                                                                                                                 | Zero new cross-component coupling found - the research pass's prediction held exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2     | 20 mid-tier components    | `BusinessSetupPanel.tsx`, `NetworkSurface.tsx`, `SyncSurface.tsx`, `RuntimeSurface.tsx`, `PaymentSurface.tsx`, `ImportSurface.tsx` (454 lines), `ImportRowEditors.tsx`, `ProductSurface.tsx`, `SupplierSurface.tsx` (498 lines), `InvoiceSurface.tsx`, `ComplianceSurface.tsx`, `BetaSurface.tsx`, `LaunchSurface.tsx`, `ReportsSurface.tsx`, `NotificationsSurface.tsx`, `MarketplaceModeCard.tsx`, `StorefrontPreviewCard.tsx`, `ContextualBusinessCards.tsx`, `NetworkSyncNestedCard.tsx` (436 lines, combined with `NetworkContactGroup`), `CatalogueNestedCard.tsx` (469 lines, combined with `ProductNestedEditor`) | Paired components sharing a Props type or tight caller/callee coupling combined into one file each (`ImportRowEditors.tsx`, `NetworkSyncNestedCard.tsx`, `CatalogueNestedCard.tsx`) rather than one-file-per-component, to avoid cross-importing a shared Props interface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3     | The 2 large ones          | `AgentProfileSurface.tsx` (5,393 lines), `ChatSurface.tsx` (1,527 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `AgentProfileSurface` moved as one file, as planned - splitting its ~8 merged account-settings sub-panels further stays out of scope. By far the largest test-repoint batch (22 assertions across 7 files), expected since these two carried most of the file's UI copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4     | `PublicStorefrontChat`    | `PublicStorefrontChat.tsx` (1,009 lines) + `BuildIdentity.tsx` (new, 30 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | The one circular-import case this roadmap actually hit: `PublicStorefrontChat` renders `<BuildIdentity />`, which lived in `GrogoniApplication.tsx` next to `OwnerApp`. Re-exporting `PublicStorefrontChat` from `GrogoniApplication.tsx` (needed so `AppRouter.tsx` stays unchanged) while `PublicStorefrontChat.tsx` imported `BuildIdentity` back from `GrogoniApplication.tsx` would have been a genuine two-way cycle. Fixed by moving `BuildIdentity`/`NativeLaunchScreen`/`formatShortCommit` into their own third file, same "shared piece → neutral file" rule as everywhere else - just discovered one phase later than ideal. Zero test-assertion breakage this phase, the only phase where the full suite passed clean on the first run. |

**mcp-tokens** has no equivalent here - token issuance is entirely a
backend concern with no dedicated frontend component.

## Two tooling bugs found and fixed mid-effort

Both were caught immediately by the verification gate (typecheck or a
corrupted-file diff), never shipped, and are worth naming since they'd
recur on any similar future extraction:

1. **ESLint's per-message unused-import fix ranges aren't safe to
   compose.** The first attempt patched `grogoni-application-shared.ts`'s
   massively over-inclusive candidate header by applying each `no-unused-vars`
   suggestion's `fix.range` as an independent text edit. When several
   adjacent names in the same import statement were all unused, their
   fix ranges overlapped in ways that corrupted the file (concatenating
   unrelated import statements together). Fixed by abandoning
   range-patching entirely in favor of parsing each import statement's
   specifier list and rebuilding it from the known set of unused names -
   more robust because it doesn't depend on any assumption about how
   ESLint computed the fix.
2. **Brace-counting for function boundaries breaks on same-line default
   parameter values with their own balanced braces.** e.g.
   `options: { signal?: AbortSignal } = {}` nets to brace-depth zero
   before the actual function body starts, since both the parameter's
   object-type annotation and its default value are balanced
   sub-expressions. This silently truncated `postJson`/`putJson` on the
   first Phase-0b extraction attempt. Fixed by first skipping the
   parameter list via paren-depth counting (ignoring any nested braces
   entirely during that phase), then only starting brace-depth counting
   from the first `{` found after the parameter list closes - the true
   function-body opening brace.

A third, smaller bug (an off-by-one hardcoded line count for the header
boundary, corrupting `AgentProfileSurface.tsx`/`ChatSurface.tsx` on the
first Phase-3 attempt) was fixed by switching to marker-based string
slicing (`content[: content.index("function BuildIdentity()")]`)
instead of any hardcoded line number - immune to this entire class of
error, and should have been the approach from the first extraction.

## Verification gate that held for every slice

1. `pnpm --filter @grogoni/web typecheck` clean.
2. `pnpm exec eslint apps/web/src --max-warnings=0` clean (full-package
   sweep, not just changed files, after every slice).
3. `pnpm exec prettier --write` on changed files, then re-verify 1-2.
4. Full test suite (`pnpm vitest run tests/`) at the same baseline
   before and after every slice: **657 passed / 27 skipped / 1
   pre-existing unrelated failure** (the migration-051 checksum test,
   unrelated to this work) - unchanged from the first commit to the
   last. Literal-string test assertions against `GrogoniApplication.tsx`'s
   raw source text broke in 5 of the 6 slices (every phase except
   Phase 4) as content moved out from under them; each was repointed to
   `readFileSync` the new file instead, same pattern used throughout the
   backend routes.ts effort - dozens of individual assertion repoints
   across 9 different test files over the whole effort, heavily
   concentrated in Phase 3 (`AgentProfileSurface`/`ChatSurface` carried
   most of the file's UI copy and test coverage).
5. **The one gate the backend roadmaps didn't need**: since no
   browser-automation tool is available in this environment, UI
   rendering was verified by starting the Vite dev server and fetching
   every changed file through its transform pipeline (confirms Rollup/
   esbuild resolve the whole module graph with no import errors, which a
   clean `tsc` alone does not guarantee), plus running `pnpm build` for
   Phase 5's final check - a full production build succeeded, and
   `tests/web-bundle-budget.test.ts` still passed. None of this is a
   substitute for a human clicking through the actual UI in a browser -
   that gap is real and was flagged in every commit message rather than
   quietly treated as full coverage.

No live-Postgres or persistence-layer re-verification was needed - this
was a pure client-side code-organization refactor with zero backend
surface touched.

## What's next (not part of this roadmap)

`OwnerApp` itself (~6,143 lines, still one component) was the natural
next target if `GrogoniApplication.tsx` needed to shrink further - and it
has since been done: see `owner-app-state-decomposition-roadmap.md`,
which decomposed `OwnerApp`'s state across 20 domain hooks plus one small
`OwnerCoreContext`, taking `GrogoniApplication.tsx` from 6,521 to 2,220
lines.
