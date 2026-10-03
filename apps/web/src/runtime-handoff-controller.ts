import type {
  ResolvedRuntimeHandoff,
  RuntimeHandoff,
  RuntimeOfflineSyncResult,
  RuntimeResumeResult,
  RuntimeCapabilities,
  RuntimeTransfer
} from "@grogoni/shared-types";
import type {
  LocalDatabase,
  LocalRuntimeHandoffSession,
  LocalRuntimeMessage,
  Scope
} from "@grogoni/offline-runtime";

export interface LocalResumeReceipt {
  handoffId: string;
  agentId: string;
  modelId: string;
  harness: boolean;
  artifacts: boolean;
  protectedContext: boolean;
  businessState: boolean;
}

/** Only a trusted, executable host adapter may register. supports must cover the complete
 * agent harness, model, protected-context export and durable conversation/event sync. An
 * inference-only adapter (including the standalone WebLLM assistant) cannot implement this. */
export interface LocalHandoffHost {
  id: string;
  executionHostId: string;
  supports(scope: Scope, handoff: RuntimeHandoff): Promise<boolean>;
  prepare(scope: Scope, handoff: RuntimeHandoff): Promise<LocalResumeReceipt>;
  resume(scope: Scope, handoff: RuntimeHandoff): Promise<LocalResumeReceipt>;
  turn(input: {
    scope: Scope;
    handoff: RuntimeHandoff;
    message: LocalRuntimeMessage;
    history: LocalRuntimeMessage[];
    executeTool: (operation: string, args: unknown) => Promise<unknown>;
  }): Promise<{ reply: LocalRuntimeMessage; checkpoint: RuntimeHandoff }>;
  /** Persist messages under their original IDs in the SAME backend conversation. Retriable,
   * idempotent, and authorized by the server; never replay assistant replies as user prompts. */
  syncMessages(
    scope: Scope,
    conversationId: string,
    messages: LocalRuntimeMessage[]
  ): Promise<string[]>;
}

export interface RuntimeHandoffDependencies {
  db: LocalDatabase;
  hosts: () => LocalHandoffHost[];
  cloud: <T>(path: string, body?: unknown, idempotencyKey?: string) => Promise<T>;
  prepareBusiness: (scope: Scope) => Promise<void>;
  syncBusiness: (scope: Scope) => Promise<void>;
  activate: (scope: Scope, offline: boolean) => Promise<void>;
  executeTool: (scope: Scope, operation: string, args: unknown) => Promise<unknown>;
  lock: <T>(scope: Scope, action: () => Promise<T>) => Promise<T>;
  assertAuthorized: (scope: Scope) => void;
  changed: () => void;
}

function assertReceipt(receipt: LocalResumeReceipt, handoff: RuntimeHandoff): void {
  if (
    receipt.handoffId !== handoff.id ||
    receipt.agentId !== handoff.runtime.agentId ||
    receipt.modelId !== handoff.runtime.modelId ||
    !receipt.harness ||
    !receipt.artifacts ||
    !receipt.protectedContext ||
    !receipt.businessState
  )
    throw new Error(
      "The local runtime could not confirm that it can resume this agent and conversation."
    );
}

export class RuntimeHandoffController {
  constructor(private readonly deps: RuntimeHandoffDependencies) {}

  async availability(
    scope: Scope,
    conversationId: string | null,
    prefetchedCapabilities?: RuntimeCapabilities
  ): Promise<{ available: boolean; reason: string }> {
    if (!conversationId) return { available: false, reason: "Open an agent conversation first." };
    const capabilities = prefetchedCapabilities ?? (await this.capabilities(scope, conversationId));
    if (!capabilities.handoff.available)
      return { available: false, reason: capabilityReason(capabilities.handoff.reason) };
    const resolved = await this.resolve(conversationId);
    const host = await this.findHost(scope, resolved.activeHandoff);
    const available =
      !!host &&
      capabilities.local.some(
        (item) => item.executionHostId === host.executionHostId && item.available
      );
    return {
      available,
      reason: available
        ? "Move this conversation to the connected local runtime. Synchronization resumes when connected."
        : "No compatible local runtime is currently connected."
    };
  }

  async capabilities(scope: Scope, conversationId: string): Promise<RuntimeCapabilities> {
    await this.heartbeatHosts(scope, conversationId);
    return this.deps.cloud<RuntimeCapabilities>(this.path(conversationId, "/capabilities"));
  }

  /** Only adapters already provisioned for this device may advertise a live bridge. Split out of
   * capabilities() for callers (moveToLocal's pre/post-restore pings) that only need the target
   * host's lease kept fresh and never read the response - fetching and discarding a capabilities
   * snapshot there is wasted work, and its GET /capabilities call can expire an in-flight transfer
   * as a side effect moments before this same request tries to complete it. */
  private async heartbeatHosts(scope: Scope, conversationId: string): Promise<void> {
    if (this.deps.hosts().length) this.deps.assertAuthorized(scope);
    for (const host of this.deps.hosts()) {
      await this.deps.cloud(
        this.path(conversationId, `/hosts/${encodeURIComponent(host.executionHostId)}/heartbeat`),
        { connected: true }
      );
    }
  }

  goOffline(scope: Scope, conversationId: string, messages: LocalRuntimeMessage[]): Promise<void> {
    return this.deps.lock(scope, async () => {
      this.deps.assertAuthorized(scope);
      const previous = await this.deps.db.read(scope);
      if (previous.offlineModeActive) return;
      if (previous.runtimeHandoffSession && previous.runtimeHandoffSession.status !== "hosted")
        throw new Error(
          "A saved handoff needs recovery. Resume it before starting another handoff."
        );
      const capability = await this.capabilities(scope, conversationId);
      if (!capability.handoff.available)
        throw new Error(capabilityReason(capability.handoff.reason));
      const resolved = await this.resolve(conversationId);
      const host = await this.findHost(scope, resolved.activeHandoff);
      if (
        !host ||
        !capability.local.some(
          (item) => item.executionHostId === host.executionHostId && item.available
        )
      )
        throw new Error(
          "No compatible local runtime is currently connected. Hosted execution is still active."
        );
      const session: LocalRuntimeHandoffSession = {
        adapterId: host.id,
        hostedExecutionHostId: resolved.activeHandoff.runtime.executionHostId,
        cloudHandoffId: resolved.activeHandoff.id,
        handoff: resolved.activeHandoff,
        checkpoints: [],
        messages,
        pendingMessages: [],
        status: "prepared",
        transferKey: crypto.randomUUID(),
        targetExecutionHostId: host.executionHostId
      };
      await this.save(scope, session);
      await this.moveToLocal(scope, session, host);
    });
  }

  /** A saved operation is reloaded on refresh; retries reuse the same key and exact checkpoint. */
  recover(scope: Scope): Promise<void> {
    return this.deps.lock(scope, async () => {
      this.deps.assertAuthorized(scope);
      const session = (await this.deps.db.read(scope)).runtimeHandoffSession;
      if (!session || session.status !== "prepared" || !session.transferKey) return;
      const host = this.deps.hosts().find((item) => item.id === session.adapterId);
      if (!host)
        throw new Error(
          "Reconnect the local runtime to recover the saved handoff, or return to hosted execution."
        );
      await this.moveToLocal(scope, session, host);
    });
  }

  private async moveToLocal(
    scope: Scope,
    session: LocalRuntimeHandoffSession,
    host: LocalHandoffHost
  ) {
    const conversationId = session.handoff.conversationId;
    let transfer: RuntimeTransfer | undefined;
    try {
      await this.heartbeatHosts(scope, conversationId);
      transfer = session.transferId
        ? await this.deps.cloud<RuntimeTransfer>(
            this.path(conversationId, `/transfers/${session.transferId}`)
          )
        : await this.deps.cloud<RuntimeTransfer>(
            this.path(conversationId, "/handoffs"),
            {
              targetExecutionHostId: host.executionHostId,
              expectedHandoffId: session.cloudHandoffId
            },
            session.transferKey
          );
      session.transferId = transfer.id;
      await this.save(scope, session);
      if (transfer.status === "FAILED")
        throw new Error(
          transfer.message ?? "The handoff failed. Hosted execution is still active."
        );
      const checkpoint = await this.deps.cloud<RuntimeHandoff>(
        this.path(conversationId, `/handoffs/${transfer.checkpointId}`)
      );
      await bounded(this.deps.prepareBusiness(scope), "Business snapshot preparation");
      assertReceipt(
        await bounded(host.prepare(scope, checkpoint), "Local runtime preparation"),
        checkpoint
      );
      const receipt = await bounded(host.resume(scope, checkpoint), "Local checkpoint restore");
      assertReceipt(receipt, checkpoint);
      this.deps.assertAuthorized(scope);
      if (!this.deps.hosts().includes(host))
        throw new Error(
          "The local runtime disconnected during restore. Hosted execution is still active."
        );
      await this.heartbeatHosts(scope, conversationId);
      if (transfer.status !== "COMPLETED") {
        transfer = await this.deps.cloud<RuntimeTransfer>(
          this.path(conversationId, `/transfers/${transfer.id}/complete`),
          { receipt }
        );
        if (transfer.status !== "COMPLETED")
          throw new Error(
            transfer.message ?? "The handoff failed. Hosted execution is still active."
          );
      }
      session.handoff = checkpoint;
      session.cloudHandoffId = checkpoint.id;
      session.status = "offline";
      await this.save(scope, session);
      await this.deps.activate(scope, true);
      this.deps.changed();
    } catch (error) {
      // A response can be lost after a durable commit. The server never rolls back COMPLETED.
      if (transfer && transfer.status !== "COMPLETED")
        await this.deps
          .cloud(this.path(conversationId, `/transfers/${transfer.id}/fail`), {})
          .catch(() => undefined);
      throw error;
    }
  }

  goOnline(scope: Scope): Promise<void> {
    return this.deps.lock(scope, async () => {
      this.deps.assertAuthorized(scope);
      const session = (await this.deps.db.read(scope)).runtimeHandoffSession;
      if (!session)
        throw new Error(
          "This saved business-data session has no RuntimeHandoff. Sync it in offline settings."
        );
      const conversationId = session.handoff.conversationId;
      if (session.status === "prepared" && !session.transferId && session.transferKey) {
        const capability = await this.capabilities(scope, conversationId);
        if (capability.activeTransfer?.idempotencyKey === session.transferKey)
          session.transferId = capability.activeTransfer.id;
        else {
          const current = await this.resolve(conversationId);
          if (current.activeHandoff.id === session.cloudHandoffId) {
            session.status = "hosted";
            await this.save(scope, session);
            await this.deps.activate(scope, false);
            return;
          }
        }
      }
      if (session.status === "prepared" && session.transferId) {
        const transfer = await this.deps.cloud<RuntimeTransfer>(
          this.path(conversationId, `/transfers/${session.transferId}/fail`),
          {}
        );
        if (transfer.status === "FAILED") {
          session.status = "hosted";
          await this.save(scope, session);
          await this.deps.activate(scope, false);
          return;
        }
        session.handoff = await this.deps.cloud<RuntimeHandoff>(
          this.path(conversationId, `/handoffs/${transfer.checkpointId}`)
        );
        session.cloudHandoffId = session.handoff.id;
      }

      await this.deps.syncBusiness(scope);
      const state = await this.deps.db.read(scope);
      if (state.conflicts.length || state.operations.some((op) => op.syncStatus !== "ACKED"))
        throw new Error(
          "Resolve the pending business changes in offline settings before going online."
        );
      const host = this.deps.hosts().find((candidate) => candidate.id === session.adapterId);
      if (session.pendingMessages.length) {
        if (!host) throw new Error("Reconnect the local execution host to sync this conversation.");
        const acked = await host.syncMessages(scope, conversationId, session.pendingMessages);
        session.pendingMessages = session.pendingMessages.filter(
          (message) => !acked.includes(message.id)
        );
        await this.save(scope, session);
        if (session.pendingMessages.length)
          throw new Error(
            "Some conversation events still need syncing. The local conversation is saved."
          );
      }
      // Keep the local branch intact when another device moved the head. The existing handoff
      // merge API is the only way to reconcile it; a reconnect must never overwrite that branch.
      if (session.checkpoints.length) {
        const synced = await this.deps.cloud<RuntimeOfflineSyncResult>(
          this.path(conversationId, "/checkpoints/sync"),
          {
            checkpoints: session.checkpoints,
            promote: true,
            expectedHandoffId: session.cloudHandoffId
          },
          `sync:${session.checkpoints.at(-1)!.id}`
        );
        session.cloudHandoffId = synced.taskHead.activeHandoffId;
        session.checkpoints = [];
        await this.save(scope, session);
      }
      const resolved = await this.resolve(conversationId);
      // Prepared recovery may have lost the host-swap response. Accept only the exact child
      // created from our prepared checkpoint, preserving any independently advanced task head.
      const recoveringSwap =
        session.status === "prepared" &&
        resolved.activeHandoff.parentHandoffId === session.cloudHandoffId &&
        resolved.activeHandoff.runtime.executionHostId ===
          (session.targetExecutionHostId ?? host?.executionHostId);
      const recoveringReturn =
        session.status === "returning" &&
        resolved.activeHandoff.parentHandoffId === session.cloudHandoffId &&
        resolved.activeHandoff.runtime.executionHostId === session.hostedExecutionHostId;
      if (
        resolved.activeHandoff.id !== session.cloudHandoffId &&
        !recoveringSwap &&
        !recoveringReturn
      )
        throw new Error(
          "This conversation changed on another device. Resolve its RuntimeHandoff conflict before going online; local state is saved."
        );
      if (recoveringReturn) {
        const resumed = await this.deps.cloud<RuntimeResumeResult>(
          this.path(conversationId, "/resume"),
          {}
        );
        if (
          resumed.activeHandoff.id !== resolved.activeHandoff.id ||
          !["READY", "RUNNING"].includes(resumed.runtimeInstance.status)
        )
          throw new Error(
            "The hosted runtime has not confirmed resume. Your local state is saved."
          );
        session.handoff = resumed.activeHandoff;
        session.cloudHandoffId = resumed.activeHandoff.id;
        session.status = "hosted";
        delete session.returnTransferKey;
        await this.save(scope, session);
        await this.deps.activate(scope, false);
        return;
      }
      session.status = "returning";
      session.returnTransferKey ??= crypto.randomUUID();
      session.cloudHandoffId = resolved.activeHandoff.id;
      await this.save(scope, session);
      const transfer = await this.deps.cloud<RuntimeTransfer>(
        this.path(conversationId, "/handoffs"),
        {
          targetExecutionHostId: session.hostedExecutionHostId,
          expectedHandoffId: session.cloudHandoffId
        },
        session.returnTransferKey
      );
      const completed =
        transfer.status === "COMPLETED"
          ? transfer
          : await this.deps.cloud<RuntimeTransfer>(
              this.path(conversationId, `/transfers/${transfer.id}/complete`),
              {}
            );
      if (completed.status !== "COMPLETED") {
        session.status = "offline";
        delete session.returnTransferKey;
        await this.save(scope, session);
        throw new Error(
          completed.message ?? "Hosted restore failed. Local execution is still active."
        );
      }
      const resumed = await this.deps.cloud<RuntimeResumeResult>(
        this.path(conversationId, "/resume"),
        {}
      );
      if (
        resumed.activeHandoff.id !== completed.checkpointId ||
        !["READY", "RUNNING"].includes(resumed.runtimeInstance.status)
      )
        throw new Error("The hosted runtime has not confirmed resume. Your local state is saved.");
      session.handoff = resumed.activeHandoff;
      session.cloudHandoffId = resumed.activeHandoff.id;
      this.deps.assertAuthorized(scope);
      await this.deps.activate(scope, false);
      session.status = "hosted";
      delete session.returnTransferKey;
      await this.save(scope, session);
      // Retain the local checkpoint and transcript even after acknowledgement; no destructive
      // cleanup is required to change routing, and retaining them makes interrupted returns safe.
      this.deps.changed();
    });
  }

  turn(
    scope: Scope,
    conversationId: string,
    message: LocalRuntimeMessage
  ): Promise<LocalRuntimeMessage> {
    return this.deps.lock(scope, async () => {
      this.deps.assertAuthorized(scope);
      const state = await this.deps.db.read(scope);
      const session = state.runtimeHandoffSession;
      if (
        !state.offlineModeActive ||
        !session ||
        session.status !== "offline" ||
        session.handoff.conversationId !== conversationId
      )
        throw new Error(
          "This conversation has no active local handoff. Return online to continue it."
        );
      const host = this.deps.hosts().find((candidate) => candidate.id === session.adapterId);
      if (!host)
        throw new Error(
          "The local execution host is unavailable. Reconnect it to resume this conversation."
        );
      assertReceipt(await host.resume(scope, session.handoff), session.handoff);
      const history = [...session.messages];
      session.messages.push(message);
      session.pendingMessages.push(message);
      await this.save(scope, session);
      const { reply, checkpoint } = await host.turn({
        scope,
        handoff: session.handoff,
        message,
        history,
        executeTool: (operation, args) => this.deps.executeTool(scope, operation, args)
      });
      if (
        checkpoint.parentHandoffId !== session.handoff.id ||
        checkpoint.conversationId !== conversationId ||
        checkpoint.taskId !== conversationId ||
        checkpoint.runtime.agentId !== session.handoff.runtime.agentId ||
        checkpoint.runtime.modelId !== session.handoff.runtime.modelId ||
        checkpoint.runtime.executionHostId !== session.handoff.runtime.executionHostId ||
        checkpoint.checkpointVersion !== null ||
        checkpoint.id === session.handoff.id ||
        reply.role !== "assistant" ||
        !reply.content.trim()
      )
        throw new Error(
          "The local runtime returned an invalid checkpoint. The conversation is saved."
        );
      session.handoff = checkpoint;
      session.checkpoints.push(checkpoint);
      session.messages.push(reply);
      session.pendingMessages.push(reply);
      await this.save(scope, session);
      this.deps.changed();
      return reply;
    });
  }

  private async findHost(scope: Scope, handoff: RuntimeHandoff) {
    for (const host of this.deps.hosts()) {
      if (await bounded(host.supports(scope, handoff), "Local runtime compatibility check"))
        return host;
    }
    return null;
  }
  private resolve(conversationId: string) {
    return this.deps.cloud<ResolvedRuntimeHandoff>(this.path(conversationId));
  }
  private path(conversationId: string, suffix = "") {
    return `/v1/runtime/${encodeURIComponent(conversationId)}${suffix}`;
  }
  private async save(scope: Scope, session: LocalRuntimeHandoffSession) {
    this.deps.assertAuthorized(scope);
    await this.deps.db.transaction(scope, (state) => {
      state.runtimeHandoffSession = structuredClone(session);
    });
    this.deps.changed();
  }
}

export function capabilityReason(code: string | null): string {
  const reasons: Record<string, string> = {
    LOCAL_RUNTIME_UNSUPPORTED: "Local execution is not supported by the connected runtime.",
    LOCAL_RUNTIME_NOT_REGISTERED: "No compatible local runtime is currently connected.",
    LOCAL_RUNTIME_OFFLINE: "The local runtime is offline. Reconnect it and refresh availability.",
    LOCAL_RUNTIME_UNHEALTHY:
      "The local runtime is unhealthy. Reconnect it and refresh availability.",
    HANDOFF_IN_PROGRESS: "A runtime handoff is in progress. Resume the saved handoff.",
    NO_EXECUTION_HOST: "No compatible execution host is currently available."
  };
  return (
    reasons[code ?? ""] ?? "The current agent and model cannot resume on a connected local runtime."
  );
}

async function bounded<T>(operation: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${stage} did not finish in time. The source runtime remains active; check handoff status before retrying.`
              )
            ),
          15_000
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
