import type { RuntimeTurnSummary } from "@grogoni/shared-types";
import { isLocalRuntimeHost } from "@grogoni/shared-types";
import type {
  NativeExecutionHostSummary,
  RuntimeCapabilities,
  RuntimeHostCapability,
  RuntimeTransfer,
  RuntimeTransferStatus,
  RuntimeRestoreReceipt,
  RuntimeExecutionEvent,
  RuntimeExecutionEventType,
  RuntimeInspection
} from "@grogoni/shared-types";
/**
 * Runtime Handoff Protocol domain (see docs/architecture/runtime-handoff-protocol.md).
 *
 * Like every other CP2 domain in this codebase, this class is an in-memory, synchronously
 * mutated store: Cp2Store methods never `await` between reading and writing these Maps, so a
 * single process can never interleave two calls against them. That is what makes
 * `allocateAndInsertCheckpoint` (the one shared version-allocation/task-head-move primitive
 * section 6.1 requires) safe without an explicit lock. This requires one authoritative API
 * writer. The database unique index and snapshot advisory lock are additional integrity guards;
 * LISTEN/NOTIFY does not synchronize independently mutated in-memory domain stores.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  AuthSessionView,
  ConversationSummary,
  ResolvedRuntimeHandoff,
  RuntimeAction,
  RuntimeArtifactReference,
  RuntimeCheckpointCreateInput,
  RuntimeCheckpointResult,
  RuntimeContextReference,
  RuntimeDecision,
  RuntimeHandoff,
  RuntimeMergeInput,
  RuntimeMergeResult,
  RuntimeOfflineCheckpointInput,
  RuntimeOfflineSyncInput,
  RuntimeOfflineSyncResult,
  RuntimeRejectedPath,
  RuntimeResumeInput,
  RuntimeResumeResult,
  RuntimeRollbackInput,
  RuntimeRollbackResult,
  RuntimeSwapInput,
  RuntimeSwapResult,
  RuntimeTaskHead,
  RuntimeTaskInstance,
  RuntimeTaskInstanceStatus,
  RuntimeTestResults
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { prunableRuntimeCheckpoints } from "./checkpoint-retention.js";

export interface RuntimeOperationDedupRecord {
  id: string;
  /** The caller's account (fills the row's account_id, which the Edge scope loads by). Records
   *  stored before migration 124 that it could not backfill have none. */
  accountId?: string;
  /** The task (conversation) the operation ran on. */
  taskId?: string;
  operationType: string;
  idempotencyKey: string;
  result: unknown;
  createdAt: string;
}

export interface RuntimeHandoffSnapshot {
  runtimeTransfers?: RuntimeTransfer[];
  runtimeHandoffs?: RuntimeHandoff[];
  runtimeTaskHeads?: RuntimeTaskHead[];
  runtimeTaskInstances?: RuntimeTaskInstance[];
  runtimeOperationDedup?: RuntimeOperationDedupRecord[];
  runtimeExecutionEvents?: RuntimeExecutionEvent[];
}

/** What `acquireTurn` hands the caller: the release function every prior caller already expected,
 *  plus the fence token in effect for this task at acquisition time (null if the task has no
 *  executor identity yet - see RuntimeTaskInstance's fenceToken doc). The caller must present this
 *  same token back to `checkpointAfterTurn` so a rebind that happens during the turn's execution
 *  (a handoff completing while a local host is still mid-turn, for example) causes the turn's
 *  eventual checkpoint write to be rejected instead of silently overwriting newer state. */
export interface AcquiredRuntimeTurn {
  release: () => void;
  fenceToken: number | null;
}

/** The one resolved-binding shape this domain actually reads (a structural subset of
 *  ResolvedNativeRuntimeBinding from native-runtime/store.ts) - used instead of importing that
 *  domain's store module directly, which the repo's domain-isolation boundary check
 *  (scripts/check-boundaries.mjs) forbids for any `cp2/domains/*` file. Cp2Store (which is exempt
 *  from that check, and already imports the real NativeRuntimeBindingStore) supplies the actual
 *  object; it satisfies this interface structurally. */
export interface RuntimeHandoffNativeBindingResolution {
  agent: { id: string };
  selected: {
    model: { id: string };
    host: { id: string } | null;
    installation: { executionHostId: string } | null;
  };
}

/** The narrow slice of NativeRuntimeBindingStore's public API this domain depends on - see
 *  RuntimeHandoffNativeBindingResolution above for why this is a local interface rather than an
 *  import of the concrete class. */
export interface RuntimeHandoffNativeRuntimeAccess {
  bindingScope(bindingId: string): { accountId: string | null; businessId: string | null } | null;
  handoffHosts(input: {
    accountId: string;
    businessId: string | null;
  }): NativeExecutionHostSummary[];
  handoffHost(input: {
    accountId: string;
    businessId: string | null;
    executionHostId: string;
  }): NativeExecutionHostSummary;
  heartbeatHandoffHost(input: {
    executionHostId: string;
    accountId: string;
    businessId: string | null;
    deviceId: string;
    connected: boolean;
    now: Date;
  }): void;
  validateCandidateExecutionChain(input: {
    agentId: string;
    modelId: string;
    executionHostId: string;
  }): void;
  materializeConversationBinding(input: {
    accountId: string;
    businessId: string | null;
    agentId: string;
    modelId: string;
    executionHostId: string;
    updatedBy: string;
    now: Date;
  }): { id: string };
  resolveBindingForConversation(
    bindingId: string,
    conversationId: string
  ): RuntimeHandoffNativeBindingResolution;
  /** Existence-only check (not availability/compatibility - see
   *  `validateCandidateExecutionChain` for that) used when syncing an offline-created checkpoint:
   *  its `runtime` triple was valid when the client created it, and DB foreign keys require the
   *  referenced agent/model/host to still exist at sync time, but an offline record should not be
   *  rejected just because a model happens to be temporarily unavailable by the time it syncs. */
  runtimeRefExists(input: { agentId: string; modelId: string; executionHostId: string }): boolean;
}

export interface RuntimeHandoffDomainDeps {
  requireHandoffOwner?: (businessId: string, userId: string) => void;
  conversations: ReadonlyMap<string, ConversationSummary>;
  requireAnySession: (sessionId: string | null, now: Date) => AuthSessionView;
  nativeRuntimeBindings: RuntimeHandoffNativeRuntimeAccess;
  /** The provider-neutral global default binding's id (native-runtime/store.ts's
   *  globalDefaultRuntimeBindingId), used only as the legacy-bootstrap fallback when a
   *  conversation predates the native runtime graph and has no explicit runtimeBindingId yet. */
  defaultRuntimeBindingId: string;
  setConversationRuntimeBinding: (
    conversationId: string,
    runtimeBindingId: string,
    now: Date
  ) => void;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
}

type RuntimeRef = { agentId: string; modelId: string; executionHostId: string };

export class RuntimeHandoffDomain {
  private readonly executingTasks = new Set<string>();
  private readonly transfers = new Map<string, RuntimeTransfer>();
  private readonly handoffs = new Map<string, RuntimeHandoff>();
  private readonly taskHeads = new Map<string, RuntimeTaskHead>();
  private readonly taskInstances = new Map<string, RuntimeTaskInstance>();
  private readonly operationDedup = new Map<string, RuntimeOperationDedupRecord>();
  private readonly executionEvents = new Map<string, RuntimeExecutionEvent>();
  private readonly eventSequences = new Map<string, number>();

  constructor(private readonly deps: RuntimeHandoffDomainDeps) {}

  acquireTurn(taskId: string, accountId: string, businessId: string): AcquiredRuntimeTurn {
    const conversation = this.requireConversationRecord(taskId);
    if (
      conversation.accountId !== accountId ||
      (conversation.activeShopId !== null && conversation.activeShopId !== businessId)
    )
      throw new Cp2Error(
        403,
        "RUNTIME_BINDING_FORBIDDEN",
        "The conversation belongs to another account or business."
      );
    if (this.executingTasks.has(taskId) || this.activeTransfer(taskId, new Date()))
      throw new Cp2Error(
        409,
        "HANDOFF_IN_PROGRESS",
        "Wait for the current runtime turn or handoff to finish."
      );
    const head = this.taskHeads.get(taskId);
    const checkpoint = head ? this.handoffs.get(head.activeHandoffId) : undefined;
    if (checkpoint) {
      const host = this.deps.nativeRuntimeBindings.handoffHost({
        ...checkpoint.runtime,
        accountId,
        businessId
      });
      if (isLocalRuntimeHost(host.type))
        throw new Cp2Error(
          409,
          "LOCAL_RUNTIME_ACTIVE",
          "Continue this conversation on its local runtime or move it to hosted execution first."
        );
    }
    this.executingTasks.add(taskId);
    const fenceToken = this.taskInstances.get(taskId)?.fenceToken ?? null;
    return {
      release: () => {
        this.executingTasks.delete(taskId);
      },
      fenceToken
    };
  }

  /** Fencing (durable-execution-plane.md "Fencing"): `expectedFenceToken` is whatever
   *  `acquireTurn` returned when this turn started. If the task now has an executor identity whose
   *  fence token differs (a rebind - `performSwap`/`completeTransfer`/`resume` - completed while
   *  this turn was executing), the checkpoint write is rejected instead of silently promoted over
   *  the newer state. A task with no executor identity yet (`expectedFenceToken` and the current
   *  instance are both absent) has nothing to be stale against, so the check is skipped - fencing
   *  activates from the first rebind onward, exactly when the risk it guards against begins. */
  checkpointAfterTurn(
    taskId: string,
    turn: RuntimeTurnSummary,
    expectedFenceToken?: number | null,
    now = new Date()
  ) {
    const conversation = this.requireConversationRecord(taskId);
    let head = this.taskHeads.get(taskId);
    if (!head) {
      try {
        head = this.bootstrapLegacyHandoff(conversation, conversation.accountId, now).taskHead;
      } catch {
        return;
      } // Legacy/non-model turns can exist without a native runtime binding.
    }
    if (this.verifyFence(taskId, expectedFenceToken, now, { runtimeTurnId: turn.id })) {
      throw new Cp2Error(
        409,
        "STALE_EXECUTION_FENCE",
        "This runtime turn started under an execution the task has since moved on from. Its result " +
          "was not committed."
      );
    }
    const source = this.handoffs.get(head.activeHandoffId)!;
    const action = {
      id: turn.plan.id,
      description: turn.plan.toolName,
      metadata: { runtimeTurnId: turn.id }
    };
    const { handoff } = this.allocateAndInsertCheckpoint({
      ...source,
      taskId,
      parentHandoffId: source.id,
      now,
      promote: true,
      runtime: this.currentRuntimeRefForConversation(conversation),
      currentState: `Runtime turn ${turn.id}: ${turn.status}.`,
      completedActions: turn.plan.executedAt
        ? [...source.completedActions, { ...action, status: "completed" }]
        : source.completedActions,
      pendingActions:
        turn.plan.requiresConfirmation && !turn.plan.executedAt
          ? [{ ...action, status: "pending" }]
          : [],
      nextAction:
        turn.plan.requiresConfirmation && !turn.plan.executedAt
          ? "Reauthorize the pending tool action before execution."
          : null,
      relevantContext: [
        ...source.relevantContext,
        { kind: "external", refId: `runtime-turn:${turn.id}` }
      ]
    });
    const currentInstance = this.taskInstances.get(taskId);
    this.appendExecutionEvent({
      taskId,
      eventType: "CHECKPOINT_CREATED",
      executionId: turn.id,
      runtimeInstanceId: currentInstance?.executionId ?? null,
      executionHostId: currentInstance?.executionHostId ?? null,
      payload: { handoffId: handoff.id, runtimeTurnId: turn.id },
      now
    });
  }

  activeCheckpoint(taskId: string) {
    const head = this.taskHeads.get(taskId);
    return head ? this.handoffs.get(head.activeHandoffId) : undefined;
  }

  capabilities(
    sessionId: string | null,
    taskId: string,
    deviceId: string,
    now = new Date()
  ): RuntimeCapabilities {
    const { conversation } = this.requireConversation(sessionId, taskId, now);
    const activeTransfer = this.activeTransfer(taskId, now);
    const { local, hosted, runtime } = this.hostAvailability(taskId, conversation, deviceId, now);
    return this.assembleCapabilities(local, hosted, runtime, activeTransfer);
  }

  private assembleCapabilities(
    local: RuntimeHostCapability[],
    hosted: RuntimeHostCapability[],
    runtime: RuntimeRef | undefined,
    activeTransfer: RuntimeTransfer | null
  ): RuntimeCapabilities {
    const targets = [...local, ...hosted].filter((host) => !host.active);
    return {
      local,
      hosted,
      activeExecutionHostId: runtime?.executionHostId ?? null,
      activeTransfer,
      handoff: {
        supported: local.some((host) => host.supported),
        available: !activeTransfer && targets.some((host) => host.available),
        reason: activeTransfer
          ? "HANDOFF_IN_PROGRESS"
          : targets.some((host) => host.available)
            ? null
            : local.length === 0
              ? "LOCAL_RUNTIME_NOT_REGISTERED"
              : (local[0]?.reason ?? "NO_EXECUTION_HOST")
      }
    };
  }

  // Split out of capabilities() so completeTransfer's live target-availability check can read
  // host reachability without also running activeTransfer()'s expiry sweep - completing this
  // exact transfer must not race its own soft deadline out from under a valid, in-hand receipt.
  private hostAvailability(
    taskId: string,
    conversation: ConversationSummary,
    deviceId: string,
    now: Date
  ): {
    local: RuntimeHostCapability[];
    hosted: RuntimeHostCapability[];
    runtime: RuntimeRef | undefined;
  } {
    const active = this.taskHeads.get(taskId);
    let runtime = active ? this.handoffs.get(active.activeHandoffId)?.runtime : undefined;
    if (!runtime) {
      try {
        runtime = this.currentRuntimeRefForConversation(conversation);
      } catch {
        /* No runnable binding. */
      }
    }
    const hosts = this.deps.nativeRuntimeBindings.handoffHosts({
      accountId: conversation.accountId,
      businessId: conversation.activeShopId
    });
    const capabilities = hosts.map((host) => {
      const local = isLocalRuntimeHost(host.type);
      const supported = !local || host.capabilities.includes("runtime-handoff-v1");
      const configured = !local || typeof host.configuration.deviceId === "string";
      const healthy = ["healthy", "online", "available"].includes(host.status);
      const reachable = !local
        ? healthy
        : healthy &&
          host.configuration.deviceId === deviceId &&
          Date.parse(String(host.configuration.handoffLeaseExpiresAt)) > now.getTime();
      let reason = !supported
        ? "LOCAL_RUNTIME_UNSUPPORTED"
        : !configured
          ? "LOCAL_RUNTIME_NOT_REGISTERED"
          : !healthy
            ? "LOCAL_RUNTIME_UNHEALTHY"
            : !reachable
              ? "LOCAL_RUNTIME_OFFLINE"
              : null;
      if (!reason && runtime) {
        try {
          this.deps.nativeRuntimeBindings.validateCandidateExecutionChain({
            ...runtime,
            executionHostId: host.id
          });
        } catch (error) {
          reason = error instanceof Cp2Error ? error.code : "NO_EXECUTION_HOST";
        }
      }
      if (!runtime) reason = "NO_EXECUTION_HOST";
      return {
        executionHostId: host.id,
        type: host.type,
        supported,
        configured,
        healthy,
        reachable,
        available: reason === null,
        active: runtime?.executionHostId === host.id,
        reason
      };
    });
    return {
      local: capabilities.filter((host) => isLocalRuntimeHost(host.type)),
      hosted: capabilities.filter((host) => !isLocalRuntimeHost(host.type)),
      runtime
    };
  }

  heartbeatHost(
    sessionId: string | null,
    taskId: string,
    hostId: string,
    deviceId: string,
    connected: boolean,
    now = new Date()
  ) {
    const { conversation } = this.requireConversation(sessionId, taskId, now);
    this.deps.nativeRuntimeBindings.heartbeatHandoffHost({
      executionHostId: hostId,
      accountId: conversation.accountId,
      businessId: conversation.activeShopId,
      deviceId,
      connected,
      now
    });
    // Deliberately not this.capabilities(): a heartbeat is routine host-liveness upkeep (and the
    // frontend never reads this response), not an authoritative status read, so it must not be
    // able to expire an in-flight transfer for this task as a side effect of its own return value.
    const { local, hosted, runtime } = this.hostAvailability(taskId, conversation, deviceId, now);
    return this.assembleCapabilities(local, hosted, runtime, this.peekActiveTransfer(taskId, now));
  }

  /** Non-mutating: reports whether a transfer would currently be treated as blocking, without
   * committing the FAILED transition if it has expired. Only a genuine status read (capabilities(),
   * getTransfer()) or a new operation actually superseding it (activeTransfer()) may commit that. */
  private peekActiveTransfer(taskId: string, now: Date): RuntimeTransfer | null {
    const op = [...this.transfers.values()].find(
      (item) => item.taskId === taskId && !["COMPLETED", "FAILED"].includes(item.status)
    );
    if (op && Date.parse(op.expiresAt) <= now.getTime()) return null;
    return op ?? null;
  }

  beginTransfer(
    sessionId: string | null,
    input: {
      taskId: string;
      targetExecutionHostId: string;
      expectedHandoffId: string;
      idempotencyKey: string;
      deviceId: string;
    },
    now = new Date()
  ): RuntimeTransfer {
    const { conversation } = this.requireConversation(sessionId, input.taskId, now);
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200)
      throw new Cp2Error(400, "IDEMPOTENCY_KEY_REQUIRED", "A bounded idempotency key is required.");
    const existing = [...this.transfers.values()].find(
      (op) =>
        op.taskId === input.taskId &&
        op.accountId === conversation.accountId &&
        op.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      if (
        existing.targetHostId !== input.targetExecutionHostId ||
        existing.sourceHandoffId !== input.expectedHandoffId ||
        existing.deviceId !== input.deviceId
      )
        throw new Cp2Error(
          409,
          "HANDOFF_CONFLICT",
          "The idempotency key was already used for another transfer."
        );
      this.activeTransfer(input.taskId, now);
      return this.transfers.get(existing.id)!;
    }
    if (this.executingTasks.has(input.taskId))
      throw new Cp2Error(
        409,
        "HANDOFF_IN_PROGRESS",
        "The current turn is still executing. Retry once its checkpoint is saved."
      );
    const capabilities = this.capabilities(sessionId, input.taskId, input.deviceId, now);
    if (capabilities.activeTransfer)
      throw new Cp2Error(409, "HANDOFF_IN_PROGRESS", "A runtime handoff is already in progress.");
    this.deps.nativeRuntimeBindings.handoffHost({
      executionHostId: input.targetExecutionHostId,
      accountId: conversation.accountId,
      businessId: conversation.activeShopId
    });
    const target = [...capabilities.hosted, ...capabilities.local].find(
      (host) => host.executionHostId === input.targetExecutionHostId
    );
    if (!target?.available) {
      this.deps.recordAuditEvent({
        type: "runtime.handoff_rejected",
        aggregateType: "task",
        aggregateId: input.taskId,
        actorId: conversation.accountId,
        occurredAt: now.toISOString(),
        payload: {
          targetHostId: input.targetExecutionHostId,
          failureCode: target?.reason ?? "NO_EXECUTION_HOST"
        }
      });
      throw new Cp2Error(
        409,
        target?.reason ?? "NO_EXECUTION_HOST",
        "No compatible execution host is currently connected. The current runtime is still active."
      );
    }
    const resolved = this.resolveHandoff(sessionId, input.taskId, now);
    this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, true);
    const sourceHost = this.deps.nativeRuntimeBindings.handoffHost({
      executionHostId: resolved.activeHandoff.runtime.executionHostId,
      accountId: conversation.accountId,
      businessId: conversation.activeShopId
    });
    if (isLocalRuntimeHost(sourceHost.type) && sourceHost.configuration.deviceId !== input.deviceId)
      throw new Cp2Error(
        403,
        "RUNTIME_HOST_FORBIDDEN",
        "Return from the device that owns the active local runtime so its execution state can synchronize."
      );
    if (target.executionHostId === sourceHost.id)
      throw new Cp2Error(
        409,
        "HANDOFF_CONFLICT",
        "The requested execution host is already active."
      );
    const op: RuntimeTransfer = {
      id: randomUUID(),
      taskId: input.taskId,
      accountId: conversation.accountId,
      businessId: conversation.activeShopId,
      deviceId: input.deviceId,
      idempotencyKey: input.idempotencyKey,
      sourceHandoffId: resolved.activeHandoff.id,
      checkpointId: null,
      sourceHostId: resolved.activeHandoff.runtime.executionHostId,
      targetHostId: target.executionHostId,
      status: "PENDING",
      failureCode: null,
      message: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString()
    };
    this.transfers.set(op.id, op);
    this.transferEvent(op, "runtime.handoff_requested", now);
    try {
      this.transitionTransfer(op, "CHECKPOINTING", now);
      const source = resolved.activeHandoff;
      const { handoff } = this.allocateAndInsertCheckpoint({
        ...source,
        taskId: input.taskId,
        parentHandoffId: source.id,
        runtime: { ...source.runtime, executionHostId: target.executionHostId },
        now,
        promote: false
      });
      op.checkpointId = handoff.id;
      this.transitionTransfer(op, "CHECKPOINTED", now);
      this.transitionTransfer(op, "TARGET_ACTIVATING", now);
    } catch {
      this.failTransferRecord(
        op,
        "CHECKPOINT_FAILED",
        "Could not create the portable checkpoint. The current runtime is still active.",
        now
      );
    }
    return op;
  }

  getTransfer(
    sessionId: string | null,
    taskId: string,
    id: string,
    now = new Date()
  ): RuntimeTransfer {
    this.requireConversation(sessionId, taskId, now);
    this.activeTransfer(taskId, now);
    const op = this.transfers.get(id);
    if (!op || op.taskId !== taskId)
      throw new Cp2Error(404, "HANDOFF_NOT_FOUND", "Runtime handoff was not found.");
    return op;
  }

  completeTransfer(
    sessionId: string | null,
    taskId: string,
    id: string,
    deviceId: string,
    receipt?: RuntimeRestoreReceipt,
    now = new Date()
  ): RuntimeTransfer {
    // Fetched directly rather than via getTransfer: that call sweeps and expires a stale active
    // transfer as a side effect, which would race a legitimate late-but-valid completion (real
    // local prepare/resume work can plausibly outrun the soft expiresAt deadline) and discard a
    // successful receipt. The live availability check below still rejects a target that is
    // actually gone, so skipping the sweep here does not let a truly stuck transfer complete.
    const { conversation } = this.requireConversation(sessionId, taskId, now);
    const op = this.transfers.get(id);
    if (!op || op.taskId !== taskId)
      throw new Cp2Error(404, "HANDOFF_NOT_FOUND", "Runtime handoff was not found.");
    if (op.deviceId !== deviceId)
      throw new Cp2Error(
        403,
        "RUNTIME_HOST_FORBIDDEN",
        "Resume this handoff on its initiating device."
      );
    if (op.status === "COMPLETED" || op.status === "FAILED") return op;
    const checkpoint = this.handoffs.get(op.checkpointId!);
    try {
      if (!checkpoint)
        throw new Cp2Error(409, "CHECKPOINT_FAILED", "The portable checkpoint is missing.");
      if (this.requireTaskHead(taskId).activeHandoffId !== op.sourceHandoffId)
        throw new Cp2Error(
          409,
          "HANDOFF_CONFLICT",
          "The conversation advanced while the target was preparing."
        );
      const availability = this.hostAvailability(taskId, conversation, deviceId, now);
      const target = [...availability.local, ...availability.hosted].find(
        (host) => host.executionHostId === op.targetHostId
      );
      if (!target?.available)
        throw new Cp2Error(
          409,
          target?.reason ?? "NO_EXECUTION_HOST",
          "The execution host stopped responding."
        );
      this.transitionTransfer(op, "RESTORING", now);
      if (
        isLocalRuntimeHost(target.type) &&
        (!receipt ||
          receipt.handoffId !== checkpoint.id ||
          receipt.agentId !== checkpoint.runtime.agentId ||
          receipt.modelId !== checkpoint.runtime.modelId ||
          !receipt.harness ||
          !receipt.artifacts ||
          !receipt.protectedContext ||
          !receipt.businessState)
      ) {
        throw new Cp2Error(
          409,
          "RESTORE_FAILED",
          "The local host did not confirm restoration of the exact checkpoint."
        );
      }
      const binding = this.deps.nativeRuntimeBindings.materializeConversationBinding({
        accountId: op.accountId,
        businessId: op.businessId,
        ...checkpoint.runtime,
        updatedBy: op.accountId,
        now
      });
      this.deps.nativeRuntimeBindings.resolveBindingForConversation(binding.id, taskId);
      this.transitionTransfer(op, "VERIFYING", now);
      // One synchronous commit in the canonical single-writer CP2 store. No awaits between the
      // compare-and-swap and binding/instance update. The response must cross the DB barrier.
      const head = this.requireTaskHead(taskId);
      this.taskHeads.set(taskId, {
        ...head,
        activeHandoffId: checkpoint.id,
        updatedAt: now.toISOString()
      });
      this.deps.setConversationRuntimeBinding(taskId, binding.id, now);
      const rebound = this.setTaskInstanceHandoff(
        taskId,
        checkpoint.id,
        "READY",
        checkpoint.runtime,
        now,
        null
      );
      this.appendExecutionEvent({
        taskId,
        eventType: "RUNTIME_REBOUND",
        executionId: rebound.executionId,
        runtimeInstanceId: rebound.executionId,
        executionHostId: rebound.executionHostId,
        payload: { transferId: op.id, fenceToken: rebound.fenceToken },
        now
      });
      this.transitionTransfer(op, "COMPLETED", now);
    } catch (error) {
      this.failTransferRecord(
        op,
        error instanceof Cp2Error ? error.code : "TARGET_ACTIVATION_FAILED",
        error instanceof Cp2Error
          ? error.message
          : "Target activation failed. The current runtime is still active.",
        now
      );
    }
    return op;
  }

  failTransfer(
    sessionId: string | null,
    taskId: string,
    id: string,
    deviceId: string,
    now = new Date(),
    failureCode = "TARGET_ACTIVATION_FAILED"
  ) {
    const op = this.getTransfer(sessionId, taskId, id, now);
    if (op.deviceId !== deviceId)
      throw new Cp2Error(403, "RUNTIME_HOST_FORBIDDEN", "This handoff belongs to another device.");
    if (op.status !== "COMPLETED" && op.status !== "FAILED")
      this.failTransferRecord(
        op,
        failureCode,
        "The target could not restore the checkpoint. The current runtime is still active.",
        now
      );
    return op;
  }

  private activeTransfer(taskId: string, now: Date) {
    const op = [...this.transfers.values()].find(
      (item) => item.taskId === taskId && !["COMPLETED", "FAILED"].includes(item.status)
    );
    if (op && Date.parse(op.expiresAt) <= now.getTime()) {
      this.failTransferRecord(
        op,
        "TARGET_ACTIVATION_TIMEOUT",
        "The target did not become ready before the handoff deadline. The current runtime is still active.",
        now
      );
      return null;
    }
    return op ?? null;
  }

  private transitionTransfer(op: RuntimeTransfer, status: RuntimeTransferStatus, now: Date) {
    const next: Partial<Record<RuntimeTransferStatus, RuntimeTransferStatus>> = {
      PENDING: "CHECKPOINTING",
      CHECKPOINTING: "CHECKPOINTED",
      CHECKPOINTED: "TARGET_ACTIVATING",
      TARGET_ACTIVATING: "RESTORING",
      RESTORING: "VERIFYING",
      VERIFYING: "COMPLETED"
    };
    if (
      next[op.status] !== status &&
      !(status === "FAILED" && !["COMPLETED", "FAILED"].includes(op.status))
    )
      throw new Cp2Error(
        409,
        "HANDOFF_CONFLICT",
        `Invalid runtime handoff transition: ${op.status} to ${status}.`
      );
    op.status = status;
    op.updatedAt = now.toISOString();
    this.transfers.set(op.id, op);
    const events: Record<RuntimeTransferStatus, string> = {
      PENDING: "runtime.handoff_requested",
      CHECKPOINTING: "runtime.checkpoint_started",
      CHECKPOINTED: "runtime.checkpoint_created",
      TARGET_ACTIVATING: "runtime.target_activation_started",
      RESTORING: "runtime.restore_started",
      VERIFYING: "runtime.restore_completed",
      COMPLETED: "runtime.handoff_completed",
      FAILED: "runtime.handoff_failed"
    };
    this.transferEvent(op, events[status], now);
  }

  private failTransferRecord(op: RuntimeTransfer, code: string, message: string, now: Date) {
    op.failureCode = code;
    op.message = message;
    this.transitionTransfer(op, "FAILED", now);
  }

  private static readonly transferAuditEventToExecutionEventType: Record<
    string,
    RuntimeExecutionEventType | null
  > = {
    "runtime.handoff_requested": "HANDOFF_STARTED",
    "runtime.checkpoint_started": null,
    "runtime.checkpoint_created": "CHECKPOINT_CREATED",
    "runtime.target_activation_started": "BINDING_RESOLUTION_STARTED",
    "runtime.restore_started": "EXECUTION_SUSPENDED",
    "runtime.restore_completed": "BINDING_RESOLVED",
    "runtime.handoff_completed": "HANDOFF_COMPLETED",
    "runtime.handoff_failed": "HANDOFF_FAILED"
  };

  private transferEvent(op: RuntimeTransfer, type: string, now: Date) {
    this.deps.recordAuditEvent({
      type,
      aggregateType: "task",
      aggregateId: op.taskId,
      actorId: op.accountId,
      occurredAt: now.toISOString(),
      payload: {
        handoffId: op.id,
        runtimeInstanceId: op.taskId,
        sourceHostId: op.sourceHostId,
        targetHostId: op.targetHostId,
        businessId: op.businessId,
        durationMs: now.getTime() - Date.parse(op.createdAt),
        failureCode: op.failureCode
      }
    });
    const eventType = RuntimeHandoffDomain.transferAuditEventToExecutionEventType[type];
    if (eventType !== null && eventType !== undefined) {
      this.appendExecutionEvent({
        taskId: op.taskId,
        eventType,
        executionId: op.id,
        runtimeInstanceId: null,
        executionHostId: op.targetHostId,
        payload: {
          transferId: op.id,
          sourceHostId: op.sourceHostId,
          targetHostId: op.targetHostId
        },
        now
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Resolution (section 5) and legacy bootstrap (section 20)
  // ---------------------------------------------------------------------------------------------

  resolveHandoff(
    sessionId: string | null,
    taskId: string,
    now: Date = new Date()
  ): ResolvedRuntimeHandoff {
    const { conversation, session } = this.requireConversation(sessionId, taskId, now);
    let taskHead = this.taskHeads.get(taskId);
    if (taskHead === undefined) {
      taskHead = this.bootstrapLegacyHandoff(conversation, session.account.id, now).taskHead;
    }
    const activeHandoff = this.handoffs.get(taskHead.activeHandoffId);
    if (activeHandoff === undefined) {
      throw new Cp2Error(
        500,
        "RUNTIME_HANDOFF_HEAD_CORRUPT",
        "Task head points at a checkpoint that no longer exists."
      );
    }
    const runtimeInstance = this.taskInstances.get(taskId) ?? null;
    const isRuntimeStale =
      runtimeInstance !== null && runtimeInstance.activeHandoffId !== taskHead.activeHandoffId;
    return {
      taskId,
      conversationId: conversation.id,
      activeHandoff,
      taskHead,
      runtimeInstance,
      isRuntimeStale
    };
  }

  getHandoffById(
    sessionId: string | null,
    taskId: string,
    handoffId: string,
    now: Date = new Date()
  ): RuntimeHandoff {
    const { conversation } = this.requireConversation(sessionId, taskId, now);
    const handoff = this.handoffs.get(handoffId);
    if (handoff === undefined || handoff.taskId !== conversation.id) {
      throw new Cp2Error(
        404,
        "RUNTIME_HANDOFF_NOT_FOUND",
        "Checkpoint was not found for this task."
      );
    }
    return handoff;
  }

  getHandoffByVersion(
    sessionId: string | null,
    taskId: string,
    version: number,
    now: Date = new Date()
  ): RuntimeHandoff {
    const { conversation } = this.requireConversation(sessionId, taskId, now);
    const handoff = [...this.handoffs.values()].find(
      (candidate) => candidate.taskId === conversation.id && candidate.checkpointVersion === version
    );
    if (handoff === undefined) {
      throw new Cp2Error(404, "RUNTIME_HANDOFF_NOT_FOUND", "No checkpoint exists at that version.");
    }
    return handoff;
  }

  // ---------------------------------------------------------------------------------------------
  // Checkpoint creation (section 6)
  // ---------------------------------------------------------------------------------------------

  createCheckpoint(
    sessionId: string | null,
    input: RuntimeCheckpointCreateInput,
    now: Date = new Date()
  ): RuntimeCheckpointResult {
    return this.withIdempotency(
      "checkpoint",
      input.idempotencyKey,
      sessionId,
      input.taskId,
      now,
      () => {
        const resolved = this.resolveHandoff(sessionId, input.taskId, now);
        const actorId = this.resolveActorId(sessionId, now);
        const promote = input.promote === true;
        if (promote) {
          this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, true);
        } else if (input.expectedHandoffId !== undefined) {
          this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, false);
        }
        if (
          promote &&
          this.verifyFence(input.taskId, input.expectedFenceToken, now, {
            operation: "createCheckpoint"
          })
        ) {
          throw new Cp2Error(
            409,
            "STALE_EXECUTION_FENCE",
            "This checkpoint was created under an execution the task has since moved on from. It " +
              "was not promoted."
          );
        }
        const previous = resolved.activeHandoff;
        const { handoff, taskHead } = this.allocateAndInsertCheckpoint({
          taskId: input.taskId,
          conversationId: resolved.conversationId,
          parentHandoffId: previous.id,
          goal: input.goal ?? previous.goal,
          currentState: input.currentState ?? previous.currentState,
          completedActions: input.completedActions ?? previous.completedActions,
          decisions: input.decisions ?? previous.decisions,
          rejectedPaths: input.rejectedPaths ?? previous.rejectedPaths,
          pendingActions: input.pendingActions ?? previous.pendingActions,
          nextAction: input.nextAction === undefined ? previous.nextAction : input.nextAction,
          relevantContext: input.relevantContext ?? previous.relevantContext,
          artifacts: input.artifacts ?? previous.artifacts,
          tests: {
            passed: input.testsPassed ?? previous.tests.passed,
            failed: input.testsFailed ?? previous.tests.failed,
            pending: input.testsPending ?? previous.tests.pending
          },
          runtime: previous.runtime,
          now,
          promote
        });
        this.deps.recordAuditEvent({
          type: "runtime_handoff.checkpoint_created",
          aggregateType: "task",
          aggregateId: input.taskId,
          actorId,
          occurredAt: now.toISOString(),
          payload: { handoffId: handoff.id, promoted: promote }
        });
        this.appendExecutionEvent({
          taskId: input.taskId,
          eventType: "CHECKPOINT_CREATED",
          executionId: resolved.runtimeInstance?.executionId ?? null,
          runtimeInstanceId: resolved.runtimeInstance?.executionId ?? null,
          executionHostId: previous.runtime.executionHostId,
          payload: { handoffId: handoff.id, promoted: promote },
          now
        });
        return { handoff, taskHead, promoted: promote };
      }
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Swap (sections 8-12): Prepare -> Commit -> Activate
  // ---------------------------------------------------------------------------------------------

  performSwap(
    sessionId: string | null,
    input: RuntimeSwapInput,
    now: Date = new Date()
  ): RuntimeSwapResult {
    return this.withIdempotency(
      `swap:${input.dimension}`,
      input.idempotencyKey,
      sessionId,
      input.taskId,
      now,
      () => {
        // ---- Prepare (11.1): read-only, no authoritative state changes ----
        const resolved = this.resolveHandoff(sessionId, input.taskId, now);
        const actorId = this.resolveActorId(sessionId, now);
        this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, true);
        this.appendExecutionEvent({
          taskId: input.taskId,
          eventType: "HANDOFF_STARTED",
          executionId: null,
          runtimeInstanceId: resolved.runtimeInstance?.executionId ?? null,
          executionHostId: resolved.activeHandoff.runtime.executionHostId,
          payload: { dimension: input.dimension, targetId: input.targetId },
          now
        });
        const current = resolved.activeHandoff.runtime;
        const candidate: RuntimeRef = {
          agentId: input.dimension === "agent" ? input.targetId : current.agentId,
          modelId: input.dimension === "model" ? input.targetId : current.modelId,
          executionHostId: input.dimension === "host" ? input.targetId : current.executionHostId
        };
        const owner = this.requireConversationRecord(input.taskId);
        this.deps.nativeRuntimeBindings.handoffHost({
          executionHostId: candidate.executionHostId,
          accountId: owner.accountId,
          businessId: owner.activeShopId
        });
        try {
          if (input.dimension === "host")
            throw new Cp2Error(
              409,
              "HANDOFF_RESTORE_REQUIRED",
              "Execution host changes require an acknowledged runtime handoff. Use the handoffs API."
            );
          if (this.activeTransfer(input.taskId, now))
            throw new Cp2Error(
              409,
              "HANDOFF_IN_PROGRESS",
              "A runtime handoff is already in progress."
            );
          // Reuses the same agent/model/host compatibility rules turn-time resolution enforces
          // (section 10) rather than re-implementing them. Throws (leaving the old runtime fully
          // authoritative - nothing below has run yet) if the candidate chain is not viable.
          this.deps.nativeRuntimeBindings.validateCandidateExecutionChain(candidate);
        } catch (error) {
          this.appendExecutionEvent({
            taskId: input.taskId,
            eventType: "HANDOFF_FAILED",
            executionId: null,
            runtimeInstanceId: resolved.runtimeInstance?.executionId ?? null,
            executionHostId: resolved.activeHandoff.runtime.executionHostId,
            payload: {
              dimension: input.dimension,
              failureCode: error instanceof Cp2Error ? error.code : "HANDOFF_FAILED"
            },
            now
          });
          throw error;
        }

        // ---- Commit (11.2): one small synchronous unit; no I/O, no provider calls ----
        const conversation = this.requireConversationRecord(input.taskId);
        this.requireMatchingHead(input.expectedHandoffId, this.requireTaskHead(input.taskId), true);
        const binding = this.deps.nativeRuntimeBindings.materializeConversationBinding({
          accountId: conversation.accountId,
          businessId: conversation.activeShopId,
          agentId: candidate.agentId,
          modelId: candidate.modelId,
          executionHostId: candidate.executionHostId,
          updatedBy: actorId,
          now
        });
        // Validate the materialized binding before promoting any checkpoint or replacing source.
        this.deps.nativeRuntimeBindings.resolveBindingForConversation(binding.id, conversation.id);
        const previous = resolved.activeHandoff;
        const { handoff, taskHead } = this.allocateAndInsertCheckpoint({
          taskId: input.taskId,
          conversationId: conversation.id,
          parentHandoffId: previous.id,
          goal: previous.goal,
          currentState: previous.currentState,
          completedActions: previous.completedActions,
          decisions: previous.decisions,
          rejectedPaths: previous.rejectedPaths,
          pendingActions: previous.pendingActions,
          nextAction: previous.nextAction,
          relevantContext: previous.relevantContext,
          artifacts: previous.artifacts,
          tests: previous.tests,
          runtime: candidate,
          now,
          promote: true
        });
        this.deps.setConversationRuntimeBinding(conversation.id, binding.id, now);
        const activationFailed = false;
        const activationError = null;
        const runtimeInstance = this.setTaskInstanceHandoff(
          input.taskId,
          handoff.id,
          "READY",
          candidate,
          now,
          null
        );

        this.deps.recordAuditEvent({
          type: `runtime_handoff.swap_${input.dimension}`,
          aggregateType: "task",
          aggregateId: input.taskId,
          actorId,
          occurredAt: now.toISOString(),
          payload: {
            handoffId: handoff.id,
            bindingId: binding.id,
            targetId: input.targetId,
            activationFailed
          }
        });
        this.appendExecutionEvent({
          taskId: input.taskId,
          eventType: "RUNTIME_REBOUND",
          executionId: runtimeInstance.executionId,
          runtimeInstanceId: runtimeInstance.executionId,
          executionHostId: runtimeInstance.executionHostId,
          payload: { dimension: input.dimension, fenceToken: runtimeInstance.fenceToken },
          now
        });
        this.appendExecutionEvent({
          taskId: input.taskId,
          eventType: "HANDOFF_COMPLETED",
          executionId: runtimeInstance.executionId,
          runtimeInstanceId: runtimeInstance.executionId,
          executionHostId: runtimeInstance.executionHostId,
          payload: { handoffId: handoff.id, dimension: input.dimension },
          now
        });

        return { handoff, taskHead, runtimeInstance, activationFailed, activationError };
      }
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Rollback (section 14) - moves the head only; never touches handoff history or binding.
  // ---------------------------------------------------------------------------------------------

  rollback(
    sessionId: string | null,
    input: RuntimeRollbackInput,
    now: Date = new Date()
  ): RuntimeRollbackResult {
    return this.withIdempotency(
      "rollback",
      input.idempotencyKey,
      sessionId,
      input.taskId,
      now,
      () => {
        const resolved = this.resolveHandoff(sessionId, input.taskId, now);
        const actorId = this.resolveActorId(sessionId, now);
        this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, true);
        const target = this.handoffs.get(input.targetHandoffId);
        if (target === undefined || target.taskId !== input.taskId) {
          throw new Cp2Error(
            404,
            "RUNTIME_HANDOFF_NOT_FOUND",
            "Target checkpoint was not found for this task."
          );
        }
        const taskHead: RuntimeTaskHead = {
          ...resolved.taskHead,
          activeHandoffId: target.id,
          updatedAt: now.toISOString()
        };
        this.taskHeads.set(input.taskId, taskHead);
        this.deps.recordAuditEvent({
          type: "runtime_handoff.rollback",
          aggregateType: "task",
          aggregateId: input.taskId,
          actorId,
          occurredAt: now.toISOString(),
          payload: { fromHandoffId: resolved.activeHandoff.id, toHandoffId: target.id }
        });
        return { taskHead, activeHandoff: target };
      }
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Resume (section 13)
  // ---------------------------------------------------------------------------------------------

  resume(
    sessionId: string | null,
    input: RuntimeResumeInput,
    now: Date = new Date()
  ): RuntimeResumeResult {
    const bootstrapped = !this.taskHeads.has(input.taskId);
    const resolved = this.resolveHandoff(sessionId, input.taskId, now);
    const actorId = this.resolveActorId(sessionId, now);
    const runtimeInstance = this.setTaskInstanceHandoff(
      input.taskId,
      resolved.activeHandoff.id,
      "RUNNING",
      resolved.activeHandoff.runtime,
      now,
      null
    );
    this.deps.recordAuditEvent({
      type: "runtime_handoff.resumed",
      aggregateType: "task",
      aggregateId: input.taskId,
      actorId,
      occurredAt: now.toISOString(),
      payload: {
        handoffId: resolved.activeHandoff.id,
        nextAction: resolved.activeHandoff.nextAction
      }
    });
    this.appendExecutionEvent({
      taskId: input.taskId,
      eventType: "EXECUTION_RESUMED",
      executionId: runtimeInstance.executionId,
      runtimeInstanceId: runtimeInstance.executionId,
      executionHostId: runtimeInstance.executionHostId,
      payload: { handoffId: resolved.activeHandoff.id, fenceToken: runtimeInstance.fenceToken },
      now
    });
    return {
      taskHead: resolved.taskHead,
      activeHandoff: resolved.activeHandoff,
      runtimeInstance,
      bootstrapped
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Offline sync and merge (protocol doc "Offline causal ancestry")
  // ---------------------------------------------------------------------------------------------

  /**
   * Synchronizes a batch of checkpoints an offline client created locally, in causal order.
   * Each one becomes a normal immutable handoff, keeping the client's own `id` (already used as
   * another offline checkpoint's `parentHandoffId` before either synced) and `createdAt`, but
   * receiving a server-assigned `checkpointVersion` through the same
   * `allocateNextCheckpointVersion` primitive every other version-allocating path uses. Re-syncing
   * a checkpoint whose `id` already exists is a no-op (returns the existing row) rather than an
   * error, which is what makes retrying a partially-failed sync safe.
   */
  syncOfflineCheckpoints(
    sessionId: string | null,
    input: RuntimeOfflineSyncInput,
    now: Date = new Date()
  ): RuntimeOfflineSyncResult {
    return this.withIdempotency(
      "offline-sync",
      input.idempotencyKey,
      sessionId,
      input.taskId,
      now,
      () => {
        const resolved = this.resolveHandoff(sessionId, input.taskId, now);
        const actorId = this.resolveActorId(sessionId, now);
        if (input.promote === true) {
          this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, true);
        } else if (input.expectedHandoffId !== undefined) {
          this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, false);
        }
        const syncedHandoffs: RuntimeHandoff[] = [];
        for (const offline of input.checkpoints) {
          syncedHandoffs.push(
            this.syncOneOfflineCheckpoint(input.taskId, resolved.conversationId, offline, now)
          );
        }
        let taskHead = this.taskHeads.get(input.taskId) as RuntimeTaskHead;
        if (input.promote === true && syncedHandoffs.length > 0) {
          const lastSynced = syncedHandoffs[syncedHandoffs.length - 1] as RuntimeHandoff;
          const targetId = input.promoteToHandoffId ?? lastSynced.id;
          if (!this.handoffs.has(targetId)) {
            throw new Cp2Error(
              404,
              "RUNTIME_HANDOFF_NOT_FOUND",
              "promoteToHandoffId was not found for this task."
            );
          }
          taskHead = { ...taskHead, activeHandoffId: targetId, updatedAt: now.toISOString() };
          this.taskHeads.set(input.taskId, taskHead);
        }
        this.pruneSupersededCheckpoints(input.taskId);
        this.deps.recordAuditEvent({
          type: "runtime_handoff.offline_synced",
          aggregateType: "task",
          aggregateId: input.taskId,
          actorId,
          occurredAt: now.toISOString(),
          payload: {
            syncedCount: syncedHandoffs.length,
            promoted: input.promote === true,
            handoffIds: syncedHandoffs.map((handoff) => handoff.id).join(",")
          }
        });
        return { syncedHandoffs, taskHead };
      }
    );
  }

  /**
   * Unifies two or more branch tips into one new checkpoint (`branchHandoffIds[0]` becomes
   * `parentHandoffId`, the rest become `mergedFromHandoffIds`) and promotes the task head to it.
   * Goes through `allocateAndInsertCheckpoint` like every other checkpoint-creating path - a merge
   * checkpoint is an ordinary immutable handoff, just with more than one parent recorded.
   */
  mergeCheckpoints(
    sessionId: string | null,
    input: RuntimeMergeInput,
    now: Date = new Date()
  ): RuntimeMergeResult {
    return this.withIdempotency("merge", input.idempotencyKey, sessionId, input.taskId, now, () => {
      const resolved = this.resolveHandoff(sessionId, input.taskId, now);
      const actorId = this.resolveActorId(sessionId, now);
      this.requireMatchingHead(input.expectedHandoffId, resolved.taskHead, true);
      if (input.branchHandoffIds.length < 2) {
        throw new Cp2Error(
          400,
          "RUNTIME_MERGE_REQUIRES_MULTIPLE_BRANCHES",
          "A merge requires at least two branch checkpoints."
        );
      }
      const branches = input.branchHandoffIds.map((handoffId) => {
        const branch = this.handoffs.get(handoffId);
        if (branch === undefined || branch.taskId !== input.taskId) {
          throw new Cp2Error(
            404,
            "RUNTIME_HANDOFF_NOT_FOUND",
            `Branch checkpoint ${handoffId} was not found for this task.`
          );
        }
        return branch;
      });
      const base = branches[0] as RuntimeHandoff;
      const { handoff, taskHead } = this.allocateAndInsertCheckpoint({
        taskId: input.taskId,
        conversationId: resolved.conversationId,
        parentHandoffId: base.id,
        mergedFromHandoffIds: branches.slice(1).map((branch) => branch.id),
        goal: input.goal ?? base.goal,
        currentState: input.currentState ?? base.currentState,
        completedActions: input.completedActions ?? base.completedActions,
        decisions: input.decisions ?? base.decisions,
        rejectedPaths: input.rejectedPaths ?? base.rejectedPaths,
        pendingActions: input.pendingActions ?? base.pendingActions,
        nextAction: input.nextAction === undefined ? base.nextAction : input.nextAction,
        relevantContext: input.relevantContext ?? base.relevantContext,
        artifacts: input.artifacts ?? base.artifacts,
        tests: {
          passed: input.testsPassed ?? base.tests.passed,
          failed: input.testsFailed ?? base.tests.failed,
          pending: input.testsPending ?? base.tests.pending
        },
        runtime: base.runtime,
        now,
        promote: true
      });
      this.deps.recordAuditEvent({
        type: "runtime_handoff.merged",
        aggregateType: "task",
        aggregateId: input.taskId,
        actorId,
        occurredAt: now.toISOString(),
        payload: { handoffId: handoff.id, branchHandoffIds: input.branchHandoffIds.join(",") }
      });
      return { handoff, taskHead };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private requireConversation(
    sessionId: string | null,
    taskId: string,
    now: Date
  ): { conversation: ConversationSummary; session: AuthSessionView } {
    const session = this.deps.requireAnySession(sessionId, now);
    const conversation = this.requireConversationRecord(taskId);
    if (conversation === undefined) {
      throw new Cp2Error(404, "RUNTIME_TASK_NOT_FOUND", "Task was not found.");
    }
    if (conversation.accountId !== session.account.id) {
      throw new Cp2Error(403, "RUNTIME_TASK_FORBIDDEN", "This task belongs to another account.");
    }
    if (conversation.activeShopId)
      this.deps.requireHandoffOwner?.(conversation.activeShopId, session.user.id);
    return { conversation, session };
  }

  /** The authenticated caller's account id. Always derived from the session server-side - never
   *  accepted as a client-supplied `actorId` field, which would let a caller forge audit trail
   *  attribution. Cheap to call a second time alongside `resolveHandoff`/`requireConversation`
   *  since this whole domain runs synchronously against in-memory state. */
  private resolveActorId(sessionId: string | null, now: Date): string {
    return this.deps.requireAnySession(sessionId, now).account.id;
  }

  private requireConversationRecord(taskId: string): ConversationSummary {
    const conversation = this.deps.conversations.get(taskId);
    if (conversation === undefined) {
      throw new Cp2Error(404, "RUNTIME_TASK_NOT_FOUND", "Task was not found.");
    }
    const scope = conversation.runtimeBindingId
      ? this.deps.nativeRuntimeBindings.bindingScope(conversation.runtimeBindingId)
      : null;
    if (scope?.accountId && scope.accountId !== conversation.accountId)
      throw new Cp2Error(
        403,
        "RUNTIME_BINDING_FORBIDDEN",
        "The runtime binding belongs to another account."
      );
    return conversation.activeShopId === null && scope?.businessId
      ? { ...conversation, activeShopId: scope.businessId }
      : conversation;
  }

  private requireTaskHead(taskId: string): RuntimeTaskHead {
    const taskHead = this.taskHeads.get(taskId);
    if (taskHead === undefined) {
      throw new Cp2Error(404, "RUNTIME_TASK_HEAD_NOT_FOUND", "Task has no runtime state yet.");
    }
    return taskHead;
  }

  /** Optimistic concurrency (section 7). `required` distinguishes a caller that must supply
   *  `expectedHandoffId` (any mutation that moves the head) from one where it is merely checked
   *  if present. */
  private requireMatchingHead(
    expectedHandoffId: string | undefined,
    taskHead: RuntimeTaskHead,
    required: boolean
  ): void {
    if (this.activeTransfer(taskHead.taskId, new Date()))
      throw new Cp2Error(409, "HANDOFF_IN_PROGRESS", "A runtime handoff is already in progress.");
    if (expectedHandoffId === undefined) {
      if (required) {
        throw new Cp2Error(
          400,
          "RUNTIME_EXPECTED_HANDOFF_REQUIRED",
          "expectedHandoffId is required for this operation."
        );
      }
      return;
    }
    if (expectedHandoffId !== taskHead.activeHandoffId) {
      throw new Cp2Error(
        409,
        "RUNTIME_HANDOFF_CONFLICT",
        "The task head has moved since expectedHandoffId was read.",
        false,
        { expectedHandoffId, actualHandoffId: taskHead.activeHandoffId }
      );
    }
  }

  private bootstrapLegacyHandoff(
    conversation: ConversationSummary,
    actorId: string,
    now: Date
  ): { handoff: RuntimeHandoff; taskHead: RuntimeTaskHead } {
    let runtime: RuntimeRef;
    try {
      runtime = this.currentRuntimeRefForConversation(conversation);
    } catch (error) {
      throw error instanceof Cp2Error
        ? new Cp2Error(
            503,
            "RUNTIME_LEGACY_BOOTSTRAP_UNAVAILABLE",
            "This task predates the Runtime Handoff Protocol and its current runtime binding " +
              "cannot be resolved, so no checkpoint can be bootstrapped yet.",
            error.retryable,
            error.details
          )
        : error;
    }
    const emptyTests: RuntimeTestResults = { passed: [], failed: [], pending: [] };
    const handoff = this.insertHandoff({
      taskId: conversation.id,
      conversationId: conversation.id,
      parentHandoffId: null,
      goal: "Continue this conversation.",
      currentState:
        "Bootstrapped from pre-existing conversation/runtime-binding state (no prior checkpoint).",
      completedActions: [],
      decisions: [],
      rejectedPaths: [],
      pendingActions: [],
      nextAction: null,
      relevantContext: [],
      artifacts: [],
      tests: emptyTests,
      runtime,
      checkpointVersion: 1,
      schemaVersion: 1,
      now
    });
    const taskHead: RuntimeTaskHead = {
      taskId: conversation.id,
      activeHandoffId: handoff.id,
      nextCheckpointVersion: 2,
      updatedAt: now.toISOString()
    };
    this.taskHeads.set(taskHead.taskId, taskHead);
    this.deps.recordAuditEvent({
      type: "runtime_handoff.legacy_bootstrapped",
      aggregateType: "task",
      aggregateId: conversation.id,
      actorId,
      occurredAt: now.toISOString(),
      payload: { handoffId: handoff.id }
    });
    this.appendExecutionEvent({
      taskId: conversation.id,
      eventType: "TASK_CREATED",
      executionId: null,
      runtimeInstanceId: null,
      executionHostId: runtime.executionHostId,
      payload: { handoffId: handoff.id, bootstrapped: true },
      now
    });
    return { handoff, taskHead };
  }

  private currentRuntimeRefForConversation(conversation: ConversationSummary): RuntimeRef {
    const bindingId = conversation.runtimeBindingId ?? this.deps.defaultRuntimeBindingId;
    const resolved = this.deps.nativeRuntimeBindings.resolveBindingForConversation(
      bindingId,
      conversation.id
    );
    const executionHostId =
      resolved.selected.host?.id ?? resolved.selected.installation?.executionHostId ?? null;
    if (executionHostId === null) {
      throw new Cp2Error(
        503,
        "RUNTIME_MODELS_UNAVAILABLE",
        "No available execution host exists for this conversation's runtime."
      );
    }
    return {
      agentId: resolved.agent.id,
      modelId: resolved.selected.model.id,
      executionHostId
    };
  }

  /** Syncs one offline checkpoint (see `syncOfflineCheckpoints`). Assumes the caller has already
   *  resolved/bootstrapped the task, so `this.taskHeads.get(taskId)` is guaranteed to exist. */
  private syncOneOfflineCheckpoint(
    taskId: string,
    conversationId: string,
    offline: RuntimeOfflineCheckpointInput,
    now: Date
  ): RuntimeHandoff {
    const owner = this.requireConversationRecord(taskId);
    this.deps.nativeRuntimeBindings.handoffHost({
      executionHostId: offline.runtime.executionHostId,
      accountId: owner.accountId,
      businessId: owner.activeShopId
    });
    const existing = this.handoffs.get(offline.id);
    if (existing !== undefined) {
      this.requireMatchingOfflineCheckpoint(offline, existing);
      return existing;
    }
    if (offline.parentHandoffId !== null && !this.handoffs.has(offline.parentHandoffId)) {
      throw new Cp2Error(
        409,
        "RUNTIME_OFFLINE_PARENT_MISSING",
        `Offline checkpoint ${offline.id}'s parent ${offline.parentHandoffId} was not found. ` +
          "Submit checkpoints in causal order (ancestors before descendants).",
        false,
        { checkpointId: offline.id, parentHandoffId: offline.parentHandoffId }
      );
    }
    if (!this.deps.nativeRuntimeBindings.runtimeRefExists(offline.runtime)) {
      throw new Cp2Error(
        409,
        "RUNTIME_OFFLINE_RUNTIME_REF_MISSING",
        `Offline checkpoint ${offline.id} references an agent/model/execution host that no ` +
          "longer exists.",
        false,
        { checkpointId: offline.id }
      );
    }
    const { version, existingHead } = this.allocateNextCheckpointVersion(taskId);
    const handoff = this.insertHandoff({
      id: offline.id,
      taskId,
      conversationId,
      parentHandoffId: offline.parentHandoffId,
      goal: offline.goal,
      currentState: offline.currentState,
      completedActions: offline.completedActions,
      decisions: offline.decisions,
      rejectedPaths: offline.rejectedPaths,
      pendingActions: offline.pendingActions,
      nextAction: offline.nextAction,
      relevantContext: offline.relevantContext,
      artifacts: offline.artifacts,
      tests: offline.tests,
      runtime: offline.runtime,
      checkpointVersion: version,
      schemaVersion: offline.schemaVersion,
      createdAt: offline.createdAt,
      now
    });
    // Advance the head's version counter without moving activeHandoffId - a sync's optional
    // promotion happens exactly once, after the whole batch lands (syncOfflineCheckpoints).
    this.moveTaskHead(
      taskId,
      version,
      existingHead,
      (existingHead as RuntimeTaskHead).activeHandoffId,
      now
    );
    return handoff;
  }

  /** A re-synced offline checkpoint (same `id` already present) must carry identical content -
   *  otherwise this is a real conflict (a client bug, or two different checkpoints colliding on
   *  id), not a safe idempotent retry. */
  private requireMatchingOfflineCheckpoint(
    offline: RuntimeOfflineCheckpointInput,
    existing: RuntimeHandoff
  ): void {
    const matches =
      existing.parentHandoffId === offline.parentHandoffId &&
      existing.goal === offline.goal &&
      existing.currentState === offline.currentState &&
      existing.nextAction === offline.nextAction &&
      existing.schemaVersion === offline.schemaVersion &&
      existing.createdAt === offline.createdAt &&
      JSON.stringify(existing.completedActions) === JSON.stringify(offline.completedActions) &&
      JSON.stringify(existing.decisions) === JSON.stringify(offline.decisions) &&
      JSON.stringify(existing.rejectedPaths) === JSON.stringify(offline.rejectedPaths) &&
      JSON.stringify(existing.pendingActions) === JSON.stringify(offline.pendingActions) &&
      JSON.stringify(existing.relevantContext) === JSON.stringify(offline.relevantContext) &&
      JSON.stringify(existing.artifacts) === JSON.stringify(offline.artifacts) &&
      JSON.stringify(existing.tests) === JSON.stringify(offline.tests) &&
      JSON.stringify(existing.runtime) === JSON.stringify(offline.runtime);
    if (!matches) {
      throw new Cp2Error(
        409,
        "RUNTIME_OFFLINE_CHECKPOINT_CONFLICT",
        `Offline checkpoint ${offline.id} was already synced with different content.`,
        false,
        { checkpointId: offline.id }
      );
    }
  }

  private insertHandoff(input: {
    id?: string;
    taskId: string;
    conversationId: string;
    parentHandoffId: string | null;
    mergedFromHandoffIds?: string[];
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
    runtime: RuntimeRef;
    checkpointVersion: number | null;
    schemaVersion: number;
    createdAt?: string;
    now: Date;
  }): RuntimeHandoff {
    const handoff: RuntimeHandoff = {
      id: input.id ?? randomUUID(),
      taskId: input.taskId,
      conversationId: input.conversationId,
      parentHandoffId: input.parentHandoffId,
      mergedFromHandoffIds: input.mergedFromHandoffIds ?? [],
      goal: input.goal,
      currentState: input.currentState,
      completedActions: input.completedActions,
      decisions: input.decisions,
      rejectedPaths: input.rejectedPaths,
      pendingActions: input.pendingActions,
      nextAction: input.nextAction,
      relevantContext: input.relevantContext,
      artifacts: input.artifacts,
      tests: input.tests,
      runtime: input.runtime,
      checkpointVersion: input.checkpointVersion,
      schemaVersion: input.schemaVersion,
      createdAt: input.createdAt ?? input.now.toISOString()
    };
    this.handoffs.set(handoff.id, handoff);
    return handoff;
  }

  /**
   * Allocates the next cloud-authoritative checkpoint version for a task (protocol doc section
   * 6.1's "one shared locking implementation"). Every path that assigns a version -
   * checkpoint-creation-with-promotion, swap commit, offline sync (one call per synced
   * checkpoint), and merge - goes through this single method rather than each reimplementing its
   * own counter logic. Safe without an explicit lock for the same reason documented on the class:
   * this whole domain runs synchronously, so there is no window for two calls on one process to
   * interleave between reading `nextCheckpointVersion` and writing the next one.
   */
  private allocateNextCheckpointVersion(taskId: string): {
    version: number;
    existingHead: RuntimeTaskHead | undefined;
  } {
    const existingHead = this.taskHeads.get(taskId);
    return { version: existingHead?.nextCheckpointVersion ?? 1, existingHead };
  }

  /** Moves (or, for `promote: false`, merely advances the version counter of) a task's head.
   *  Shared by every version-allocating path - see `allocateNextCheckpointVersion` above. */
  private moveTaskHead(
    taskId: string,
    version: number,
    existingHead: RuntimeTaskHead | undefined,
    activeHandoffId: string,
    now: Date
  ): RuntimeTaskHead {
    const taskHead: RuntimeTaskHead = {
      taskId,
      activeHandoffId,
      nextCheckpointVersion: version + 1,
      updatedAt: now.toISOString()
    };
    this.taskHeads.set(taskId, taskHead);
    return taskHead;
  }

  private allocateAndInsertCheckpoint(input: {
    taskId: string;
    conversationId: string;
    parentHandoffId: string | null;
    mergedFromHandoffIds?: string[];
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
    runtime: RuntimeRef;
    now: Date;
    promote: boolean;
  }): { handoff: RuntimeHandoff; taskHead: RuntimeTaskHead } {
    const { version, existingHead } = this.allocateNextCheckpointVersion(input.taskId);
    const handoff = this.insertHandoff({
      taskId: input.taskId,
      conversationId: input.conversationId,
      parentHandoffId: input.parentHandoffId,
      ...(input.mergedFromHandoffIds === undefined
        ? {}
        : { mergedFromHandoffIds: input.mergedFromHandoffIds }),
      goal: input.goal,
      currentState: input.currentState,
      completedActions: input.completedActions,
      decisions: input.decisions,
      rejectedPaths: input.rejectedPaths,
      pendingActions: input.pendingActions,
      nextAction: input.nextAction,
      relevantContext: input.relevantContext,
      artifacts: input.artifacts,
      tests: input.tests,
      runtime: input.runtime,
      checkpointVersion: version,
      schemaVersion: 1,
      now: input.now
    });
    const promoteHead = input.promote || existingHead === undefined;
    const activeHandoffId = promoteHead
      ? handoff.id
      : (existingHead as RuntimeTaskHead).activeHandoffId;
    const taskHead = this.moveTaskHead(
      input.taskId,
      version,
      existingHead,
      activeHandoffId,
      input.now
    );
    this.pruneSupersededCheckpoints(input.taskId);
    return { handoff, taskHead };
  }

  /** Drops the task's superseded checkpoints (checkpoint-retention.ts); the snapshot writer
   *  deletes their rows. Runs on every write that adds a checkpoint, so no operator is needed. */
  private pruneSupersededCheckpoints(taskId: string): void {
    const handoffs = [...this.handoffs.values()].filter((handoff) => handoff.taskId === taskId);
    for (const id of prunableRuntimeCheckpoints({
      handoffs,
      head: this.taskHeads.get(taskId),
      instance: this.taskInstances.get(taskId),
      transfers: [...this.transfers.values()].filter((transfer) => transfer.taskId === taskId)
    }))
      this.handoffs.delete(id);
  }

  /** Shared fencing check (durable-execution-plane.md "Fencing"), used by every commit path that
   *  accepts an optional caller-captured fence token: `checkpointAfterTurn` (an ordinary chat
   *  turn) and `createCheckpoint` (the general checkpoint API - the same one a future
   *  `LocalHandoffHost` executor, or any other out-of-process caller that captured a fence token
   *  via `GET .../inspect`, would use to report progress). Returns `true` (and records
   *  `EXECUTION_FENCE_REJECTED`) when `expectedFenceToken` is present and no longer matches the
   *  task's current execution; the caller is responsible for throwing `STALE_EXECUTION_FENCE`
   *  before committing anything. Returns `false` (nothing recorded) when there is nothing to be
   *  stale against yet, or the token still matches. */
  private verifyFence(
    taskId: string,
    expectedFenceToken: number | null | undefined,
    now: Date,
    payload: Record<string, unknown>
  ): boolean {
    if (expectedFenceToken === undefined || expectedFenceToken === null) return false;
    const currentInstance = this.taskInstances.get(taskId);
    if (currentInstance === undefined || currentInstance.fenceToken === expectedFenceToken) {
      return false;
    }
    this.appendExecutionEvent({
      taskId,
      eventType: "EXECUTION_FENCE_REJECTED",
      executionId: null,
      runtimeInstanceId: null,
      executionHostId: currentInstance.executionHostId,
      payload: { ...payload, expectedFenceToken, currentFenceToken: currentInstance.fenceToken },
      now
    });
    return true;
  }

  /** Every call mints a fresh `executionId`/`fenceToken` (durable-execution-plane.md "Fencing") -
   *  every caller of this method (`performSwap`, `completeTransfer`, `resume`) represents a
   *  genuine new execution attempt taking ownership of the task, so a previously-issued fence
   *  token (handed to an earlier `acquireTurn` caller, or to a local host that has not yet
   *  reported back) becomes stale the moment this runs. */
  private setTaskInstanceHandoff(
    taskId: string,
    activeHandoffId: string,
    status: RuntimeTaskInstanceStatus,
    runtime: RuntimeRef,
    now: Date,
    lastError: string | null
  ): RuntimeTaskInstance {
    const fenceToken = (this.taskInstances.get(taskId)?.fenceToken ?? 0) + 1;
    const instance: RuntimeTaskInstance = {
      taskId,
      activeHandoffId,
      status,
      agentId: runtime.agentId,
      modelId: runtime.modelId,
      executionHostId: runtime.executionHostId,
      lastError,
      updatedAt: now.toISOString(),
      fenceToken,
      executionId: randomUUID()
    };
    this.taskInstances.set(taskId, instance);
    return instance;
  }

  // ---------------------------------------------------------------------------------------------
  // Durable execution event log (durable-execution-plane.md "Event lifecycle"). Append-only;
  // sequence numbers are allocated synchronously within this single-writer process, exactly like
  // allocateNextCheckpointVersion allocates checkpoint versions.
  // ---------------------------------------------------------------------------------------------

  appendExecutionEvent(input: {
    taskId: string;
    eventType: RuntimeExecutionEventType;
    executionId: string | null;
    runtimeInstanceId: string | null;
    executionHostId: string | null;
    payload: Record<string, unknown>;
    now: Date;
  }): RuntimeExecutionEvent {
    const sequenceNumber = (this.eventSequences.get(input.taskId) ?? 0) + 1;
    this.eventSequences.set(input.taskId, sequenceNumber);
    const event: RuntimeExecutionEvent = {
      id: randomUUID(),
      taskId: input.taskId,
      sequenceNumber,
      executionId: input.executionId,
      runtimeInstanceId: input.runtimeInstanceId,
      executionHostId: input.executionHostId,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: input.now.toISOString()
    };
    this.executionEvents.set(event.id, event);
    return event;
  }

  listExecutionEvents(
    sessionId: string | null,
    taskId: string,
    now: Date = new Date()
  ): RuntimeExecutionEvent[] {
    this.requireConversation(sessionId, taskId, now);
    return [...this.executionEvents.values()]
      .filter((event) => event.taskId === taskId)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  /** `runtime.inspect(taskId)` (durable-execution-plane.md "Runtime inspection API"). Never
   *  exposes secrets: everything returned is already exposed piecemeal by `resolveHandoff` /
   *  `capabilities` / `listExecutionEvents` today. */
  inspect(sessionId: string | null, taskId: string, now: Date = new Date()): RuntimeInspection {
    const resolved = this.resolveHandoff(sessionId, taskId, now);
    const events = this.listExecutionEvents(sessionId, taskId, now);
    const activeTransfer = this.activeTransfer(taskId, now);
    const failureTypes: RuntimeExecutionEventType[] = [
      "EXECUTION_FAILED",
      "EXECUTION_FENCE_REJECTED",
      "HANDOFF_FAILED",
      "AUTHORIZATION_DENIED"
    ];
    const lastSuccessful = [...events]
      .reverse()
      .find((event) => !failureTypes.includes(event.eventType));
    const resumeBlockedReason = activeTransfer
      ? "HANDOFF_IN_PROGRESS"
      : this.executingTasks.has(taskId)
        ? "EXECUTION_IN_PROGRESS"
        : resolved.runtimeInstance?.status === "STOPPED"
          ? "RUNTIME_STOPPED"
          : null;
    return {
      taskId,
      taskHead: resolved.taskHead,
      activeHandoff: resolved.activeHandoff,
      runtimeInstance: resolved.runtimeInstance,
      isRuntimeStale: resolved.isRuntimeStale,
      activeTransfer,
      latestEvents: events.slice(-50),
      lastSuccessfulEventType: lastSuccessful?.eventType ?? null,
      resumeEligible: resumeBlockedReason === null,
      resumeBlockedReason
    };
  }

  /** `runtime.cancel(taskId)`. Marks the task's executor STOPPED and mints a fresh fence token so
   *  any execution already in flight for this task cannot later commit a checkpoint (its captured
   *  fence token is now stale - see `checkpointAfterTurn`). Idempotent: cancelling an
   *  already-STOPPED task is a no-op that returns the existing instance. Does not touch checkpoint
   *  history or the task head - a cancelled task can still be inspected and, if the caller
   *  chooses, resumed later via `resume`. */
  cancelExecution(
    sessionId: string | null,
    taskId: string,
    now: Date = new Date()
  ): RuntimeTaskInstance {
    const resolved = this.resolveHandoff(sessionId, taskId, now);
    if (resolved.runtimeInstance?.status === "STOPPED") return resolved.runtimeInstance;
    const actorId = this.resolveActorId(sessionId, now);
    const instance = this.setTaskInstanceHandoff(
      taskId,
      resolved.activeHandoff.id,
      "STOPPED",
      resolved.activeHandoff.runtime,
      now,
      "Cancelled by request."
    );
    this.appendExecutionEvent({
      taskId,
      eventType: "EXECUTION_CANCELLED",
      executionId: instance.executionId,
      runtimeInstanceId: instance.executionId,
      executionHostId: instance.executionHostId,
      payload: {},
      now
    });
    this.deps.recordAuditEvent({
      type: "runtime_handoff.cancelled",
      aggregateType: "task",
      aggregateId: taskId,
      actorId,
      occurredAt: now.toISOString(),
      payload: {}
    });
    return instance;
  }

  /** Idempotency (section 6.2). Synchronous check-then-write, atomic for the same reason
   *  `allocateAndInsertCheckpoint` is - see the class docstring. */
  private withIdempotency<T>(
    operationType: string,
    idempotencyKey: string | null | undefined,
    sessionId: string | null,
    taskId: string,
    now: Date,
    run: () => T
  ): T {
    // Retries must pass the same ownership check as new mutations before returning state.
    const { session } = this.requireConversation(sessionId, taskId, now);
    if (idempotencyKey === null || idempotencyKey === undefined || idempotencyKey.trim() === "") {
      return run();
    }
    const scopedKey = createHash("sha256")
      .update(JSON.stringify([session.account.id, taskId, idempotencyKey]))
      .digest("hex");
    const dedupKey = `${operationType}:${scopedKey}`;
    const existing = this.operationDedup.get(dedupKey);
    if (existing !== undefined) {
      return existing.result as T;
    }
    const result = run();
    this.operationDedup.set(dedupKey, {
      id: createHash("sha256").update(dedupKey).digest("hex"),
      accountId: session.account.id,
      taskId,
      operationType,
      idempotencyKey: scopedKey,
      result,
      createdAt: new Date().toISOString()
    });
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Snapshot lifecycle (matches every other CP2 domain's clear/restore/mapGetter shape)
  // ---------------------------------------------------------------------------------------------

  clear(): void {
    this.transfers.clear();
    this.handoffs.clear();
    this.taskHeads.clear();
    this.taskInstances.clear();
    this.operationDedup.clear();
    this.executionEvents.clear();
    this.eventSequences.clear();
  }

  restore(snapshot: RuntimeHandoffSnapshot): void {
    this.clear();
    for (const record of snapshot.runtimeTransfers ?? []) this.transfers.set(record.id, record);
    for (const record of snapshot.runtimeHandoffs ?? []) this.handoffs.set(record.id, record);
    for (const record of snapshot.runtimeTaskHeads ?? []) this.taskHeads.set(record.taskId, record);
    for (const record of snapshot.runtimeTaskInstances ?? []) {
      // fenceToken/executionId are additive fields (durable-execution-plane.md "Fencing") absent
      // from any snapshot persisted before this change - default exactly like every other
      // additive-field restore in this codebase (e.g. runtimeTurns' `runtimeVersion` in
      // agent-runtime/store.ts's own restore()).
      const legacy = record as RuntimeTaskInstance &
        Partial<{ fenceToken: number; executionId: string }>;
      this.taskInstances.set(record.taskId, {
        ...record,
        fenceToken: legacy.fenceToken ?? 0,
        executionId: legacy.executionId ?? `legacy:${record.taskId}`
      });
    }
    for (const record of snapshot.runtimeOperationDedup ?? []) {
      this.operationDedup.set(`${record.operationType}:${record.idempotencyKey}`, record);
    }
    for (const record of snapshot.runtimeExecutionEvents ?? []) {
      this.executionEvents.set(record.id, record);
      const currentMax = this.eventSequences.get(record.taskId) ?? 0;
      if (record.sequenceNumber > currentMax)
        this.eventSequences.set(record.taskId, record.sequenceNumber);
    }
  }

  get transfersMap() {
    return this.transfers;
  }

  get handoffsMap(): Map<string, RuntimeHandoff> {
    return this.handoffs;
  }
  get taskHeadsMap(): Map<string, RuntimeTaskHead> {
    return this.taskHeads;
  }
  get taskInstancesMap(): Map<string, RuntimeTaskInstance> {
    return this.taskInstances;
  }
  get operationDedupMap(): Map<string, RuntimeOperationDedupRecord> {
    return this.operationDedup;
  }
  get executionEventsMap(): Map<string, RuntimeExecutionEvent> {
    return this.executionEvents;
  }
}
