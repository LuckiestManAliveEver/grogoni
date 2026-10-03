import { randomUUID } from "node:crypto";
import type {
  AuthSessionView,
  ComputerAction,
  ComputerActionResult,
  ComputerApproval,
  ComputerAuditEvent,
  CapabilityAvailability,
  ComputerExecutionMetadata,
  ComputerNavigationPolicy,
  ComputerObservation,
  ComputerProfile,
  ComputerProfileRecord,
  ComputerSession,
  ExternalSurfaceDescriptor
} from "@grogoni/shared-types";
import {
  classifyComputerAction,
  compileUntrustedWebObservation,
  resolveCapabilityRoute
} from "@grogoni/tool-core";
import { decryptOAuthToken, encryptOAuthToken } from "../../oauth.js";
import { Cp2Error } from "../../cp2-error.js";
import type { ComputerWorkerClient } from "../../../computer-runtime/client.js";

export interface ManagedComputerSession {
  session: ComputerSession;
  taskId: string | null;
  agentId: string | null;
  modelId: string | null;
  currentObservation: ComputerObservation | null;
}

export interface ComputerRuntimeSnapshot {
  computerSessions?: ManagedComputerSession[];
  computerProfiles?: ComputerProfileRecord[];
  computerApprovals?: ComputerApproval[];
  computerAudits?: ComputerAuditEvent[];
}

export interface ComputerRuntimeDomainDeps {
  worker: ComputerWorkerClient;
  requireAnySession(sessionId: string | null, now: Date): AuthSessionView;
  requireBusinessAccess(businessId: string, userId: string): void;
  checkpoint(input: {
    sessionId: string | null;
    taskId: string;
    state: string;
    session: ComputerSession;
    observation: ComputerObservation | null;
    pendingAction: ComputerAction | null;
    approval: ComputerApproval | null;
  }): void;
  recordAuditEvent(input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }): void;
}

const defaultPolicy: ComputerNavigationPolicy = {
  allowedDomains: [],
  blockedDomains: [],
  allowHttp: false,
  allowPrivateNetworks: false,
  allowDownloads: false,
  allowUploads: false
};

export class ComputerRuntimeDomain {
  readonly profiles = new Map<string, ComputerProfileRecord>();
  readonly approvals = new Map<string, ComputerApproval>();
  readonly audits = new Map<string, ComputerAuditEvent>();
  readonly sessions = new Map<string, ManagedComputerSession>();
  constructor(private readonly deps: ComputerRuntimeDomainDeps) {}

  restore(snapshot: ComputerRuntimeSnapshot): void {
    for (const item of snapshot.computerSessions ?? []) this.sessions.set(item.session.id, item);
    for (const item of snapshot.computerProfiles ?? []) this.profiles.set(item.id, item);
    for (const item of snapshot.computerApprovals ?? []) this.approvals.set(item.id, item);
    for (const item of snapshot.computerAudits ?? []) this.audits.set(item.id, item);
  }
  clear(): void {
    this.profiles.clear();
    this.approvals.clear();
    this.audits.clear();
    this.sessions.clear();
  }

  deleteAccount(accountId: string): number {
    let deleted = 0;
    for (const [id, item] of this.sessions)
      if (item.session.accountId === accountId) {
        this.sessions.delete(id);
        deleted += 1;
      }
    for (const map of [this.profiles, this.approvals, this.audits] as const) {
      for (const [id, item] of map)
        if (item.accountId === accountId) {
          map.delete(id);
          deleted += 1;
        }
    }
    return deleted;
  }

  createProfile(
    sessionId: string | null,
    input: { businessId: string | null; label: string },
    now = new Date()
  ): ComputerProfile {
    const actor = this.authorize(sessionId, input.businessId, now);
    const timestamp = now.toISOString();
    const record: ComputerProfileRecord = {
      id: randomUUID(),
      accountId: actor.account.id,
      businessId: input.businessId,
      label: input.label.trim(),
      status: "disconnected",
      credentialReference: null,
      encryptedStorageState: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (!record.label)
      throw new Cp2Error(400, "computer_profile_label_required", "Profile label is required.");
    this.profiles.set(record.id, record);
    return this.profileView(record);
  }

  listProfiles(
    sessionId: string | null,
    businessId: string | null,
    now = new Date()
  ): ComputerProfile[] {
    const actor = this.authorize(sessionId, businessId, now);
    return [...this.profiles.values()]
      .filter((item) => item.accountId === actor.account.id && item.businessId === businessId)
      .map((item) => this.profileView(item));
  }

  async clearProfile(sessionId: string | null, profileId: string, now = new Date()): Promise<void> {
    const { actor, profile } = this.ownedProfile(sessionId, profileId, now);
    this.profiles.set(profile.id, {
      ...profile,
      encryptedStorageState: null,
      credentialReference: null,
      status: "disconnected",
      updatedAt: now.toISOString()
    });
    this.deps.recordAuditEvent({
      type: "computer.profile.cleared",
      aggregateType: "computer_profile",
      aggregateId: profile.id,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {}
    });
  }

  async createSession(
    sessionId: string | null,
    input: {
      businessId: string | null;
      conversationId: string | null;
      taskId: string | null;
      profileId: string | null;
      executionHostId: string;
      agentId: string | null;
      modelId: string | null;
      runtimeInstanceId: string | null;
      externalSurface?: ExternalSurfaceDescriptor;
      capabilityAvailability?: CapabilityAvailability;
      policy?: Partial<ComputerNavigationPolicy>;
    },
    now = new Date()
  ): Promise<ComputerSession> {
    const actor = this.authorize(sessionId, input.businessId, now);
    const profile = input.profileId
      ? this.ownedProfile(sessionId, input.profileId, now).profile
      : null;
    const storageState = profile?.encryptedStorageState
      ? decryptOAuthToken(profile.encryptedStorageState)
      : null;
    const capabilityResolution = resolveCapabilityRoute({
      ...input.capabilityAvailability,
      authorizedSurface: input.capabilityAvailability?.authorizedSurface ?? true
    });
    if (capabilityResolution.executionMode !== "computer_use") {
      throw new Cp2Error(
        capabilityResolution.executionMode === "unsupported" ? 422 : 409,
        capabilityResolution.executionMode === "unsupported"
          ? "computer_capability_unsupported"
          : "computer_programmatic_capability_preferred",
        capabilityResolution.reason
      );
    }
    if (!input.agentId) {
      throw new Cp2Error(
        409,
        "computer_orchestrating_agent_required",
        "Computer use must remain owned by an active Grogoni agent."
      );
    }
    const externalSurface: ExternalSurfaceDescriptor = input.externalSurface ?? {
      id: "generic-web",
      type: "web"
    };
    const execution: ComputerExecutionMetadata = {
      executionMode: "computer_use",
      orchestratingAgentId: input.agentId,
      ...(input.modelId ? { orchestratingModelId: input.modelId } : {}),
      externalSurface,
      capabilityResolution
    };
    const created = await this.deps.worker.createSession({
      accountId: actor.account.id,
      businessId: input.businessId,
      conversationId: input.conversationId,
      profileId: profile?.id ?? null,
      executionHostId: input.executionHostId,
      runtimeInstanceId: input.runtimeInstanceId,
      execution,
      storageState,
      policy: { ...defaultPolicy, ...input.policy }
    });
    this.sessions.set(created.id, {
      session: created,
      taskId: input.taskId,
      agentId: input.agentId,
      modelId: input.modelId,
      currentObservation: null
    });
    this.audit(actor.account.id, {
      managed: this.sessions.get(created.id)!,
      action: this.systemAction(created.id, "session.create"),
      risk: "MUTATE",
      approvalRequired: false,
      result: "completed",
      now
    });
    this.checkpoint(sessionId, this.sessions.get(created.id)!, "RUNNING", null, null);
    return created;
  }

  getSession(
    sessionId: string | null,
    computerSessionId: string,
    now = new Date()
  ): ComputerSession {
    return { ...this.ownedSession(sessionId, computerSessionId, now).managed.session };
  }

  getPendingApproval(
    sessionId: string | null,
    computerSessionId: string,
    now = new Date()
  ): ComputerApproval | null {
    this.ownedSession(sessionId, computerSessionId, now);
    return (
      [...this.approvals.values()].find(
        (item) => item.status === "pending" && item.proposedAction.sessionId === computerSessionId
      ) ?? null
    );
  }

  async perform(
    sessionId: string | null,
    action: ComputerAction,
    actorType: "agent" | "human" = "agent",
    approvalId?: string,
    now = new Date()
  ): Promise<ComputerActionResult | ComputerObservation> {
    const { actor, managed } = this.ownedSession(sessionId, action.sessionId, now);
    const decision = classifyComputerAction({
      toolName: `computer.${action.kind}`,
      actionInput: { ...action.target, value: action.value, semanticIntent: action.semanticIntent }
    });
    const canonical: ComputerAction = { ...action, risk: decision.risk };
    if (actorType === "agent" && managed.session.controlMode !== "AGENT_CONTROLLED")
      throw new Cp2Error(
        409,
        "computer_human_control_active",
        "Agent input is disabled while the user controls the browser."
      );
    if (actorType === "human" && managed.session.controlMode !== "HUMAN_CONTROLLED")
      throw new Cp2Error(
        409,
        "computer_agent_control_active",
        "Human input requires control of the browser."
      );
    let approval: ComputerApproval | null = null;
    if (decision.requiresApproval && actorType === "agent") {
      if (!approvalId) {
        approval = this.requestApproval(actor.account.id, canonical, decision.actionHash, now);
        managed.session = {
          ...managed.session,
          status: "AWAITING_APPROVAL",
          updatedAt: now.toISOString()
        };
        this.checkpoint(sessionId, managed, "AWAITING_APPROVAL", canonical, approval);
        this.audit(actor.account.id, {
          managed,
          action: canonical,
          risk: decision.risk,
          approvalRequired: true,
          approvalId: approval.id,
          result: "started",
          now
        });
        return {
          sessionId: canonical.sessionId,
          actionId: canonical.id,
          status: "requires_approval",
          approval
        };
      }
      approval = this.consumeApproval(
        approvalId,
        canonical,
        decision.actionHash,
        actor.user.id,
        now
      );
    }
    try {
      const result =
        canonical.kind === "navigate"
          ? await this.deps.worker.navigate(canonical)
          : canonical.kind === "observe"
            ? await this.deps.worker.observe(canonical.sessionId)
            : await this.deps.worker.act(canonical, actorType);
      const rawObservation = "observedAt" in result ? result : (result.observation ?? null);
      const observation = rawObservation
        ? {
            ...rawObservation,
            text: compileUntrustedWebObservation(rawObservation.text),
            untrustedContent: true
          }
        : null;
      managed.currentObservation = observation;
      managed.session = {
        ...managed.session,
        currentUrl: observation?.url ?? managed.session.currentUrl,
        status: "RUNNING",
        updatedAt: now.toISOString()
      };
      this.audit(actor.account.id, {
        managed,
        action: canonical,
        risk: decision.risk,
        approvalRequired: decision.requiresApproval,
        ...(approval ? { approvalId: approval.id } : {}),
        result: "completed",
        now
      });
      this.checkpoint(sessionId, managed, "RUNNING", null, approval);
      return "observedAt" in result
        ? (observation as ComputerObservation)
        : { ...result, ...(observation ? { observation } : {}) };
    } catch (error) {
      const uncertain = decision.requiresApproval;
      this.audit(actor.account.id, {
        managed,
        action: canonical,
        risk: decision.risk,
        approvalRequired: decision.requiresApproval,
        ...(approval ? { approvalId: approval.id } : {}),
        result: uncertain ? "outcome_unknown" : "failed",
        errorCategory: error instanceof Error ? error.message : "PROVIDER_ERROR",
        now
      });
      if (uncertain)
        return {
          sessionId: canonical.sessionId,
          actionId: canonical.id,
          status: "outcome_unknown",
          ...(approval ? { approval } : {}),
          errorCategory: "EXECUTION_OUTCOME_UNKNOWN"
        };
      throw error;
    }
  }

  decideApproval(
    sessionId: string | null,
    approvalId: string,
    approve: boolean,
    now = new Date()
  ): ComputerApproval {
    const actor = this.deps.requireAnySession(sessionId, now);
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.requestedBy !== actor.account.id)
      throw new Cp2Error(404, "computer_approval_not_found", "Approval was not found.");
    if (approval.status !== "pending" || Date.parse(approval.expiresAt) <= now.getTime())
      throw new Cp2Error(409, "computer_approval_not_pending", "Approval is no longer pending.");
    const next = {
      ...approval,
      status: approve ? ("approved" as const) : ("rejected" as const),
      decidedBy: actor.user.id,
      decidedAt: now.toISOString()
    };
    this.approvals.set(next.id, next);
    return next;
  }

  async takeControl(
    sessionId: string | null,
    computerSessionId: string,
    now = new Date()
  ): Promise<ComputerSession> {
    const { actor, managed } = this.ownedSession(sessionId, computerSessionId, now);
    managed.session = await this.deps.worker.takeControl(computerSessionId);
    this.checkpoint(sessionId, managed, "HUMAN_CONTROLLED", null, null);
    this.deps.recordAuditEvent({
      type: "computer.control.taken",
      aggregateType: "computer_session",
      aggregateId: computerSessionId,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {}
    });
    return managed.session;
  }

  async releaseControl(sessionId: string | null, computerSessionId: string, now = new Date()) {
    const { actor, managed } = this.ownedSession(sessionId, computerSessionId, now);
    const released = await this.deps.worker.releaseControl(computerSessionId);
    managed.session = released.session;
    managed.currentObservation = released.observation;
    await this.persistProfile(managed, now);
    this.checkpoint(sessionId, managed, "RESUMING", null, null);
    this.deps.recordAuditEvent({
      type: "computer.control.released",
      aggregateType: "computer_session",
      aggregateId: computerSessionId,
      actorId: actor.user.id,
      occurredAt: now.toISOString(),
      payload: {}
    });
    return released;
  }

  async frame(sessionId: string | null, computerSessionId: string, now = new Date()) {
    this.ownedSession(sessionId, computerSessionId, now);
    return this.deps.worker.frame(computerSessionId);
  }

  checkpointSession(sessionId: string | null, computerSessionId: string, now = new Date()) {
    const { managed } = this.ownedSession(sessionId, computerSessionId, now);
    this.checkpoint(sessionId, managed, managed.session.status, null, null);
    return {
      session: { ...managed.session },
      observation: managed.currentObservation ? { ...managed.currentObservation } : null
    };
  }

  async suspendSession(
    sessionId: string | null,
    computerSessionId: string,
    now = new Date()
  ): Promise<ComputerSession> {
    const { managed } = this.ownedSession(sessionId, computerSessionId, now);
    await this.persistProfile(managed, now);
    await this.deps.worker.suspend(computerSessionId);
    managed.session = {
      ...managed.session,
      controlMode: "SUSPENDED",
      status: "SUSPENDED",
      updatedAt: now.toISOString()
    };
    this.checkpoint(sessionId, managed, "SUSPENDED", null, null);
    return { ...managed.session };
  }

  async resumeSession(sessionId: string | null, computerSessionId: string, now = new Date()) {
    const { managed } = this.ownedSession(sessionId, computerSessionId, now);
    const resumed = await this.deps.worker.resume(computerSessionId);
    managed.session = resumed.session;
    managed.currentObservation = {
      ...resumed.observation,
      text: compileUntrustedWebObservation(resumed.observation.text),
      untrustedContent: true
    };
    this.checkpoint(sessionId, managed, "RUNNING", null, null);
    return { session: { ...managed.session }, observation: { ...managed.currentObservation } };
  }

  async closeSession(
    sessionId: string | null,
    computerSessionId: string,
    now = new Date()
  ): Promise<void> {
    const { managed } = this.ownedSession(sessionId, computerSessionId, now);
    await this.persistProfile(managed, now);
    await this.deps.worker.close(computerSessionId);
    managed.session = { ...managed.session, status: "COMPLETED", updatedAt: now.toISOString() };
    this.checkpoint(sessionId, managed, "COMPLETED", null, null);
    this.sessions.delete(computerSessionId);
  }

  private authorize(sessionId: string | null, businessId: string | null, now: Date) {
    const actor = this.deps.requireAnySession(sessionId, now);
    if (businessId) this.deps.requireBusinessAccess(businessId, actor.user.id);
    return actor;
  }
  private ownedProfile(sessionId: string | null, id: string, now: Date) {
    const actor = this.deps.requireAnySession(sessionId, now);
    const profile = this.profiles.get(id);
    if (!profile || profile.accountId !== actor.account.id)
      throw new Cp2Error(404, "computer_profile_not_found", "Browser profile was not found.");
    if (profile.businessId) this.deps.requireBusinessAccess(profile.businessId, actor.user.id);
    return { actor, profile };
  }
  private ownedSession(sessionId: string | null, id: string, now: Date) {
    const actor = this.deps.requireAnySession(sessionId, now);
    const managed = this.sessions.get(id);
    if (!managed || managed.session.accountId !== actor.account.id)
      throw new Cp2Error(404, "computer_session_not_found", "Computer session was not found.");
    if (managed.session.businessId)
      this.deps.requireBusinessAccess(managed.session.businessId, actor.user.id);
    return { actor, managed };
  }
  private requestApproval(
    accountId: string,
    action: ComputerAction,
    hash: string,
    now: Date
  ): ComputerApproval {
    const approval: ComputerApproval = {
      id: randomUUID(),
      accountId,
      actionId: action.id,
      actionHash: hash,
      proposedAction: action,
      status: "pending",
      requestedBy: accountId,
      decidedBy: null,
      requestedAt: now.toISOString(),
      decidedAt: null,
      usedAt: null,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString()
    };
    this.approvals.set(approval.id, approval);
    return approval;
  }
  private consumeApproval(
    id: string,
    action: ComputerAction,
    hash: string,
    userId: string,
    now: Date
  ): ComputerApproval {
    const approval = this.approvals.get(id);
    if (!approval || approval.actionId !== action.id || approval.actionHash !== hash)
      throw new Cp2Error(
        403,
        "computer_approval_invalid",
        "Approval does not match this exact action."
      );
    if (approval.status !== "approved" || Date.parse(approval.expiresAt) <= now.getTime())
      throw new Cp2Error(
        409,
        "computer_approval_unavailable",
        "Approval is expired, rejected, or already used."
      );
    const used = {
      ...approval,
      status: "used" as const,
      usedAt: now.toISOString(),
      decidedBy: approval.decidedBy ?? userId
    };
    this.approvals.set(id, used);
    return used;
  }
  private async persistProfile(managed: ManagedComputerSession, now: Date) {
    if (!managed.session.profileId) return;
    const profile = this.profiles.get(managed.session.profileId);
    if (!profile) return;
    const storageState = await this.deps.worker.storageState(managed.session.id);
    this.profiles.set(profile.id, {
      ...profile,
      encryptedStorageState: encryptOAuthToken(storageState),
      credentialReference: `computer-profile:${profile.id}`,
      status: "connected",
      updatedAt: now.toISOString()
    });
  }
  private checkpoint(
    sessionId: string | null,
    managed: ManagedComputerSession,
    state: string,
    pendingAction: ComputerAction | null,
    approval: ComputerApproval | null
  ) {
    if (managed.taskId)
      this.deps.checkpoint({
        sessionId,
        taskId: managed.taskId,
        state,
        session: managed.session,
        observation: managed.currentObservation,
        pendingAction,
        approval
      });
  }
  private audit(
    accountId: string,
    input: {
      managed: ManagedComputerSession;
      action: ComputerAction;
      risk: ComputerAuditEvent["risk"];
      approvalRequired: boolean;
      approvalId?: string;
      result: ComputerAuditEvent["result"];
      errorCategory?: string;
      now: Date;
    }
  ) {
    const url = input.action.target.url ?? input.managed.session.currentUrl;
    let domain: string | null = null;
    try {
      domain = url ? new URL(url).hostname : null;
    } catch {
      domain = null;
    }
    const event: ComputerAuditEvent = {
      id: randomUUID(),
      taskId: input.managed.taskId,
      accountId,
      businessId: input.managed.session.businessId,
      conversationId: input.managed.session.conversationId,
      agentId: input.managed.agentId,
      modelId: input.managed.modelId,
      executionMode: "computer_use",
      externalSurface: input.managed.session.execution.externalSurface,
      resolutionReason: input.managed.session.execution.capabilityResolution.reason,
      runtimeInstanceId: input.managed.session.runtimeInstanceId,
      computerSessionId: input.managed.session.id,
      executionHostId: input.managed.session.executionHostId,
      actionType: input.action.kind,
      target: {
        ...(input.action.target.url ? { url: input.action.target.url } : {}),
        ...(input.action.target.selector ? { selector: input.action.target.selector } : {}),
        ...(input.action.target.text ? { text: input.action.target.text } : {}),
        ...(input.action.target.description ? { description: input.action.target.description } : {})
      },
      domain,
      risk: input.risk,
      approvalRequired: input.approvalRequired,
      approvalId: input.approvalId ?? null,
      startedAt: input.now.toISOString(),
      completedAt: input.result === "started" ? null : input.now.toISOString(),
      result: input.result,
      errorCategory: input.errorCategory ?? null
    };
    this.audits.set(event.id, event);
    this.deps.recordAuditEvent({
      type: "computer.action",
      aggregateType: "computer_session",
      aggregateId: event.computerSessionId,
      actorId: accountId,
      occurredAt: event.startedAt,
      payload: {
        actionType: event.actionType,
        executionMode: event.executionMode,
        orchestratingAgentId: event.agentId,
        orchestratingModelId: event.modelId,
        externalSurfaceId: event.externalSurface.id,
        externalSurfaceType: event.externalSurface.type,
        resolutionReason: event.resolutionReason,
        domain: event.domain,
        risk: event.risk,
        approvalRequired: event.approvalRequired,
        approvalId: event.approvalId,
        result: event.result,
        errorCategory: event.errorCategory
      }
    });
  }
  private profileView({
    encryptedStorageState,
    ...profile
  }: ComputerProfileRecord): ComputerProfile {
    void encryptedStorageState;
    return profile;
  }
  private systemAction(sessionId: string, kind: ComputerAction["kind"]): ComputerAction {
    return { id: randomUUID(), sessionId, kind, target: {}, risk: "MUTATE" };
  }
}
