# Frontend deployment recovery

## The production failure this fixes

A user leaves a Grogoni tab open across a deployment. Session storage still says
"Session active". They open Account and Agent Settings and see:

> Account and agent settings could not open.
> The app may have been updated while this page was open.
> Reload and try again.

**Root cause.** Vite emits every JS/CSS asset under a content hash
(`assets/AgentProfileSurface-<hash>.js`, see `apps/web/vite.config.ts`'s
`rollupOptions.output.*FileNames`). The React tree already running in that open tab still holds
the _old_ hash in its compiled `import()` call. A new deployment replaces `dist/assets/*` with
newly hashed files and deletes the old ones, so the moment the tab dynamically imports
`AgentProfileSurface` (or a nested panel it lazy-loads, such as `AgentModelPanel` or
`IdentitySecurityPanel`), the browser's module loader requests a file the server no longer has and
throws a browser/bundler-specific "failed to fetch dynamically imported module" error. Before this
fix, `LazyModuleErrorBoundary` caught _every_ render error - a stale chunk 404 and a genuine
programming bug alike - and showed the same static "could not open" panel with no reload; nothing
distinguished a real deployment race from a bug, and nothing recovered automatically.

This is a frontend runtime/deployment-consistency problem, not an authentication problem: the
session is fine, only the client's compiled JS is out of date.

## Centralized mechanism

Every lazy-loaded surface in the app - Account and Agent Settings and its nested panels, the
top-level owner app shell, the public storefront, and the legal pages - routes through exactly one
module: `apps/web/src/lazy-module-recovery.ts`. No component reloads the page on its own.

```
lazy(() => loadLazyModuleWithRecovery(moduleKey, () => import("./Module")))
  <LazyModuleErrorBoundary moduleKey={moduleKey} label="...">
    <Suspense>...</Suspense>
  </LazyModuleErrorBoundary>
```

`loadLazyModuleWithRecovery` wraps the dynamic `import()`. `LazyModuleErrorBoundary` is the single
error boundary every such `<Suspense>` renders inside (`apps/web/src/AppRouter.tsx` for the app
shell/legal/storefront routes, `apps/web/src/GrogoniApplication.tsx` for Account and Agent Settings and
its nested panels via `apps/web/src/grogoni-application-shared.ts`).

### 1. Recognizing a stale-build failure

`isLazyModuleLoadError` matches the failure signatures browsers and bundlers actually throw for a
404'd or unreachable chunk: `ChunkLoadError`, "Failed to fetch dynamically imported module",
"Error loading dynamically imported module", "Importing a module script failed", "Loading chunk/CSS
chunk ... failed", and Firefox's "NetworkError when attempting to fetch resource". Anything else -
a real exception thrown while rendering the settings surface - is explicitly _not_ treated as a
deployment issue (see "Not every error is a deployment" below).

### 2. Confirming it isn't simply offline

A chunk fetch can fail with the exact same error shape because the device has no network, which is
not a stale build. Before touching anything, the loader checks `navigator.onLine`. Offline: log
`frontend.chunk_load_failed` with `category: "offline"` and stop - no reload, no marker written. The
user sees the boundary's fallback UI and can retry once they're back online.

### 3. The reload-loop guard (build/version + timestamp + attempt count)

A short-lived marker (`sessionStorage["grogoni.deployment-recovery.v1"]`) records
`{ buildId, attempts, firstAttemptAt }`, where `buildId` is the tab's compiled-in
`__GIT_COMMIT_SHA__` (see `apps/web/src/grogoni-application-shared.ts`'s `buildIdentity.commitSha`).
On a confirmed stale-build failure:

- No marker, or the marker belongs to a _different_ build, or the marker is older than 5 minutes
  (`deploymentRecoveryMarkerTtlMs`): this is a new build transition. Write the marker and proceed
  to recover (state flush → reload).
- The marker already belongs to the _same_ build and has at least one attempt recorded, and hasn't
  expired: recovery was already attempted for this exact build and failed to fix it (e.g. an edge
  cache still pinning the old `index.html` - see "Fixing PWA caching semantics" below). Log
  `frontend.recovery_failed` with `reason: "loop_guard"` and stop. **No second automatic reload.**
  `LazyModuleErrorBoundary` then shows the stale-build message with a manual "Reload and try
  again" button (`retryLazyModuleLoad`), which clears the marker and performs exactly one more,
  user-initiated reload - an explicit click is never a loop.

This is what turns `reload → stale error → reload → stale error → ...` into "reload once per
build transition, then ask the user."

At boot (`apps/web/src/main.tsx`), `consumeDeploymentRecoveryOutcome` reads the marker once: if the
build id it recorded differs from the build id now running, the automatic reload worked - log
`frontend.recovery_completed` and clear the marker. If it's still the same build, leave the marker
in place so a repeat failure trips the loop guard above instead of reloading again.

### 4. Build identity

`apps/web/vite.config.ts`'s `build-identity-manifest` plugin emits `dist/build-meta.json` -
`{ buildId, version, builtAt, environment }`, where `buildId` is the same git commit sha baked into
the bundle as `__GIT_COMMIT_SHA__`. At startup, `checkForStaleBuildAtStartup` fetches
`/build-meta.json` with `cache: "no-store"` (bypassing the service worker and HTTP caching) once,
compares it to the compiled-in build id, and - only for observability - logs
`frontend.stale_build_detected` with `trigger: "startup"` if they differ. **This never forces a
reload by itself.** A user mid-session on a still-working build should not be yanked into a reload
just because a new deployment exists; only an actual usage failure (a real chunk load) triggers
recovery. This is a single fetch on boot, not a poll.

### 5. State preservation before the one reload

Before calling `reload()`, the recovery path always, in order:

1. **Flushes recoverable client state.** `registerPreReloadFlush` lets any part of the app that
   owns recoverable state register a synchronous flush callback. `GrogoniApplication` registers one
   that writes the active conversation id, runtime session id, chat draft (unsent composer text),
   and recent chat messages to `sessionStorage` via `owner-navigation-session.ts` -
   _synchronously_, not the normal 180ms-debounced write, since the reload can fire before that
   debounce would have flushed on its own.
2. **Marks the panel to reopen.** `sessionStorage["grogoni.lazy-module-recovery.v1.<moduleKey>"]` is
   set to `"pending"`. `GrogoniApplication`'s initial `view` state checks this for every
   `agentProfileModuleKeys` entry before falling back to the last route, so Account and Agent
   Settings (or whichever nested panel failed) reopens automatically once the app re-boots - the
   user never has to re-navigate to what they were doing.
3. **Reloads exactly once** (`window.location.reload()`).

None of this touches authentication. The recovery marker and the per-module "reopen" flag live
under their own `grogoni.*` session-storage keys; nothing here ever calls `sessionStorage.clear()`,
clears `grogoni.chatFirst.ownerAuth`, `grogoni.owner-navigation.v1:*`, or any other storage key it
doesn't own, deletes conversations, resets the active business, or touches agent/model runtime
bindings. The authenticated session, the active business, and the agent/model binding all survive
the reload exactly as any ordinary page reload preserves them.

### 6. Not every error is a deployment ("genuine programming exception" guard)

`LazyModuleErrorBoundary` classifies whatever it catches with the same `isLazyModuleLoadError`
check:

- **Recognized stale-build error** (it reached the boundary because recovery already exhausted its
  one automatic attempt, or the user is offline): the stale-build copy, with a manual reload
  button.
- **Anything else** - a real bug in the settings surface's render path: a distinct message
  ("...hit an unexpected problem. This looks like an application error, not an update - reloading
  may not fix it.") with a "Try again" button that only resets the boundary's local state and
  re-renders - **it never reloads the page or writes the recovery marker.** Blaming a real bug on
  "an update" would be actively misleading, and reloading on every render exception would burn the
  one-reload guard on failures a reload can't fix.

### 7. Structured observability

`logDeploymentRecoveryEvent` (used by both `lazy-module-recovery.ts` and
`LazyModuleErrorBoundary.tsx`) emits one JSON line per event via `console.info`, always including
only the safe fields callers pass explicitly - `component` (the module key), `route`, `buildId`,
`category`, `attempt` - and nothing else. It never receives, and therefore never logs, session
tokens, cookies, or account/user data; that's structural (call sites only ever pass the fields
above), not a redaction step applied afterward. Events: `frontend.chunk_load_failed` (every
failure, tagged with a `category` of `stale_build_suspected` / `offline` / `loop_guard` /
`component_exception` / `stale_build_confirmed`), `frontend.stale_build_detected`,
`frontend.recovery_started`, `frontend.recovery_completed`, `frontend.recovery_failed`.

## PWA cache lifecycle (`apps/web/public/sw.js`)

Two asset classes are cached with deliberately different policies:

- **Hashed static assets** (`/assets/*`): `cacheFirst`. Safe to cache aggressively and
  indefinitely, because the filename changes whenever the content does - a cache hit can never
  serve stale content under a name that also matches new content.
- **Navigation requests** (`request.mode === "navigate"`, i.e. `index.html`): **network-first**,
  via `navigationResponse` - it always attempts a live fetch (using `navigationPreload` where
  available) and only falls back to the cached shell when that fetch fails outright (true
  offline). The freshly-fetched HTML is written back into the cache on every successful navigation.
  This is what prevents the two broken mixed-version states: an old cached `index.html` continuing
  to reference newly-deleted old-hash chunks forever, or a newly-fetched `index.html` referencing
  chunks a stale cache hasn't fetched yet. `tests/service-worker-policies.test.ts` asserts this
  ordering (`event.preloadResponse` awaited before falling back to the offline shell) directly
  against `sw.js`'s source.
- **`/build-meta.json`** matches none of `sw.js`'s routes, so it always goes straight to the
  network - exactly what `checkForStaleBuildAtStartup`'s explicit `cache: "no-store"` fetch needs.

`apps/web/src/service-worker.ts` calls `registration.update()` on every registration (skipped only
in explicit offline mode) and reloads once on `controllerchange` if this tab was already controlled
by a previous worker - `sw.js` calls `self.skipWaiting()` unconditionally on install, so a new
worker activates immediately rather than waiting for every tab to close.

## Settings bundle-size audit (why it stays code-split)

Requirement: inspect Account and Agent Settings' bundle size and inline it into the main bundle
instead of lazy-loading it if that materially improves reliability, without blindly removing code
splitting elsewhere. Measured via `pnpm --filter @grogoni/web build` (see
`scripts/check-web-bundle-budgets.mjs`, budgets enforced by `tests/web-bundle-budget.test.ts`):

| Chunk                                                             | gzip size                  |
| ----------------------------------------------------------------- | -------------------------- |
| `AgentProfileSurface` (Settings surface itself)                   | 26.1 KiB                   |
| `AgentModelPanel` (nested, Settings-only)                         | 7.3 KiB                    |
| `IdentitySecurityPanel` (nested, Settings-only)                   | 7.5 KiB                    |
| `GrogoniApplication` (the owner app shell, i.e. `ownerRouteGzip`) | 141.0 KiB / 170 KiB budget |

Folding `AgentProfileSurface` alone into the owner-app-shell chunk would push `ownerRouteGzip` to
~167 KiB against a 170 KiB budget, and Settings' own nested panels add another ~15 KiB on top of
that - it would blow the budget `tests/web-bundle-budget.test.ts` enforces on every route, not just
on the click that opens Settings. **Decision: keep Settings (and its nested panels) code-split.**
The fix here is making that split safe to hit mid-session, not removing it.

## Tests

- `tests/lazy-module-recovery.test.ts` - failure-signature recognition; the offline guard; the
  reload-loop guard across simulated build transitions (same build twice → no second reload;
  build id actually changes → a fresh single attempt is allowed again); a genuine (non-chunk)
  error never reloads; pre-reload flush hooks run before `reload()`; the recovery marker never
  touches storage keys outside its own namespace; `consumeDeploymentRecoveryOutcome` and
  `checkForStaleBuildAtStartup` (including "never fetches while offline" and "never throws on a
  network failure").
- `tests/lazy-module-error-boundary.test.tsx` - a genuine render exception gets the distinct
  "unexpected problem" copy and a non-reloading "Try again" (never the stale-build copy or a
  reload); a recognized chunk-load error gets the stale-build copy and reload button; "Try again"
  re-renders without touching `window.location`; the boundary logs a correctly-categorized
  `frontend.chunk_load_failed`.
- `tests/service-worker-policies.test.ts` / `tests/pwa-installability.test.ts` - navigation-first
  caching, immutable-asset caching, and service-worker registration/update behavior.
- `e2e/responsive-accessibility.spec.ts` - `page.route` interception of a lazy chunk's real network
  request, end to end against a running dev server: a stale `AgentProfileSurface` chunk (and,
  separately, its nested `AgentModelPanel`/`IdentitySecurityPanel` chunks) reloads exactly once and
  reopens Settings automatically, with the per-module recovery flag cleared afterward.

## Known limitation

The reload-loop guard's "same build" comparison is scoped per browser tab (`sessionStorage`), by
design - a tab that already used its one automatic attempt for a build should ask before trying
again, but a different tab (or this tab after a genuine subsequent deployment) gets its own fresh
attempt. A user with many tabs open across the same stale build will see the message once per tab
they interact with, each recovering independently.
