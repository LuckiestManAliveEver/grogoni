# Native-like UX baseline

Date: 2026-07-26  
Repository revision at audit start: `02be7d4` plus pre-existing uncommitted model-activation work  
Environment: Node 20.19.2, pnpm 10.28.2, Vite 6.4.3, Linux container

## Executive finding

Navigation was already implemented with `history.pushState`, so authenticated taps did not normally perform a document reload. The dominant delay risk was work caused by the destination render: virtually the complete owner product lived in one 20,659-line React component with more than 100 local state values, route-specific fetch effects, chat, marketplace, settings, model management, and every business surface in the same render tree.

The most important root causes were:

1. `GrogoniApplication.tsx` was a 722 KB source file and produced a 570.09 KB minified authenticated chunk. A route change updated `view` at the top of this component and reconciled the chat tree plus the active business surface.
2. Cached authentication was read only after `/auth/bootstrap` failed. A returning authenticated user therefore saw the blocking launch screen while a slow request was outstanding even when a usable cached session and shop existed.
3. The request cache was memory-only. It provided in-session stale-while-revalidate and request deduplication but could not hydrate business screens after process restart.
4. The IndexedDB/realtime effect depended on `isOnline`, so a connectivity transition closed and reopened the database and WebSocket instead of keeping their lifecycles scoped only to the account.
5. Chat rendered every message in the active conversation. Streamed browser-model tokens performed a full `setChatMessages` update per token.
6. The service worker used one cache and one generic cache-first branch. Navigations were network-first with fallback, navigation preload was not enabled, and public reads had no explicit stale-while-revalidate policy.
7. Connectivity was represented by `navigator.onLine`, which cannot distinguish API failure, session expiry, or degraded synchronization.
8. Primary-route data refreshes were grouped by a top-level effect. Chat requested nine business/network resources on entry; invoices requested three; products requested two; imports requested three; reports requested two. Failures updated a shared status string and caused additional owner-tree renders.
9. `ChatSurface` received a large prop set and fresh callback identities from `OwnerApp`. This remains an important boundary for future extraction.
10. The build split legal pages and the model worker, but settings, catalogue, marketplace, and all business screens remained in the single authenticated route chunk.

## Architecture at audit time

- Entry: `apps/web/src/bootstrap.ts` dynamically imports `main.tsx`.
- Root/router: `AppRouter.tsx` selects public storefront, legal page, or one lazy `OwnerApp`.
- Owner routing: `OwnerApp` holds `mode` and `view`; `navigateToView` synchronously changes state and calls History API. `popstate` restores those values.
- Shell: header, primary navigation, chat surface, composer, workspace dialog, and route content are all composed by `OwnerApp`. The app shell does not remount on its normal History API navigation, but it re-renders broadly.
- Authentication: `refreshSession()` calls `/auth/bootstrap`, then validates the stored business and fetches presence and agent profile. Cached auth existed in localStorage but was originally a failure fallback.
- State: React local state in `OwnerApp`; there was no selector-based global store. High-frequency state and low-frequency domain state shared the same owner component.
- API cache: a module-level `Map`, 15–300 second stale windows, concurrent-request deduplication, and mutation invalidation.
- Offline data: versioned `grogoni-sync` IndexedDB database for sync records, metadata, and typed mutations. Other screen data was not persisted.
- Realtime: one account WebSocket with reconnect, created by the IndexedDB/sync effect.
- Model runtime: browser inference and GGUF work run in a dedicated typed worker. Server/runtime session identity is deduplicated by `RuntimeManager`.
- OCR/receipt processing: server-side API workflow; no OCR engine was found in the initial browser bundle.
- Service worker: hand-written worker; shell/icon precache, cache-first static assets, network-first navigation fallback, no background sync event.
- Images: only chat attachment images are rendered by the owner application; they were lazy and async-decoded but had no intrinsic dimensions.
- Suspense: route-level boundary around the entire lazy `OwnerApp`; legal routes have separate boundaries. Feature-level Suspense boundaries were absent.

## Production build baseline

Command: `pnpm --filter @grogoni/web build`

Build completed successfully in 24.63 seconds (29.01 seconds shell wall time), transforming 218 modules.

| Asset/category                           |     Minified |                 Gzip |
| ---------------------------------------- | -----------: | -------------------: |
| Bootstrap entry                          |      2.08 KB |              1.08 KB |
| Main React/router chunk                  |    199.25 KB |             62.58 KB |
| Authenticated `GrogoniApplication` chunk |    570.09 KB |            149.88 KB |
| Initial CSS                              |     71.15 KB |             13.42 KB |
| Browser-model worker                     |    883.33 KB | not reported by Vite |
| ONNX/WASM runtime                        | 21,596.02 KB |          5,067.67 KB |

The practical authenticated JavaScript startup path was approximately 213.54 KB gzip (bootstrap + main + authenticated route), below the requested 250 KB preference but concentrated in one 570 KB minified route chunk. The model worker and WASM were separate and were not part of ordinary navigation.

The static build graph implies a lower bound of six same-origin first-load requests for HTML, bootstrap, main, CSS, authenticated route, and the visible icon. Browser manifest/icon behavior and service-worker update checks can add requests. A pre-change production network trace was not available, so this is not presented as an observed request count.

## Route and request baseline

The route state change itself was synchronous and local. No ordinary owner route used `window.location.assign` or `reload`; the two `location.assign` calls found were OAuth and explicit SMS/platform handoff flows.

Data refresh fan-out from source inspection:

| Destination            |                                                             Immediate background reads |
| ---------------------- | -------------------------------------------------------------------------------------: |
| Chat/Sell/Marketplace  |                    9 business/network reads, plus messaging polling when authenticated |
| Catalogue              |                                                                                      2 |
| Invoices               |                                                                                      3 |
| Receipts/imports       |                                                                                      3 |
| Reports                |                                                                                      2 |
| Settings/model library | settings metadata on mount; model catalog/capability work deferred until user opens it |

No pre-change browser trace was available for route-to-paint, first cached paint, React render counts, longest tasks, IndexedDB read duration, service-worker startup, INP, LCP, CLS, or model memory. Instrumentation existed for navigation marks, React Profiler duration, API timing, cache hits, runtime initialization, and long tasks, but it logged only in development and had no retained capture from before this audit.

## Validation baseline

- Web typecheck: passed.
- Web lint: passed.
- Targeted navigation, shell, sync, realtime, service-worker, and PWA tests: 14/14 passed.
- Production build: passed with Vite's chunk-size warning.
- Lighthouse mobile: unavailable; Lighthouse is not installed in the repository.
- Android installed-PWA, CPU-throttled, and memory measurements: unavailable in the container and required as manual follow-up.

## Audit answers

1. Components do not remount for normal owner History API navigation, but `OwnerApp` and much of `ChatSurface` re-render.
2. Route updates do not await API calls; cached-session bootstrap was the network-blocking exception.
3. Screen state arrays survived in memory during navigation, but cold reload had no persistent screen-data hydration.
4. Authentication bootstrap ran at application start, not each route, but ignored cached auth until failure.
5. Stored shop identity was local; presence and agent profile were re-fetched during session validation.
6. Realtime was recreated on account change and on each `isOnline` change.
7. `RuntimeManager` and runtime refs survived route navigation; settings unmount could terminate its profile-local activation coordinator.
8. There were no large React contexts; the equivalent problem was the monolithic owner state component.
9. Navigation fetch waited on network before falling back to the cached shell; other eligible static requests were cache-first.
10. React/runtime plus the owner route dominated initial JS. Model libraries dominated deferred worker/WASM bytes.
11. No retained main-thread trace was available. Per-token React updates and full message-list mapping were source-verified risks.
12. Conversation and product lists rendered every item.
13. Attachment images were lazy and async-decoded but had no dimensions or generated thumbnail contract.
14. Model inference was worker-isolated; several local search/normalization helpers still run synchronously but no navigation click directly starts OCR/model loading.
15. Route changes triggered a broad React reconciliation and a smooth scroll-to-bottom effect because `activeView` was a message-scroll dependency.
16. The memory request cache deduplicated equal reads; some view conditions intentionally requested overlapping report/notification data.
17. Cached auth and sync data existed but auth and business screens did not use it on the first successful online path.

## Measurement caveat

Percent improvements are reported only where a before and after value exists. Real Android INP, long-task, service-worker timing, memory, and Core Web Vitals require a representative device or trace and must not be inferred from desktop build output.
