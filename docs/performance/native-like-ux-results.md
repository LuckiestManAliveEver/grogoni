# Native-like UX performance results

Date: 2026-07-26  
Baseline revision: `02be7d4` plus pre-existing uncommitted model-activation work  
Test environment: Linux container, Node 20.19.2, pnpm 10.28.2, Vite 6.4.3

## Outcome

The owner application now changes routes synchronously inside one persistent shell, renders cached
data before refreshing it, keeps the account database and realtime subscription independent of
route/connectivity changes, and has explicit policies for prefetch, service-worker caching,
connectivity, constrained devices, and heavy workers.

The implementation also adds retained development instrumentation, an opt-in diagnostics panel,
bundle budgets, source-policy tests, and a browser navigation regression that proves the shell
identity survives navigation while all mocked API responses are delayed by 750 ms.

This is a substantial performance foundation, not a claim that every structural problem has been
removed. The authenticated owner implementation remains a large 579.01 KB minified lazy chunk and
`OwnerApp` remains the owner of broad feature state. Settings/model management, imports/receipts,
reports, and catalogue forms are the next safe feature-module extractions.

## Measured browser navigation

Command:

```text
pnpm exec playwright test e2e/native-navigation-performance.spec.ts
```

The test ran against the Vite development server with React Strict Mode and 750 ms latency on every
unhandled API request. It asserts that route content becomes visible independently of those
requests and that `data-shell-instance` never changes.

| Route                         | Second visible paint |
| ----------------------------- | -------------------: |
| Catalogue                     |              98.4 ms |
| Invoices                      |              67.5 ms |
| Purchase receipts             |             101.7 ms |
| Reports                       |              50.7 ms |
| Sell/chat                     |             130.7 ms |
| Workspace/settings/models run |    shell stayed live |

Result: 2/2 browser scenarios passed. All measured common routes were under the 300 ms production
target even in the development build; the regression ceiling remains 500 ms to accommodate
development transforms and Strict Mode variance.

An intermediate measurement isolated full-document View Transition capture as a route delay:
receipts measured 377.6 ms with capture and 101.7 ms after limiting snapshot transitions to chat.
That is a 73.1% improvement for that controlled implementation sample. It is not substituted for a
missing pre-audit baseline.

No pre-change route trace was retained, so percentage improvement by route, startup timing,
second-navigation deltas, long-task deltas, render-count deltas, Core Web Vitals, and memory deltas
are `N/A` rather than fabricated.

## Production bundle comparison

| Asset/category                        | Baseline gzip | Final gzip | Change |
| ------------------------------------- | ------------: | ---------: | -----: |
| Bootstrap entry                       |       1.08 KB |    1.08 KB |   0.0% |
| Main React/router chunk               |      62.58 KB |   66.80 KB |  +6.7% |
| Authenticated `GrogoniApplication` chunk |     149.88 KB |  152.79 KB |  +1.9% |
| Initial CSS                           |      13.42 KB |   14.01 KB |  +4.4% |
| Authenticated startup path            |     213.54 KB |  220.67 KB |  +3.3% |

The size increase is the cost of the new repository, connectivity, capability, diagnostics, and
prefetch foundations. Heavy model code remains outside the static entry graph:

- browser-model worker: 883.33 KB minified;
- ONNX/WASM runtime: 21,596.02 KB minified, 5,067.67 KB gzip;
- no GGUF/model asset is precached or predictively fetched.

The manifest-based CI gate measured 66.29 KiB initial JavaScript gzip, 13.69 KiB initial CSS gzip,
and 149.21 KiB owner-route gzip using its own deterministic gzip calculation. Budgets are 250 KiB,
50 KiB, and 170 KiB respectively. The build transformed 225 modules and completed successfully,
with Vite's existing warning that the lazy owner chunk exceeds 500 KB minified.

The lower-bound first authenticated load remains HTML, bootstrap, main, CSS, owner route, and icon.
A production browser network capture was not available, so an observed request-count reduction is
not claimed. Persistent data hydration reduces repeat data dependence, not the static module count.

## Delivered architecture

### Persistent shell and local-first routes

- Cached non-secret session state initializes the owner shell before network bootstrap.
- History API navigation commits route state immediately and preserves one shell instance.
- Bounded screen state restores scroll without keeping unlimited screens alive.
- Existing content stays visible while an allow-listed background refresh reconciles.
- Pointer and idle prefetch are restricted to small likely reads and are disabled for offline,
  Save-Data, 2G/slow-2G, OCR/imports, model catalogs, GGUF, WASM, and model runtimes.

### Data and synchronization

- `grogoni-local-data` is a versioned IndexedDB store scoped by account/business and domain.
- Repositories expose cached read, write, refresh, invalidation, subscription, and logout clearing.
- Repository state distinguishes hydrated, stale, refreshing, offline, failed, and empty.
- In-flight reads deduplicate, and sequence numbers prevent stale responses from replacing newer
  data.
- The account IndexedDB/realtime lifecycle no longer reopens when `navigator.onLine` changes.
- Reconnect performs mutation flush/cursor catch-up while keeping cursor-based sync authoritative.
- Authentication, credentials, mutation responses, and conversation-thread plaintext are excluded
  from the generic persistent request cache.

### Main-thread and chat work

- Browser model loading, tokenization, generation, cancellation, health, and unload remain in the
  existing typed worker, with worker-start timing added.
- Receipt OCR remains server-side and is not added to the initial browser graph.
- Streamed tokens now coalesce to at most one React message update per animation frame.
- Chat renders a capability-bounded 40/80/120-message window and loads older messages in pages.
- Navigation no longer causes the chat scroller to jump to the bottom.
- Attachment images now reserve intrinsic space and retain lazy loading/async decoding.
- Constrained mode limits preserved screens, message count, heavy workers, motion, blur, and
  predictive work.

### Service worker and connectivity

- The service worker has separate shell, static, and public-data caches.
- Navigation uses the current cached shell immediately and refreshes it via navigation preload or
  network in the background.
- Hashed assets are cache-first; public storefront/catalogue reads are stale-while-revalidate.
- Auth/session, private business data, conversations/messages, and model APIs are network-only.
- Interactive model requests retain an explicit typed offline failure; they are never faked or
  queued.
- A small external connectivity store distinguishes browser offline, API unreachable, reachable,
  authenticated, session expired, and degraded states without rerendering the owner tree on every
  probe.

## Verification

- Monorepo production build: passed.
- Monorepo typecheck: passed.
- ESLint with zero warnings: passed.
- Vitest: 108 files passed, 1 skipped; 399 tests passed, 3 skipped.
- Focused native-navigation/data/cache/service-worker tests: 42/42 passed.
- Playwright native-navigation regression: 2/2 passed.
- Web bundle-budget production build: passed.

Lighthouse mobile was not run because Lighthouse is not installed in this repository. Installed-PWA
Android, CPU-throttled, offline-launch, Core Web Vitals, long-task, and memory measurements require
a representative device or browser trace and remain manual validation.

## Changed performance paths

Core implementation:

- `apps/web/src/GrogoniApplication.tsx`
- `apps/web/src/api-request-cache.ts`
- `apps/web/src/local-data-repository.ts`
- `apps/web/src/connectivity.ts`
- `apps/web/src/ConnectivityIndicator.tsx`
- `apps/web/src/capability-profile.ts`
- `apps/web/src/prefetch.ts`
- `apps/web/src/screen-state-cache.ts`
- `apps/web/src/performance.ts`
- `apps/web/src/PerformancePanel.tsx`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/sync/realtime-client.ts`
- `apps/web/src/browser-model-engine.ts`
- `apps/web/public/sw.js`
- `apps/web/vite.config.ts`
- `package.json`
- `scripts/check-web-bundle-budgets.mjs`

Tests and documentation:

- `e2e/native-navigation-performance.spec.ts`
- `tests/connectivity-model.test.ts`
- `tests/frontend-navigation-performance.test.ts`
- `tests/local-data-repository.test.ts`
- `tests/native-navigation-primitives.test.ts`
- `tests/persistent-app-shell.test.ts`
- `tests/service-worker-policies.test.ts`
- `tests/web-bundle-budget.test.ts`
- `docs/performance/native-like-ux-baseline.md`
- `docs/performance/native-like-ux-architecture.md`
- this results document

The worktree already contained unrelated model-activation changes when this audit began. They were
preserved; this report does not attribute those files or their tests to the performance work.

## Manual Android/PWA validation

1. Build and serve the production web app over HTTPS.
2. Install the PWA on a representative entry-level Android device.
3. Launch once online, sign in, visit catalogue/invoices/receipts/reports, then terminate and relaunch.
4. Repeat with airplane mode and confirm the cached shell and previously hydrated safe data render.
5. Record a performance trace while navigating the five measured routes and while streaming a long
   model response.
6. Confirm no ordinary route task exceeds 50 ms, INP is under 200 ms where practical, the shell
   instance is stable, WebSocket/IndexedDB lifecycles do not restart, and memory settles after
   leaving model/import surfaces.
7. Test back/forward, draft preservation, scroll restoration, retryable queued writes, session
   expiry, API-unreachable state, Save-Data, reduced motion, and model cancellation.

## Rollback

No commit was created because the worktree contained user changes. The safest rollback is to commit
this performance patch separately and use `git revert <commit>` if needed. Before a commit exists,
review `git diff` and reverse only the performance paths/hunks listed above; a blanket
`git restore` of `GrogoniApplication.tsx`, `browser-model-engine.ts`, or `sw.js` could discard the
pre-existing model-activation work.
