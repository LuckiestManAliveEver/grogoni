# Grogoni Offline Runtime — Implementation Plan & Codex Prompts

Status: Draft v1.0
Owner: Kiarie
Scope: grogoni monorepo (`LuckiestManAliveEver/grogoni`)
Companion docs: `context-semantic-runtime-audit-prompt.md`, `docs/grogoni-web-inference-engine.md`

---

## 0. Design Summary (recap, for anyone opening this cold)

Grogoni Offline Runtime is **not** a cached PWA and **not** a literal clone of the
production backend in a VM. It is a parallel implementation of the same API
contracts that Grogoni's chat UI already calls, resolved by connectivity instead
of hardcoded to Render/Neon.

```
Grogoni canonical API contracts (catalogue.*, orders.*, customers.*, agent.*, tools.*)
        │
        ├── cloud provider   → Render API + Neon Postgres + hosted agent/model
        ├── local provider   → local service layer + SQLite/local store + installed agent/model
        └── peer provider    → BLE/P2P transport to another Grogoni device
```

A resolver (same shape as `resolveExecutionChain()`) picks
`cloud → local → peer` per call, based on connectivity, capability, and
authorization. The chat UI never knows which provider served a call.

Non-negotiables carried over from your notes:

- Going offline is a deliberate, disclaimed action from Settings, not silent degradation.
- Runtime (agent + model) is **pinned** at the moment of going offline and does not
  auto-update on reconnect unless explicitly requested.
- Local storage must leave headroom for other apps on low-spec Android devices.
- Sync on reconnect is operation-log based, not a full-database re-upload.
- P2P (Bitchat-style BLE mesh) is a transport adapter, not new business logic.

---

## 1. Phasing Overview

| Phase | Name                        | Depends on | Output                                                     |
| ----- | --------------------------- | ---------- | ---------------------------------------------------------- |
| 0     | Contract audit              | none       | Canonical API contract inventory                           |
| 1     | Local data layer            | 0          | SQLite schema mirroring Prisma subset                      |
| 2     | Operation log & sync engine | 1          | `sync_operations` table + push/pull protocol               |
| 3     | Local API provider          | 1, 2       | Local implementations of contracts, resolver wiring        |
| 4     | Runtime pinning             | 3          | `device_runtime_pins`, install/pin/swap flow               |
| 5     | Go Offline UX               | 3, 4       | Settings flow, disclaimer, install progress                |
| 6     | P2P transport adapter       | 3          | BLE mesh transport implementing canonical message envelope |
| 7     | Conflict resolution         | 2          | Per-domain merge policies                                  |
| 8     | Validation & staged rollout | all        | Test matrix, feature flag rollout plan                     |

Each phase below has: goal, why it's scoped this way, schema/interface
sketch, and a ready-to-paste Codex prompt. Run phases in order — each prompt
assumes the previous phase's artifacts exist. Do not let Codex jump ahead to
later phases even if it offers to; keep the diffs reviewable.

---

## 2. Phase 0 — Contract Audit

**Goal:** Produce a single inventory of every operation the chat UI currently
performs against the backend (catalogue reads/writes, orders, customers,
agent/tool calls, OCR, auth), each tagged with whether it's read or write,
and whether it's safe to serve from stale local state.

**Why first:** You cannot design the local provider or the sync log without
knowing the full surface area. Skipping this step is how you end up
re-deriving contracts mid-Phase-3.

**Codex Prompt — Phase 0:**

```
Audit the grogoni monorepo and produce docs/offline/contract-inventory.md.

Goal: enumerate every distinct backend operation the chat/message UI and
Sell/Buy intent modes currently invoke, across services/ and apps/.

For each operation, record:
- Operation name (propose a dot-namespaced canonical name, e.g. catalogue.list,
  orders.create, customers.lookup, agent.infer, tools.ocr.scan)
- Current implementation location (file + function/route)
- HTTP method + route if applicable
- Read or write
- Whether the current implementation already has any local/offline handling
- Tables/models touched (cross-reference prisma/schema.prisma)
- Whether staleness is acceptable if served from a local snapshot
  (e.g. catalogue reads = yes, order creation = write, must reconcile)

Do not modify any code. Do not invent operations that don't exist yet — if
the chat UI expects something the backend doesn't implement, flag it as a
gap under a "Gaps" section rather than documenting it as if it exists.

Output as a markdown table grouped by domain (catalogue, orders, customers,
agent/model, tools, auth, misc). End with a short "Coverage risk" section
naming any service directory you could not fully trace calls into.
```

---

## 3. Phase 1 — Local Data Layer

**Goal:** A local, on-device relational store (SQLite via better-sqlite3 or
op-sqlite depending on target: web PWA vs eventual native shell) whose schema
is a deliberately scoped subset of `prisma/schema.prisma` — only the tables
needed to serve the read/write operations flagged in Phase 0 as
offline-relevant.

**Why a subset, not a mirror:** Cloning the full Neon schema locally
reintroduces exactly the complexity your original VM idea had. Only mirror
tables that offline flows actually touch (store, products, orders, customers,
conversations, cart). Anything analytics/reporting-only stays cloud-only and
simply shows "unavailable offline."

**Schema sketch (Prisma, cloud side — defines source of truth for local mirror):**

```prisma
model LocalMirrorTable {
  // not a real cloud table — documents the pattern each mirrored table follows
  id            String   @id
  storeId       String
  payload       Json     // last-known-good snapshot of the row
  cloudUpdatedAt DateTime
  mirroredAt    DateTime @default(now())
}
```

(Actual local schema lives in SQLite, not Prisma — see prompt below for how
to derive it.)

**Codex Prompt — Phase 1:**

```
Using docs/offline/contract-inventory.md (Phase 0 output), design and
implement the local data layer for Grogoni Offline Runtime.

1. From the inventory, select only tables required to serve operations
   marked "offline-relevant". Write the selection rationale to
   docs/offline/local-schema-scope.md, explicitly listing excluded tables
   and why (e.g. "AnalyticsEvent excluded — reporting only, cloud-only").

2. Create packages/offline-runtime/schema/local.sql defining the SQLite
   schema for the selected tables. Field types and constraints should map
   from prisma/schema.prisma as closely as SQLite allows. Add explicit
   columns on every mirrored table for: local_id (uuid, pk), cloud_id
   (nullable, populated once synced), store_id, updated_at_local,
   synced_at (nullable), dirty (boolean).

3. Create packages/offline-runtime/db/client.ts exporting a typed local DB
   client (prefer drizzle-orm with the better-sqlite3 driver, matching the
   TypeScript-first pattern already used in services/). Do not use Prisma's
   SQLite provider — this must be a separate lightweight client so it can
   run in a browser/WASM context later.

4. Write packages/offline-runtime/db/migrations/ with an initial migration
   and a migration runner invoked on local-runtime install (Phase 5 will
   call this). Do not implement Phase 5 yet.

5. Add unit tests seeding the local DB and asserting schema constraints
   (foreign keys, not-null, dirty flag default).

Do not implement sync logic yet (Phase 2). Do not touch resolveExecutionChain
or any existing cloud service code in this phase.
```

---

## 4. Phase 2 — Operation Log & Sync Engine

**Goal:** Every offline mutation is recorded as an immutable, ordered
operation, not just a row update. Reconnect syncs by exchanging operations
since a cursor, not by diffing/uploading whole tables.

**Schema:**

```prisma
model SyncOperation {
  id              String   @id @default(cuid())
  deviceId        String
  storeId         String
  localSeq        Int      // monotonic per-device sequence
  opType          String   // e.g. "orders.create", "catalogue.update"
  entityTable     String
  entityLocalId   String
  entityCloudId   String?
  payload         Json
  createdAtLocal  DateTime
  syncedAt        DateTime?
  syncStatus      SyncStatus @default(PENDING)
  serverOpId      String?    // set once acknowledged
  conflictInfo    Json?

  @@index([storeId, syncStatus])
  @@index([deviceId, localSeq])
}

enum SyncStatus {
  PENDING
  PUSHED
  ACKED
  REJECTED
  CONFLICT
}

model SyncCursor {
  deviceId   String   @id
  storeId    String
  lastPulledServerSeq BigInt @default(0)
  lastPushedLocalSeq  Int    @default(0)
  updatedAt  DateTime @updatedAt
}
```

**Sync protocol (push/pull), high level:**

```
Device                                   Server
  │── POST /sync/push { ops: [...] } ───────▶│
  │                                           │ validate + apply each op
  │                                           │ (deterministic assertions first —
  │                                           │  reuse Evaluation/Report Card
  │                                           │  hard-gate layer where applicable)
  │◀── { acked: [...], rejected: [...],     ──│
  │      conflicts: [...] }                   │
  │                                           │
  │── GET /sync/pull?since=cursor ──────────▶│
  │◀── { ops: [...], newCursor } ────────────│
```

**Codex Prompt — Phase 2:**

```
Implement the sync engine for Grogoni Offline Runtime on top of the local
schema from Phase 1 (packages/offline-runtime/schema/local.sql) and
docs/offline/local-schema-scope.md.

1. Add SyncOperation, SyncStatus, and SyncCursor to prisma/schema.prisma
   (cloud side) per the design in docs/offline/grogoni-offline-runtime-implementation.md
   section 4. Generate the migration but do not apply it to any shared
   environment — leave that for me to run explicitly.

2. Add a matching sync_operations local table to
   packages/offline-runtime/schema/local.sql (Phase 1 pattern: local_id,
   dirty flag, synced_at etc. still apply).

3. Implement packages/offline-runtime/sync/writer.ts: every local mutation
   (from the local API provider — stub the interface if Phase 3 doesn't
   exist yet, do not implement Phase 3 here) must go through
   recordOperation(opType, entityTable, entityLocalId, payload) which writes
   to the local sync_operations table with status PENDING before touching
   the entity table itself, in the same local transaction.

4. Implement services/sync-api/ (new service, or add to existing API service
   if there's already a natural home — check services/ layout first and
   note your choice) with two endpoints:
   - POST /sync/push — accepts a batch of ops, applies them idempotently
     (dedupe by deviceId+localSeq), runs them through existing
     deterministic validation where the entity type already has it
     (reuse, don't duplicate, any existing Evaluation/Report Card
     deterministic assertions), and returns per-op ack/reject/conflict.
   - GET /sync/pull — returns ops since a given cursor for the requesting
     store, ordered by server sequence.

5. Implement packages/offline-runtime/sync/client.ts with push() and pull()
   functions that call these endpoints and update local SyncCursor and
   per-op syncStatus accordingly. Include exponential backoff and a
   dead-letter path for ops that fail validation 3+ times (mark CONFLICT,
   do not retry silently).

6. Write integration tests: create ops offline, push, verify server state;
   simulate two devices editing the same entity offline, push both, assert
   the second push surfaces a CONFLICT rather than silently overwriting.

Do not implement conflict resolution policy yet (Phase 7) — CONFLICT status
should just be surfaced, not auto-resolved. Do not implement the local API
provider (Phase 3) or resolver wiring in this phase.
```

---

## 5. Phase 3 — Local API Provider & Resolver Wiring

**Goal:** Implement local versions of the Phase-0 contracts backed by the
Phase-1 store, and wire them into a `resolveExecutionChain`-style resolver so
the chat UI's calls transparently route `cloud → local → peer`.

**Interface sketch:**

```ts
interface GrogoniProvider {
  name: "cloud" | "local" | "peer";
  supports(op: string): boolean;
  isAvailable(): Promise<boolean>;
  call<T>(op: string, args: unknown): Promise<T>;
}

async function resolveProviderChain(op: string): Promise<GrogoniProvider[]> {
  // mirrors resolveExecutionChain() pattern from the Agent Execution Fabric refactor
}
```

**Codex Prompt — Phase 3:**

```
Implement the local API provider and provider resolver for Grogoni Offline
Runtime, using docs/offline/contract-inventory.md and the local DB client
from Phase 1.

1. Read packages/*/resolveExecutionChain* (or wherever it currently lives
   after the Agent Execution Fabric refactor) to confirm the exact resolver
   pattern already in use — fallback chain shape, how bindings are resolved,
   how failures propagate. Reuse this pattern's conventions rather than
   inventing a new resolver shape.

2. Define the GrogoniProvider interface in
   packages/offline-runtime/providers/types.ts per the sketch in
   docs/offline/grogoni-offline-runtime-implementation.md section 5.

3. Implement packages/offline-runtime/providers/local-provider.ts covering
   every operation from the contract inventory marked offline-relevant,
   reading/writing via the Phase 1 local DB client and recording mutations
   via Phase 2's recordOperation().

4. Implement packages/offline-runtime/providers/resolver.ts:
   resolveProviderChain(op) returns [cloud, local, peer] filtered by
   supports(op) and current connectivity, cloud first when online. This
   must NOT hardcode "if offline use local" — connectivity is one input,
   capability (does this provider implement this op at all) is another,
   and they're checked independently.

5. Wire the chat UI's existing API call sites (identified in the contract
   inventory) to go through resolveProviderChain instead of calling the
   cloud API client directly. Do this as a thin adapter layer so existing
   call sites change minimally — do not restructure the chat UI itself.

6. Add a peer-provider stub in
   packages/offline-runtime/providers/peer-provider.ts that implements the
   GrogoniProvider interface but throws NotImplemented for every op — this
   makes the resolver chain complete without pulling in Phase 6 yet.

7. Tests: force cloud unavailable, assert local provider serves reads
   correctly and writes go through recordOperation; force both cloud and
   local unsupported for an op, assert a clear "unavailable" error surfaces
   to the UI layer rather than a silent failure.

Do not implement Phase 4 (runtime pinning) or Phase 6 (real peer transport)
in this pass.
```

---

## 6. Phase 4 — Runtime Pinning (Agent/Model)

**Goal:** When a user goes offline, the exact agent + model
artifact versions in use at that moment are pinned locally and do not change
on reconnect unless the user explicitly swaps them.

**Schema:**

```prisma
model DeviceRuntimePin {
  id            String   @id @default(cuid())
  deviceId      String
  storeId       String
  agentId       String
  agentVersion  String
  modelId       String
  modelVersion  String
  pinnedAt      DateTime @default(now())
  explicitSwap  Boolean  @default(false) // true if user-initiated change since pin
  active        Boolean  @default(true)

  @@unique([deviceId, storeId])
}
```

**Codex Prompt — Phase 4:**

```
Implement runtime pinning for Grogoni Offline Runtime.

1. Add DeviceRuntimePin to prisma/schema.prisma per
   docs/offline/grogoni-offline-runtime-implementation.md section 6. Generate
   the migration only, do not apply.

2. Add a matching local table to packages/offline-runtime/schema/local.sql.

3. Implement packages/offline-runtime/runtime/pin.ts:
   - pinCurrentRuntime(deviceId, storeId) — reads the currently active
     agent/model binding (reuse whatever the runtime binding tables from
     the Agent Execution Fabric refactor expose — check
     agent_model_bindings) and writes a DeviceRuntimePin row locally.
   - getActivePin(deviceId, storeId) — returns the pinned runtime.
   - swapPinnedRuntime(deviceId, storeId, agentId, modelId) — the ONLY
     function allowed to change a pin outside of the initial pinCurrentRuntime
     call. Sets explicitSwap = true.

4. Wire the local-provider's agent.infer operation (from Phase 3) to always
   resolve the model/agent via getActivePin() when running offline, never
   via whatever the cloud's current default binding is.

5. On sync/pull (Phase 2's client.ts), explicitly assert that pulling
   business-data operations never touches DeviceRuntimePin — write a test
   that pulls a batch of ops including a hypothetical runtime-change event
   from another device and asserts the local pin is unaffected unless
   swapPinnedRuntime is called directly by the user on this device.

6. Tests: pin a runtime, simulate the cloud's default binding changing,
   go offline and back online, assert local inference still uses the
   originally pinned agent/model.
```

---

## 7. Phase 5 — Go Offline UX Flow

**Goal:** Implement the actual Settings → Go Offline flow from your notes:
disclaimer, install/download progress (framed as "installing an operating
system," per note vii), storage sizing check, and reconnect sync
notification.

**Codex Prompt — Phase 5:**

```
Implement the Go Offline user flow in the chat/message UI, per the notes in
docs/offline/grogoni-offline-runtime-implementation.md section 7 and the
current drawer-pattern component work (single unified drawer, modules-not-
windows discipline — check the current chat drawer rebuild before adding
new UI so this doesn't fork the pattern).

1. Add a "Go Offline" action to the Settings section. On tap, show a
   disclaimer modal (as a module, not a route) stating in plain language:
   what will be downloaded (business data snapshot, local runtime, pinned
   agent/model), approximate storage required, and that other apps' storage
   headroom is preserved. Require explicit confirmation.

2. On confirm, run the local-runtime install sequence:
   a. Check available device storage; if insufficient, block with a clear
      message rather than partial-installing.
   b. Run Phase 1's migration runner to initialize local schema.
   c. Fetch current store snapshot via the existing cloud API and populate
      local tables (this is the one-time "download current instance"
      step from the original notes — implement it as a bulk read into the
      Phase 1 schema, not as a database file transfer).
   d. Call pinCurrentRuntime() (Phase 4).
   e. Download the pinned model/agent artifact to local storage if not
      already cached (check what artifact storage/caching already exists
      for model templates before building a new download path).
   f. Flip a local `offlineModeActive` flag that the Phase 3 resolver reads
      to prefer local-first even when connectivity is technically present
      (explicit offline mode should not silently fall back to cloud just
      because a network blip resolves).
   Show real progress for each step, not a generic spinner.

3. When connectivity returns while offlineModeActive is true, show a
   non-blocking notification offering to sync (Phase 2's push/pull), not an
   automatic silent sync — the user should see what's about to go up.

4. Add a "Go back online" action that flips offlineModeActive off after a
   successful sync, or offers to sync-then-switch if there are pending ops.

Do not implement the P2P transport (Phase 6) in this pass — leave a
disabled/"coming soon" affordance for "connect to nearby users" if you add
any UI for it, per the original notes' mesh networking mention.
```

---

## 8. Phase 6 — P2P Transport Adapter (Bitchat-style)

**Goal:** Offline-to-offline device communication over BLE mesh, implemented
as a transport adapter under the same canonical message envelope used
online — not new business logic.

**Codex Prompt — Phase 6:**

```
Research and prototype a P2P transport adapter for Grogoni Offline Runtime,
modeled on Bitchat's BLE mesh approach, before writing production code.

1. Write docs/offline/p2p-transport-research.md summarizing: Bitchat's
   general architecture (BLE mesh, store-and-forward, message framing) at
   a level sufficient to inform an adapter design — do not reproduce any
   of Bitchat's source, only describe the architecture in your own words
   and cite where you're drawing from.

2. Define the canonical message envelope Grogoni already uses for
   conversation messages (check the chat/message subsystem) and confirm
   whether it can be transported as-is over a size-constrained BLE channel,
   or needs a compact binary encoding for this adapter specifically. Note
   the decision and why in the same doc.

3. Implement packages/offline-runtime/providers/peer-provider.ts (replacing
   the Phase 3 stub) with:
   - discover() — scan for nearby Grogoni devices advertising over BLE
   - connect(deviceId) — establish a mesh link
   - send(envelope) / onReceive(handler) — canonical envelope in, canonical
     envelope out; no business logic in this file
   - store-and-forward queuing for when no direct link exists but a
     multi-hop path might

4. Wire peer-provider into the Phase 3 resolver as the final fallback for
   ops explicitly marked "peer-capable" in the contract inventory (most
   ops will NOT be peer-capable — start with just conversation messages).

5. Flag platform constraints clearly: BLE mesh capability differs
   significantly between web PWA (limited/no BLE) and any future native
   shell. Document what's actually achievable in the current PWA target
   vs. what requires a native wrapper, rather than assuming parity.

Treat this phase as research-and-prototype, not a production merge — end
with a short recommendation on whether to proceed given PWA platform
constraints.
```

---

## 9. Phase 7 — Conflict Resolution Policy

**Goal:** Define, per entity domain, what happens when a CONFLICT surfaces
from Phase 2's sync engine.

**Codex Prompt — Phase 7:**

```
Design and implement conflict resolution policies for Grogoni Offline Runtime
sync, building on the CONFLICT status introduced in Phase 2.

1. Using docs/offline/contract-inventory.md, write
   docs/offline/conflict-policies.md assigning one policy per entity domain:
   - last-write-wins (with server timestamp as tiebreak)
   - server-wins (cloud is authoritative, local change discarded with
     user notification)
   - merge (field-level merge, specify exact rule per field)
   - manual (surface to user for explicit resolution — reserve this for
     cases where silent resolution would be commercially risky, e.g.
     conflicting order status)
   Default to the most conservative option per domain unless you can
   justify a more automatic one.

2. Implement packages/offline-runtime/sync/conflict-resolver.ts applying
   these policies during sync/push handling (services/sync-api/), reusing
   the deterministic-assertion-first structure from the Evaluation/Report
   Card reward hierarchy where a conflict resolution decision is itself a
   candidate for that same hard-gated validation.

3. For "manual" policy conflicts, implement a local
   pending_conflicts surface (local table + minimal UI module in the chat
   drawer) so the user can see and resolve them rather than them
   disappearing silently.

4. Tests covering each policy type with concocted two-device conflicting
   edits.
```

---

## 10. Phase 8 — Validation & Staged Rollout

**Codex Prompt — Phase 8:**

```
Prepare Grogoni Offline Runtime for staged rollout.

1. Write docs/offline/test-matrix.md covering: fresh install offline flow,
   airplane-mode mid-session transition, reconnect-and-sync with no
   conflicts, reconnect-and-sync with conflicts across each policy type
   from Phase 7, low-storage-device install rejection, runtime pin
   stability across a cloud-side default-binding change, and (if Phase 6
   shipped) two-device peer message exchange with no internet.

2. Add a feature flag (matching the EXECUTION_FABRIC_ENABLED pattern used
   for the Agent Execution Fabric rollout) named OFFLINE_RUNTIME_ENABLED,
   defaulting to false. Gate the Settings "Go Offline" entry point behind
   it.

3. Write a rollout plan in docs/offline/rollout-plan.md: internal dogfood
   first (name the smallest test group), storage/perf telemetry to watch
   before wider enablement, and an explicit rollback path (what happens to
   a device mid-offline-session if the flag is flipped back off centrally
   — it should NOT strand the device without sync).

Do not enable the flag in any shared environment.
```

---

## 11. Open Questions to Resolve Before Phase 1

- **Local runtime target:** web PWA only for now, or building toward a
  native shell? This materially affects SQLite driver choice (Phase 1) and
  whether Phase 6 (BLE) is even reachable on the current platform.
- **Model artifact size vs. device storage:** what's the realistic minimum
  spec for "install a pinned model locally" on the low-spec Android
  hardware you're targeting for Piano Architecture? Worth resolving that
  evaluation before Phase 5 commits to a download-on-go-offline UX.
- **Sync service placement:** new `services/sync-api` vs. folding into the
  existing API service — Phase 2's prompt asks Codex to check current
  layout and report back rather than presupposing.
