/**
 * Runtime Handoff Protocol types.
 *
 * See docs/architecture/runtime-handoff-protocol.md for the full design. In short: a
 * `RuntimeHandoff` is an immutable, portable checkpoint of a task's in-flight execution state -
 * independent of conversation transcript, agent, model, execution host, provider, and runtime
 * process. Swapping any of those repoints execution to a new handoff instead of replaying chat
 * history.
 *
 * Grogoni has no separate `tasks` entity distinct from `conversations` (see
 * cp2/domains/native-runtime/store.ts): a conversation is the unit of runtime execution, so
 * `taskId` is always populated with the owning conversation's id today. The field stays named
 * `taskId` throughout so a future task/conversation split only has to add a real `tasks` table,
 * not rename this protocol.
 */

export type RuntimeSwapDimension = "agent" | "model" | "host";

export type RuntimeActionStatus = "pending" | "completed" | "failed";

/** A concrete unit of work the runtime has done, is doing, or intends to do. Deliberately narrow
 *  and extensible (an index signature of `unknown`) rather than untyped `Record<string, unknown>`
 *  blobs, per the protocol's "no `any`" requirement - callers get real field types for the parts
 *  every consumer needs, and can still round-trip caller-specific metadata. */
export interface RuntimeAction {
  id: string;
  description: string;
  status?: RuntimeActionStatus;
  metadata?: Record<string, unknown>;
}

export interface RuntimeDecision {
  id: string;
  description: string;
  rationale: string | null;
  decidedAt: string;
}

export interface RuntimeRejectedPath {
  id: string;
  description: string;
  reason: string;
}

export type RuntimeContextReferenceKind =
  "recall" | "message" | "document" | "artifact" | "external";

/** A pointer into durable state (recall, a conversation message, a stored document, ...) - never
 *  the content itself. Keeping this a reference, not a copy, is what keeps `recall` (long-term
 *  memory) and conversation transcripts out of the handoff row; see invariant 1.4 and section 19
 *  of the protocol design doc. */
export interface RuntimeContextReference {
  kind: RuntimeContextReferenceKind;
  refId: string;
  description?: string;
}

export interface RuntimeArtifactReference {
  id: string;
  kind: string;
  uri: string;
  description?: string;
}

export interface RuntimeTestResults {
  passed: string[];
  failed: string[];
  pending: string[];
}

/** The runtime binding snapshot a handoff was created under. References Grogoni's actual native
 *  runtime graph entities (cp2_native_runtime_agents / cp2_native_runtime_models /
 *  cp2_native_execution_hosts), not a generic `agents`/`models`/`execution_hosts` schema. */
export interface RuntimeHandoffRuntimeRef {
  agentId: string;
  modelId: string;
  executionHostId: string;
}

/** An immutable, portable checkpoint of one task's in-flight execution state. Never updated after
 *  creation (invariant 1.1) - a new state always means a new row, with `parentHandoffId` pointing
 *  at the previous one. Whether a given handoff is the task's *current* checkpoint is determined
 *  by `RuntimeTaskHead.activeHandoffId`, never by a field on this object. */
export interface RuntimeHandoff {
  id: string;
  taskId: string;
  conversationId: string;

  parentHandoffId: string | null;
  /** Additional ancestor checkpoints beyond `parentHandoffId`, populated only for a merge
   *  checkpoint (created by `mergeCheckpoints`/`POST .../merge`) that unifies two or more offline
   *  branches - see "Offline causal ancestry" in the protocol doc. Empty for every ordinary
   *  (non-merge) checkpoint. `parentHandoffId` plus this array together are the checkpoint's full
   *  causal ancestry; a merge's `parentHandoffId` is its first branch tip and this array holds the
   *  rest, so `[parentHandoffId, ...mergedFromHandoffIds]` is the complete parent set. */
  mergedFromHandoffIds: string[];

  goal: string;
  currentState: string;

  completedActions: RuntimeAction[];
  decisions: RuntimeDecision[];
  rejectedPaths: RuntimeRejectedPath[];

  pendingActions: RuntimeAction[];
  nextAction: string | null;

  relevantContext: RuntimeContextReference[];
  artifacts: RuntimeArtifactReference[];

  tests: RuntimeTestResults;

  runtime: RuntimeHandoffRuntimeRef;

  /** Cloud-authoritative ordering, assigned atomically by the task head's version counter when the
   *  checkpoint is created online, or by `syncOfflineCheckpoints`/`POST .../checkpoints/sync` when
   *  a checkpoint created offline is later synchronized (see "Offline causal ancestry" in the
   *  protocol doc). A handoff is only ever null here between offline creation and sync - once
   *  synced it is permanent, like every other field on an immutable handoff row. */
  checkpointVersion: number | null;
  schemaVersion: number;

  createdAt: string;
}

/** The authoritative mutable pointer for a task's current execution state (invariant 1.2).
 *  Never derive "which handoff is active" from a status field on a handoff row - this is the
 *  only place that answer lives. */
export interface RuntimeTaskHead {
  taskId: string;
  activeHandoffId: string;
  nextCheckpointVersion: number;
  updatedAt: string;
}

/** Runtime health is independent of task state (section 12) - a valid task head can coexist with
 *  a FAILED runtime instance. */
export type RuntimeTaskInstanceStatus =
  "STARTING" | "READY" | "RUNNING" | "DEGRADED" | "FAILED" | "STOPPED";

/** The checkpoint this task's current executor *believes* it is running, plus its lifecycle
 *  status. Comparing `activeHandoffId` here against `RuntimeTaskHead.activeHandoffId` for the
 *  same task is runtime drift detection (section 5/12). This is the closest Grogoni has to the
 *  protocol's generic "runtime_instances" concept for a per-task executing process; it is
 *  intentionally a new, narrow table rather than an extension of `cp2_runtime_sessions`, which is
 *  a distinct business/user-scoped agentic-planner concept (see invariant 1.4).
 *
 *  `fenceToken`/`executionId` (durable-execution-plane.md "Fencing") identify *which* execution
 *  attempt currently owns this task. Every rebind (`performSwap`, `completeTransfer`, `resume`)
 *  mints a new `executionId` and strictly increases `fenceToken`. A commit that captured an older
 *  fence token (e.g. an ordinary chat turn that started before a handoff completed) must be
 *  rejected rather than silently applied - see `RuntimeHandoffDomain.checkpointAfterTurn`. Both
 *  fields default to `0`/a synthesized id on restore from a pre-fencing snapshot (see
 *  `RuntimeHandoffDomain.restore`), matching this codebase's existing `legacy.field ?? default`
 *  convention for additive record fields. */
export interface RuntimeTaskInstance {
  taskId: string;
  activeHandoffId: string | null;
  status: RuntimeTaskInstanceStatus;
  agentId: string | null;
  modelId: string | null;
  executionHostId: string | null;
  lastError: string | null;
  updatedAt: string;
  fenceToken: number;
  executionId: string;
}

// ---------------------------------------------------------------------------------------------
// Durable execution event log (durable-execution-plane.md "Event lifecycle"). Append-only,
// sequence-numbered per task; never mutated after insertion. Distinct from RuntimeHandoff
// (checkpoint) history - this is a fine-grained trace of *what happened*, not a resumable
// snapshot. See infra/db/migrations/087_runtime_execution_events.sql.
// ---------------------------------------------------------------------------------------------

export type RuntimeExecutionEventType =
  | "TASK_CREATED"
  | "BINDING_RESOLUTION_STARTED"
  | "BINDING_RESOLVED"
  | "AUTHORIZATION_STARTED"
  | "AUTHORIZATION_COMPLETED"
  | "AUTHORIZATION_DENIED"
  | "CONTEXT_RESOLUTION_STARTED"
  | "CONTEXT_RESOLVED"
  | "CAPABILITIES_RESOLVED"
  | "EXECUTION_STARTED"
  | "MODEL_INVOCATION_STARTED"
  | "MODEL_INVOCATION_COMPLETED"
  | "MODEL_INVOCATION_FAILED"
  | "TOOL_REQUESTED"
  | "TOOL_AUTHORIZED"
  | "TOOL_DENIED"
  | "TOOL_STARTED"
  | "TOOL_COMPLETED"
  | "TOOL_FAILED"
  | "CHECKPOINT_CREATED"
  | "EXECUTION_SUSPENDED"
  | "EXECUTION_RESUMED"
  | "HANDOFF_STARTED"
  | "HANDOFF_COMPLETED"
  | "HANDOFF_FAILED"
  | "RUNTIME_REBOUND"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_FAILED"
  | "EXECUTION_CANCELLED"
  /** Beyond the spec's required list: an explicit, observable record of a fencing rejection - see
   *  RuntimeTaskInstance's fenceToken doc. Never contains the rejected mutation's content, only
   *  the fence tokens compared. */
  | "EXECUTION_FENCE_REJECTED";

/** One row in the durable execution event log. Never contains secrets, raw credentials, auth
 *  tokens, or customer PII in `payload` - only identifiers, counts, and typed status fields (same
 *  discipline `RuntimeTelemetryEvent` already applies). */
export interface RuntimeExecutionEvent {
  id: string;
  taskId: string;
  sequenceNumber: number;
  /** Opaque per-attempt identifier - either a runtime-turn id or a task-instance `executionId`
   *  (see RuntimeTaskInstance). Null for task-level events with no single owning attempt. */
  executionId: string | null;
  runtimeInstanceId: string | null;
  executionHostId: string | null;
  eventType: RuntimeExecutionEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** `runtime.inspect(taskId)` result (durable-execution-plane.md "Runtime inspection API"). Enough
 *  to diagnose a task without exposing secrets. */
export interface RuntimeInspection {
  taskId: string;
  taskHead: RuntimeTaskHead;
  activeHandoff: RuntimeHandoff;
  runtimeInstance: RuntimeTaskInstance | null;
  isRuntimeStale: boolean;
  activeTransfer: RuntimeTransfer | null;
  latestEvents: RuntimeExecutionEvent[];
  lastSuccessfulEventType: RuntimeExecutionEventType | null;
  resumeEligible: boolean;
  resumeBlockedReason: string | null;
}

/** resolveHandoff()'s return shape - kept analogous to `resolveExecutionChain`/
 *  `resolveRuntimeBinding` so callers never reconstruct this state by hand across repositories. */
export interface ResolvedRuntimeHandoff {
  taskId: string;
  conversationId: string;
  activeHandoff: RuntimeHandoff;
  taskHead: RuntimeTaskHead;
  runtimeInstance: RuntimeTaskInstance | null;
  isRuntimeStale: boolean;
}

export interface RuntimeCheckpointCreateInput {
  taskId: string;
  goal?: string;
  currentState?: string;
  completedActions?: RuntimeAction[];
  decisions?: RuntimeDecision[];
  rejectedPaths?: RuntimeRejectedPath[];
  pendingActions?: RuntimeAction[];
  nextAction?: string | null;
  relevantContext?: RuntimeContextReference[];
  artifacts?: RuntimeArtifactReference[];
  testsPassed?: string[];
  testsFailed?: string[];
  testsPending?: string[];
  /** When true, also moves the task head to the newly created checkpoint (section 6, step 7).
   *  When false, the checkpoint is recorded in history without becoming authoritative. */
  promote?: boolean;
  /** Optimistic concurrency guard (section 7): required whenever `promote` is true. */
  expectedHandoffId?: string;
  /** Execution fencing (durable-execution-plane.md "Fencing"), checked only when `promote` is
   *  true. The fence token this caller captured (e.g. from `GET .../inspect`) when it started the
   *  work this checkpoint reports - lets any out-of-process caller (not just an ordinary chat
   *  turn, which uses the same mechanism internally via `checkpointAfterTurn`) get the same
   *  stale-execution protection. Omit to skip the check, matching this field's behavior before it
   *  existed. */
  expectedFenceToken?: number | null;
  idempotencyKey?: string | null;
}

// `actorId` is deliberately absent from every mutation input above and below: it is always the
// authenticated caller (resolved from the session, server-side), never a client-supplied field -
// see RuntimeHandoffDomain.resolveActorId in cp2/domains/runtime-handoff/store.ts.

export interface RuntimeCheckpointResult {
  handoff: RuntimeHandoff;
  taskHead: RuntimeTaskHead;
  promoted: boolean;
}

export interface RuntimeSwapInput {
  taskId: string;
  dimension: RuntimeSwapDimension;
  targetId: string;
  expectedHandoffId?: string;
  idempotencyKey?: string | null;
}

export interface RuntimeSwapResult {
  handoff: RuntimeHandoff;
  taskHead: RuntimeTaskHead;
  runtimeInstance: RuntimeTaskInstance;
  /** Always false: activation is now validated before any commit, so a failure throws instead of
   *  landing here as a soft, post-commit degraded state. Kept for API/type compatibility with
   *  existing clients rather than as a branch any current caller needs to handle. */
  activationFailed: boolean;
  activationError: string | null;
}

export interface RuntimeRollbackInput {
  taskId: string;
  targetHandoffId: string;
  expectedHandoffId?: string;
  idempotencyKey?: string | null;
}

export interface RuntimeRollbackResult {
  taskHead: RuntimeTaskHead;
  activeHandoff: RuntimeHandoff;
}

export interface RuntimeResumeInput {
  taskId: string;
}

export interface RuntimeResumeResult {
  taskHead: RuntimeTaskHead;
  activeHandoff: RuntimeHandoff;
  runtimeInstance: RuntimeTaskInstance;
  /** True when this call had to synthesize the task's first handoff from legacy (pre-protocol)
   *  conversation/binding state because none existed yet (section 20). */
  bootstrapped: boolean;
}

// ---------------------------------------------------------------------------------------------
// Offline causal ancestry: a task can branch while offline (multiple checkpoints created locally
// off the same parent, on different devices or during a network partition) and later merge back
// into one canonical line. See "Offline causal ancestry" in the protocol doc.
// ---------------------------------------------------------------------------------------------

/** One checkpoint as created by an offline client: everything an online checkpoint has, minus
 *  `taskId`/`conversationId` (supplied by the sync call's context) and `checkpointVersion` (never
 *  client-assigned - see RuntimeHandoff.checkpointVersion). `id` and `createdAt` *are*
 *  client-supplied here, unlike every other mutation in this protocol: the client already used
 *  `id` as another offline checkpoint's `parentHandoffId` before syncing, and `createdAt` should
 *  reflect when the checkpoint actually happened offline, not when it happened to reach the
 *  server. Neither drives any authorization or ordering decision - `checkpointVersion` (assigned
 *  at sync time) is what cloud-authoritative ordering actually uses. */
export interface RuntimeOfflineCheckpointInput {
  id: string;
  parentHandoffId: string | null;
  goal: string;
  currentState: string;
  completedActions: RuntimeAction[];
  decisions: RuntimeDecision[];
  rejectedPaths: RuntimeRejectedPath[];
  pendingActions: RuntimeAction[];
  nextAction: string | null;
  relevantContext: RuntimeContextReference[];
  artifacts: RuntimeArtifactReference[];
  tests: RuntimeTestResults;
  runtime: RuntimeHandoffRuntimeRef;
  schemaVersion: number;
  createdAt: string;
}

export interface RuntimeOfflineSyncInput {
  taskId: string;
  /** Must be in causal order: a checkpoint's `parentHandoffId`, if not null, must already exist
   *  server-side (from a prior sync) or appear earlier in this same array. */
  checkpoints: RuntimeOfflineCheckpointInput[];
  /** When true, moves the task head to `promoteToHandoffId` (default: the last checkpoint in
   *  `checkpoints`) once every checkpoint in the batch is synced. */
  promote?: boolean;
  promoteToHandoffId?: string;
  expectedHandoffId?: string;
  idempotencyKey?: string | null;
}

export interface RuntimeOfflineSyncResult {
  /** One entry per input checkpoint, in the same order - each now carrying a server-assigned
   *  `checkpointVersion`. A checkpoint whose `id` already existed (a retried sync) is returned
   *  as-is rather than re-inserted. */
  syncedHandoffs: RuntimeHandoff[];
  taskHead: RuntimeTaskHead;
}

/** Unifies two or more branch tips (offline or online) into one new checkpoint.
 *  `branchHandoffIds[0]` becomes the merge checkpoint's `parentHandoffId`; the rest become
 *  `mergedFromHandoffIds`. The merged goal/state/actions/etc. are supplied explicitly by the
 *  caller (arbitrary N-way conflict resolution across divergent action lists is out of scope for
 *  this protocol) - omitted fields default to `branchHandoffIds[0]`'s. */
export interface RuntimeMergeInput {
  taskId: string;
  branchHandoffIds: string[];
  goal?: string;
  currentState?: string;
  completedActions?: RuntimeAction[];
  decisions?: RuntimeDecision[];
  rejectedPaths?: RuntimeRejectedPath[];
  pendingActions?: RuntimeAction[];
  nextAction?: string | null;
  relevantContext?: RuntimeContextReference[];
  artifacts?: RuntimeArtifactReference[];
  testsPassed?: string[];
  testsFailed?: string[];
  testsPending?: string[];
  expectedHandoffId: string;
  idempotencyKey?: string | null;
}

export interface RuntimeMergeResult {
  handoff: RuntimeHandoff;
  taskHead: RuntimeTaskHead;
}

/** Mutable transfer progress; RuntimeHandoff itself remains an immutable checkpoint. */
export type RuntimeTransferStatus =
  | "PENDING"
  | "CHECKPOINTING"
  | "CHECKPOINTED"
  | "TARGET_ACTIVATING"
  | "RESTORING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED";
export interface RuntimeTransfer {
  id: string;
  taskId: string;
  accountId: string;
  businessId: string | null;
  deviceId: string;
  idempotencyKey: string;
  sourceHandoffId: string;
  checkpointId: string | null;
  sourceHostId: string;
  targetHostId: string;
  status: RuntimeTransferStatus;
  failureCode: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
export interface RuntimeHostCapability {
  executionHostId: string;
  type: string;
  supported: boolean;
  configured: boolean;
  available: boolean;
  healthy: boolean;
  reachable: boolean;
  active: boolean;
  reason: string | null;
}
export interface RuntimeCapabilities {
  hosted: RuntimeHostCapability[];
  local: RuntimeHostCapability[];
  handoff: { supported: boolean; available: boolean; reason: string | null };
  activeExecutionHostId: string | null;
  activeTransfer: RuntimeTransfer | null;
}
export interface RuntimeRestoreReceipt {
  handoffId: string;
  agentId: string;
  modelId: string;
  harness: boolean;
  artifacts: boolean;
  protectedContext: boolean;
  businessState: boolean;
}

/** Location remains independent of agent/model identity and inference provider. */
export function isLocalRuntimeHost(type: string): boolean {
  return ["browser", "browser-local", "installed-app", "remote-shop-device"].includes(type);
}
