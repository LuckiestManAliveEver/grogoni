# Model, agent, and native session integration audit

Date: 2026-07-21

## Scope and decision

This audit was completed before implementation changes. Grogoni already has working account,
shop, agent, model-installation, local-inference, runtime, chat, tool, offline-sync, and business
service boundaries. The integration must extend those boundaries; it must not introduce a second
identity provider, model registry, database, chat pipeline, or tool executor.

The three independent lifecycles are currently represented, but not orchestrated by one startup
state machine:

1. Account session: the `grogoni_session` HttpOnly cookie and CP2 `sessions` record.
2. Agent runtime session: CP2 runtime records plus the browser `RuntimeManager` cache.
3. Model installation: device-scoped OPFS metadata plus CP2 installed-model and assignment records.

## 1. Authentication

- Login and signup are panels inside `apps/web/src/GrogoniApplication.tsx`. They support phone/PIN,
  email OTP/PIN recovery, passkeys, and configured OAuth identities.
- `services/api/src/cp2/routes.ts` exposes the existing `/auth/*`, `/api/auth/*`, and `/session`
  routes. `services/api/src/cp2/store.ts` is the authoritative custom CP2 authentication store.
- Successful login creates one opaque session identifier. It is stored only in an HttpOnly
  `grogoni_session` cookie (`Path=/`, `SameSite=Lax`, `Secure` in production) and a `sessions` row.
- The session expires after seven days. There is no short-lived access token, rotating refresh
  credential, refresh-token family, reuse detection, or device-scoped account-session record.
- The existing OAuth refresh token is provider authorization data and is unrelated to Grogoni account
  session restoration.
- Logout revokes the current session; logout-all revokes every account session and clears the
  cookie. Local browser inference account data is also cleared by the frontend logout path.
- `infra/db/schema.ts` and migrations currently define accounts, users, memberships, sessions,
  passkeys, identities, OAuth sessions, session context, and business-scoped device trust. Device
  trust is not a login refresh session and must not be reused as one.
- The current offline behavior restores cached owner/shop/agent UI data, but `session` remains null.
  It therefore does not represent a typed offline-authenticated state and some authenticated
  effects remain disabled.

## 2. Application bootstrap

- `apps/web/src/bootstrap.ts` clears development service-worker caches and imports `main.tsx`.
- `main.tsx` mounts `AppRouter`; `AppRouter` lazy-loads `OwnerApp` or a public/legal route.
- `OwnerApp` restores business, owner contact, agent profile, mode, and route from local storage,
  then asynchronously calls `/session` and validates the cached business membership/profile.
- Shop state is the cached `ActiveBusiness`; agent state is cached `AgentSettings`; server
  validation uses `/roles/check`, shop presence, and agent-profile routes.
- There is no explicit auth-bootstrap state machine or protected-route guard. Login visibility is
  computed synchronously from `ownerAuth`, `isWorkspaceUnlocked`, and modal flags while `/session`
  is still pending.
- A stored owner record initially sets `isWorkspaceUnlocked` false. That can render the login panel
  during silent cookie restoration. A failed or slow bootstrap can leave cached workspace data on
  screen without a precise authenticated/offline/expired distinction.
- Internal routing is History API state in the same mounted application. Route-specific screens
  do not own separate providers, but authentication modal state and cached workspace-lock state
  act as a de-facto guard and can cause login flashes.

## 3. Model interface

- Model-library cards and Agent Profile live in `AgentProfileSurface` inside
  `GrogoniApplication.tsx`.
- GGUF actions call the existing `ai-model-manager.ts` functions for import, predownload, remove,
  validation, and metadata refresh.
- “Use model” calls `useModelWithAgent`; backend models call `useBackendModelWithAgent`.
- A shared busy ref prevents duplicate activation presses. UI labels currently derive from several
  values (`activatingModelId`, assignment readiness, active backend model, local installation).
- The global pending-action banner can collapse distinct progress into “Working…”. Local activation
  has more specific messages, but not a typed activation state machine.

## 4. Model storage

- `apps/web/src/ai-model-manager.ts` is the canonical GGUF installation manager. Model bytes use
  OPFS (`navigator.storage.getDirectory`) when available; metadata is device-scoped in localStorage.
  Completed online installs also use the account AI asset API to keep an authenticated, chunked
  GGUF copy in Neon so another signed-in device can restore its own OPFS installation.
- It validates trusted manifest data, format/architecture/quantization, expected size, checksum,
  storage handle, license, memory estimate, runtime backend, and installation state.
- Browser ONNX inference is separate by artifact/runtime type, not a duplicate GGUF registry:
  `browser-model-registry.ts`, a dedicated Worker, Cache Storage managed by Transformers.js, and
  `grogoni-browser-inference` IndexedDB metadata/state.
- `infra/db/migrations/035_agent_model_assignments.sql` persists CP2 installed-model and assignment
  summaries. They describe a device installation; they do not prove that OPFS bytes still exist.
  `infra/db/migrations/066_account_ai_assets.sql` separately persists account agent manifests and
  chunked GGUF artifacts; a ready artifact is recoverable, but is not itself a runnable device
  installation.

## 5. Agent state

- The active shop is the `business` state plus cached business record.
- The active agent is the business agent profile plus cached `AgentSettings`.
- Backend preferred model is `activeAiModels` in CP2. Device GGUF choice/readiness is the
  `AgentModelAssignmentSummary` plus `DeviceAgentModelAssignment` cache.
- Existing assignment fields include installation ID, model ID, device ID, execution/fallback
  policy, readiness, backend, last successful inference, and last error.
- The browser `runtimeSessionId` is component state and `RuntimeManager` memory only. It is not part
  of the model assignment, is not restored after a reload, and is not a model-installation proof.

## 6. Runtime system

- Shared runtime contracts are in `packages/shared-types/src/index.ts`; deterministic parsing,
  permission metadata, confirmation rules, and the tool registry are in
  `packages/tool-core/src/index.ts`.
- CP2 routes create/list runtime sessions and create/list turns under
  `/businesses/:businessId/runtime/*`.
- `Cp2Store` keeps runtime sessions, turns, and pending confirmations in its authoritative store
  maps and includes them in CP2 snapshots. The current runtime shape is intentionally small:
  business ID, user ID, active status, turn count, and timestamps.
- `apps/web/src/runtime-manager.ts` provides single-flight creation, key scoping, adoption, and one
  replacement retry for an expired/not-found runtime.
- `runtimeSessionId` is created by `createManagedRuntimeSession`, cached by `RuntimeManager`, passed
  to message and runtime-turn APIs, adopted from returned turns, and required for confirmation.
- CP2 `createRuntimeTurn` already creates a runtime when the body omits the ID. Other paths expect
  the frontend to resolve it first. Runtime ownership checks currently verify business and user.

## 7. Inference system

- Native GGUF: `agent-model-runtime.ts` calls the optional trusted Android
  `window.GrogoniAgentModelRuntime` bridge. It performs inspect/load/generate/unload/health and a real
  deterministic warmup inference.
- Browser local: the existing Transformers.js Worker uses WebGPU first and WASM fallback for the
  approved ONNX registry. It streams generation and persists model/cache metadata separately.
- Server adapters under `services/ai-runtime` contact llama.cpp-compatible HTTP, Ollama, or OpenAI;
  they do not embed llama.cpp. Current Render architecture keeps local model execution out of the
  API and gates owner-node/cloud fallbacks.
- `apps/web/src/inference/*` contains provider-neutral capability, routing, consent, and executor
  boundaries. Remote fallback is policy/consent controlled.
- The service worker caches the application shell and handles notifications. It is not an
  inference runtime.

## 8. Chat pipeline

- `ChatSurface` submits into the single `OwnerApp` chat handler.
- The handler persists user messages through `/v1/messages`, routes eligible turns through the
  browser/native executor, and otherwise uses CP2 runtime turns.
- Stable request/client IDs, message outbox retry, browser token callbacks, conversation
  persistence, runtime adoption, and fallback status already exist.
- Server runtime builds shop/agent/business context, attempts the configured model provider, uses
  deterministic parsing when necessary, validates a registered tool, checks permissions, requires
  confirmation, executes the existing business service, stores the turn, and emits telemetry.
- The current native GGUF prompt path generates text, while state-changing actions remain routed
  through the authenticated server runtime. It does not allow model-generated arbitrary code.

## 9. Business tools

- The existing typed runtime registry wraps real CP2 business methods. Current tools include
  product list/create/update/delete/stock adjustment, invoice list/draft, customer creation,
  payment recording, receipt workflows, and document-import confirmation.
- Read-only operations execute after authorization; mutation definitions require confirmation.
- CP2 checks membership/role permission, business scope, runtime actor ownership, validation,
  confirmation token, rate/action limits, and records audit/telemetry events.
- Catalogue, stock, invoices/sales/payments, customers, imports/documents, reporting, settings,
  storefront, and messaging services already exist in CP2 and the main UI. Missing names from the
  requested initial list should extend this registry rather than bypass it.

## 10. Root causes

### “Use model” appeared to do nothing

The card had to coordinate OPFS validation, optional server installation validation, Android bridge
availability, model loading/warmup, assignment persistence, active-model state, and a runtime ID.
Failures were collapsed into a generic busy/banner state, and the assignment could be rolled back
without enough visible stage information. Browser PWA installs also cannot activate GGUF without
the trusted Android bridge.

### Missing `runtimeSessionId`

The ID lived only in React/component memory. Reloading reset it, and older activation/message paths
could call routes that required it before `RuntimeManager.ensureSession` completed. Runtime and model
activation were orchestrated in different functions. The server turn route can auto-create, but
not every caller relied on that recovery.

### Dropdown/card disagreement

The backend active model, device installation metadata, local assignment cache, server assignment,
and live runtime health are distinct values. UI components reconciled them during their own loads.
A preferred/assigned record with a historical successful inference could therefore look ready even
when the local file or live runtime was absent.

### Login/signup loops and flashing

`OwnerApp` has no bootstrap state. Cached owner state can synchronously select the login panel while
the valid HttpOnly cookie is still being checked. Conversely, an offline cached business can be
shown while `session` is null. Shop validation and authentication restoration are separate network
calls, and there is no central definitive-vs-transient auth error classification.

### Runtime failure appearing as authentication failure

The generic request helper exposes HTTP status/message only. It has no structured distinction
between expired account session, forbidden shop, missing runtime, missing installation, runtime
unavailable, or out-of-memory. UI callers sometimes pattern-match messages and share the same
global status surface, allowing runtime recovery errors to look like login failures.

## Implementation direction

The repair should add a small shared auth-bootstrap/authenticated-client boundary, extend the
existing session schema into device-scoped rotating refresh sessions, enrich and restore the
existing runtime manager, centralize active-model reconciliation/activation state, and keep chat
and tool execution on the existing CP2 paths. Account state must only be cleared for definitive
authentication failures or explicit logout; model/runtime failures must update only their own
lifecycle.
