# Frontend navigation performance audit

## Diagnosis

The owner application already used `history.pushState`, so the main navigation buttons did not
reload the document. The persistent `OwnerApp` component also retained authentication, shop, chat,
and runtime state while ordinary owner views changed.

The measured request topology exposed the primary latency source:

- Entering the chat view scheduled 9 business-data loaders. Network graph loading added 2 more
  requests, for a maximum of 11 requests after a route transition.
- The route refresh effect was keyed by `view`, so returning to a recently visited screen scheduled
  those loaders again.
- Opening account and agent settings mounted `AgentProfileSurface` and immediately scheduled 7
  model-catalog requests, browser inference storage/capability inspection, device storage
  inspection, and 6 account/profile requests.
- Chat navigation also loaded runtime session history and its selected turns even though runtime
  history is not rendered in chat.
- Runtime session ownership was split between component state and individual turn calls. Concurrent
  actions could therefore create separate sessions, and a stale ID did not have a single recovery
  path.

The local inference engine itself was already worker-backed and lazily created. The expensive model
worker and GGUF operations were not the cause of ordinary route transitions.

## Changes

- Internal owner navigation remains a client-side history update and now records click, route
  commit, and first-visible-render timings in development.
- GET requests use an application-level stale-while-revalidate cache with in-flight
  deduplication. Mutations invalidate the related resource.
- Ordinary chat refresh no longer requests sync queue, runtime sessions, or runtime turns.
- Model registry, IndexedDB browser-inference state, and device capability/storage checks remain
  paused until **Open model library** is selected.
- A single application-level `RuntimeManager` deduplicates runtime creation, reuses a valid
  `runtimeSessionId`, and recreates an expired session once. Navigation never waits for it.
- “Use with this agent” shows a pending state, initializes the runtime only for that explicit
  action, preserves the prior model on failure, and replaces raw runtime/session errors with a
  retryable user message.
- Long lists use `content-visibility`, attachment images decode lazily, reduced-motion behavior is
  preserved, and GGUF files remain outside the service-worker app shell.

## Request counts

Counts are derived from the audited call graph and enforced by request-deduplication tests.

| Flow                                    |                                    Before |                                                                     After |
| --------------------------------------- | ----------------------------------------: | ------------------------------------------------------------------------: |
| Chat → Settings, model library unopened |                         up to 16 requests |                                                6 account/profile requests |
| Settings → Chat within cache window     |                         up to 11 requests |                                                  0 duplicate GET requests |
| Repeated model registry consumers       |             7 requests per settings mount | 0 until explicit open; one request per unique URL within the cache window |
| Chat route runtime-history work         | 2 requests when a selected session exists |                                                                         0 |
| Concurrent runtime initialization       |                    one request per caller |                                                    1 deduplicated request |

## Runtime lifecycle

Before, `runtimeSessionId` lived only in `OwnerApp` state. Callers omitted it when null and adopted a
new value after a completed turn. There was no shared initialization promise or stale-session retry.

After, the manager transitions through `idle → initializing → ready`, shares one initialization
promise, and reuses the ID for the account/shop key. Model activation and cloud inference invoke it
only when needed. A 404/410 or explicit expired-session error clears the ID, creates one replacement,
and retries the affected operation once. Local offline model use remains available without a network
runtime.

## Timing instrumentation

Development builds emit structured, token-free logs with the `[GROGONI_PERF]` prefix for:

- navigation click, route commit, and first visible render;
- React route render duration;
- API path, method, status, and duration;
- cache hits, stale reads, and request deduplication;
- runtime initialization and reuse;
- browser long tasks.

Route timing is device-dependent, so no fabricated millisecond result is recorded here. On the
target device, capture the `route-update` and `first-visible-render` events before and after this
commit. The interaction target is a visible response within 100 ms; API completion is intentionally
not part of that critical path.

## Validation and manual low-end Android checklist

Automated coverage verifies request deduplication, cached reuse, deferred model discovery, runtime
initialization deduplication, one stale-session recovery, client-side routing, performance markers,
and exclusion of GGUF files from the app shell.

On a low-end Android device with CPU throttling and Slow 4G:

1. Move between Marketplace, Sell, Catalogue, Reports, Settings, and Back; confirm the header reacts
   immediately and no document reload occurs.
2. Confirm `[GROGONI_PERF] first-visible-render` is below 100 ms for warm routes.
3. Open Settings without opening the model library; confirm no model registry or device storage
   request occurs.
4. Open the model library; confirm its own pending state appears while account navigation remains
   usable.
5. Tap **Use with this agent** twice quickly; confirm one runtime initialization and one model test.
6. Simulate an expired runtime session; confirm one recreation and no raw validation error.
7. Navigate while a local model downloads or generates; confirm only the affected model/chat control
   is busy.
8. Go offline and revisit cached screens; confirm cached content or screen-specific empty states
   render without a global spinner.

Render cold starts can still delay uncached API responses and cloud inference. They no longer gate
the client-side route update, and this change does not require a paid Render service.
