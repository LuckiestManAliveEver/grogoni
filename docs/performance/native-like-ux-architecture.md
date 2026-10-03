# Native-like UX architecture

## Core rule

Navigation is a local state transition. Networking hydrates, refreshes, or synchronizes the selected screen; it does not grant permission for the route to become visible.

## Persistent shell lifecycle

`AppRouter` lazily loads one `OwnerApp`. Once mounted, authenticated navigation uses History API and changes the owner `view`; it does not replace `OwnerApp`. A stable `data-shell-instance` identifies that lifecycle in automated browser tests.

The shell owns:

- cached and verified session state;
- active account/shop identity;
- navigation mode and route;
- the IndexedDB connection and typed sync queue;
- the account realtime subscription;
- runtime-session and model-runtime references;
- header, chat surface/composer, primary navigation, compact connectivity state, and status notices.

Only the initial state with neither a cached session nor a verified session may block the full application. When a cached session exists, the saved shell renders immediately in `offline-authenticated` state and `/auth/bootstrap` reconciles in the background. A definitive authentication rejection moves to reauthentication; a transient failure preserves local UI.

## Route lifecycle

1. Pointer down gives a pressed state and may prefetch only small next-screen reads.
2. Click records `navigation-click`, saves bounded screen state, changes React route state, and updates History API synchronously.
3. The destination renders existing in-memory data, persistent cache data, or its local empty state.
4. Two animation frames record first visible render; an idle callback records navigation-to-interactive.
5. The route refresh effect starts or reuses deduplicated reads. Results reconcile without clearing existing content.
6. Browser back/forward updates the same state from `popstate`.

OAuth redirects, public external handoffs, and PWA document startup remain legitimate document navigations.

## Local cache lifecycle

The `grogoni-local-data` IndexedDB database has a versioned `entries` store. Keys combine account/business scope, domain, and resource key. Every record carries a schema version and update timestamp.

Domain repositories expose:

- `readCached`
- `writeCached`
- `refresh`
- `invalidate`
- `subscribe`
- `clearForLogout`

The named factories are `sessionRepository`, `shopRepository`, `conversationRepository`, `catalogueRepository`, `modelRepository`, `workspaceRepository`, and `syncRepository`.

The API request cache is the read-through coordinator:

1. return a fresh in-memory result;
2. otherwise read an allow-listed persistent record;
3. return the persistent value and refresh in the background;
4. if no local value exists, await the first network result for that feature only;
5. deduplicate equal in-flight reads;
6. reject stale refresh completion using per-record sequence numbers;
7. notify the feature callback when a background value arrives.

Authentication endpoints, secrets, tokens, private credentials, mutation responses, and conversation thread plaintext are not persisted by this cache. Logout clears persistent API data, browser inference account data, sync records/mutations, messaging outbox, and local identity pointers.

## Sources of truth

| Data category                                        | Authoritative source               | Offline/local mirror                                                           |
| ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| Session validity                                     | API secure cookie/session          | non-secret account/user/session summary in localStorage; never an access token |
| Active shop identity                                 | API membership                     | local shop summary                                                             |
| Products and product fields                          | business API                       | catalogue repository                                                           |
| Suppliers, customers, invoices                       | business API                       | shop repository                                                                |
| Reports, payments, logistics, notification summaries | business API                       | workspace repository                                                           |
| Conversation list                                    | messaging API                      | conversation repository                                                        |
| Conversation messages                                | messaging API/E2EE records         | existing sync records and encrypted outbox; not generic API cache              |
| Safe offline mutations                               | API confirmation                   | versioned IndexedDB sync mutation queue with operation/client IDs              |
| Installed model metadata                             | device storage plus API assignment | browser model stores and model repository                                      |
| Active local runtime                                 | worker/native bridge               | in-memory runtime manager; never falsely marked ready from cache               |
| UI form, scroll, selected view                       | React state                        | bounded in-memory screen LRU; durable preferences only where already explicit  |

## Server synchronization lifecycle

The IndexedDB connection and WebSocket are scoped to `session.account.id`, not the active route or `navigator.onLine` state. Reconnect triggers a mutation flush and cursor catch-up. Concurrent catch-up calls share one promise. Realtime events are only hints that changes are available; the cursor-based sync journal is authoritative.

Safe mutations use typed payloads and client-generated identifiers. Chat messages are displayed locally with delivery state, use a stable client message ID, and retry through the encrypted/account-scoped outbox. Irreversible operations, authentication changes, deletion, and model readiness are never finalized optimistically.

## Connectivity model

A separate external store prevents reachability polling from rerendering the owner tree. Its states are:

- `unknown`
- `browser_offline`
- `api_reachable`
- `api_unreachable`
- `authenticated`
- `session_expired`
- `degraded`

It listens to browser hints but confirms API reachability with `/health`, a five-second timeout, and exponential backoff up to two minutes. A small nonblocking dot announces exceptional states accessibly; content is not covered.

## Service-worker strategies

The service worker has separate versioned caches:

- shell/icons/manifest: cache first;
- hashed `/assets/`: cache first and immutable by filename;
- navigation HTML: current-version cached shell immediately, navigation preload/network update in the background;
- public storefront/catalogue reads: stale while revalidate;
- auth/session, private business data, conversations/messages, and model APIs: network only;
- interactive model mutations: explicit network request or typed 503; never queued or faked;
- GGUF/WASM model files: never put in app-shell precache and never prefetched automatically;
- business mutations: not intercepted or generically queued by the service worker.

Activation removes only obsolete Grogoni caches and enables navigation preload. The install step populates the matching shell version before activation, avoiding a new shell that references missing current assets.

## Worker responsibilities

Browser model initialization, model loading, tokenization, generation, cancellation, unload, and health checks use the dedicated model worker with typed request IDs, progress/error messages, and explicit termination. Worker startup duration is measured separately.

Receipt/OCR processing is server-side in the audited frontend. It must remain lazy if a browser OCR implementation is added. Large catalogue search, image resizing, or receipt extraction should get dedicated workers only when measurement shows main-thread tasks over 50 ms; this change does not ship speculative idle workers.

Only one heavy worker is allowed in constrained/standard profiles. The runtime manager reuses a session per account/shop and releases or switches model state explicitly.

## Chat and screen preservation

Chat and composer state remain owned by the persistent application. Conversation rendering is windowed to the latest 40, 80, or 120 messages based on capability; older messages are added in bounded pages. Route changes no longer force the message scroller to jump to the bottom.

Streaming tokens accumulate in memory and update the React message once per animation frame rather than once per token. Images have intrinsic dimensions, lazy loading, and async decoding. Full upload-time thumbnail generation remains a backend/media-pipeline requirement.

The recent-screen cache uses LRU eviction with a strict limit of 2, 4, or 6 entries. It currently preserves document scroll while React state already preserves active forms, queries, and selected tabs during normal shell navigation. Heavy OCR/model views are not kept alive by this cache.

## Capability profiles

Signals are device memory, logical cores, Save-Data, effective connection type, reduced motion, and measured browser support—not device brands.

| Profile       | Preserved screens | Message window | Heavy workers | Idle prefetch          |
| ------------- | ----------------: | -------------: | ------------: | ---------------------- |
| constrained   |                 2 |             40 |             1 | off                    |
| standard      |                 4 |             80 |             1 | on when network allows |
| high_capacity |                 6 |            120 |             2 | on when network allows |

Constrained mode also removes nonessential blur/motion and never automatically initializes OCR or model downloads. The label is internal and is not presented to the user.

## Prefetch policy

Pointer down/hover and idle prediction can prefetch products, fields, invoices, customers, reports, knowledge, or conversation summaries. Prefetch is disabled offline, on Save-Data, and on 2G/slow-2G. Imports, OCR, model catalogs, GGUF files, WASM, galleries, and model runtimes are excluded.

Because current owner screens share one authenticated chunk, predictive code prefetch has no additional primary-route chunk to fetch. The next structural split should extract settings/model management and receipt/import screens into lazy modules.

## Loading and error boundaries

Ordinary navigation never uses a global overlay. Existing content remains during background refresh. Repository snapshots distinguish `hydrated`, `stale`, `refreshing`, `offline`, `failed`, and `empty`. Feature-specific actions retain their own pending/error state; the compact shell notice is informational.

The remaining whole-owner Suspense fallback is only for the first download of the authenticated application chunk. Feature extraction should add outlet-level error/Suspense boundaries without suspending header, chat, composer, or primary navigation.

## Instrumentation and privacy

Development instrumentation records:

- tap, route update, first destination paint, and navigation interactive;
- cache hydration and IndexedDB duration;
- API duration and dedup/cache result;
- worker and runtime startup;
- WebSocket connection lifecycle;
- shell, composer, and first-message readiness;
- React render count/duration;
- long tasks, LCP, layout shifts, and slow event timing.

`?debug=performance` or the local debug flag opens a small diagnostics panel. Events contain route paths, durations, component labels, and status codes only—never messages, prompts, phone numbers, tokens, credentials, or payloads.

## Performance budgets

- visual pressed feedback: under 50 ms;
- route state update begins: under 100 ms;
- cached destination visible: under 200 ms;
- common route interactive: under 300 ms;
- INP: under 200 ms on representative entry-level Android where practical;
- no ordinary navigation task over 50 ms;
- bootstrap/static JavaScript: maximum 250 KiB gzip;
- authenticated owner route: maximum 170 KiB gzip until feature extraction reduces it below the preferred 150 KiB;
- initial CSS: maximum 50 KiB gzip;
- no model worker, GGUF, OCR, or WASM in the static entry graph.

CI builds the web application and reads Vite's manifest to enforce these byte budgets.
The Vite development-server browser regression uses a 500 ms second-paint ceiling because JSX
development transforms and Strict Mode are intentionally present; the production/device target
remains 300 ms.

## Known structural follow-up

`GrogoniApplication.tsx` is still a large owner module. The safe next extraction order is settings/model management, imports/receipts, reports, then catalogue forms. Each extraction should keep domain state above the lazy outlet or in selector-based external stores, add an outlet error boundary, and compare real render counts before and after. This is intentionally documented as remaining work rather than masked with unverified memoization.
