import { describe, expect, it, vi } from "vitest";
import type {
  AccountSummary,
  AiModelSummary,
  ConversationSummary,
  RuntimeContextSummary,
  RuntimeOfflineCheckpointInput,
  RuntimePlannedAction,
  RuntimeTurnSummary,
  RuntimeVerificationResult,
  UserSummary
} from "../packages/shared-types/src";
import { Cp2Error } from "../services/api/src/cp2/cp2-error";
import {
  RuntimeHandoffDomain,
  type RuntimeHandoffDomainDeps
} from "../services/api/src/cp2/domains/runtime-handoff/store";
import {
  NativeRuntimeBindingStore,
  globalDefaultRuntimeBindingId
} from "../services/api/src/cp2/domains/native-runtime/store";

describe("RuntimeHandoff retry authorization", () => {
  it("checks ownership before returning a cached checkpoint and scopes keys to the task", () => {
    const harness = buildHarness();
    const first = seedConversation(harness, "retry-owner-one");
    const second = seedConversation(harness, "retry-owner-two");
    const result = harness.domain.createCheckpoint(first.accountId, {
      taskId: first.conversationId,
      idempotencyKey: "shared-retry-key"
    });
    expect(() =>
      harness.domain.createCheckpoint(null, {
        taskId: first.conversationId,
        idempotencyKey: "shared-retry-key"
      })
    ).toThrow("Sign in required");
    expect(() =>
      harness.domain.createCheckpoint(second.accountId, {
        taskId: first.conversationId,
        idempotencyKey: "shared-retry-key"
      })
    ).toThrow("another account");
    const independent = harness.domain.createCheckpoint(second.accountId, {
      taskId: second.conversationId,
      idempotencyKey: "shared-retry-key"
    });
    expect(independent.handoff.id).not.toBe(result.handoff.id);
    expect(independent.handoff.conversationId).toBe(second.conversationId);
  });
});

// This suite exercises RuntimeHandoffDomain directly against a hand-built deps object rather than
// through the full HTTP/Fastify stack (see tests/runtime-handoff-protocol.test.ts for the REST
// surface) - it is faster to write precise transaction/concurrency/activation-failure scenarios
// this way, and it tests the same production class either way.

function buildModel(id: string, overrides: Partial<AiModelSummary> = {}): AiModelSummary {
  return {
    id,
    label: id,
    provider: "grogoni",
    description: "Test model",
    capabilities: ["chat"],
    available: true,
    source: "builtin",
    format: "remote",
    license: null,
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: null,
    minimumMemoryGb: null,
    recommended: false,
    ...overrides
  } as AiModelSummary;
}

function buildConversation(id: string, accountId: string): ConversationSummary {
  const now = new Date().toISOString();
  return {
    id,
    accountId,
    kind: "personal",
    activeShopId: null,
    runtimeBindingId: globalDefaultRuntimeBindingId,
    createdAt: now,
    updatedAt: now
  };
}

function buildOfflineCheckpoint(
  overrides: Partial<RuntimeOfflineCheckpointInput> & {
    id: string;
    parentHandoffId: string | null;
    runtime: RuntimeOfflineCheckpointInput["runtime"];
  }
): RuntimeOfflineCheckpointInput {
  return {
    goal: "Offline goal",
    currentState: "Offline current state",
    completedActions: [],
    decisions: [],
    rejectedPaths: [],
    pendingActions: [],
    nextAction: null,
    relevantContext: [],
    artifacts: [],
    tests: { passed: [], failed: [], pending: [] },
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

interface Harness {
  domain: RuntimeHandoffDomain;
  conversations: Map<string, ConversationSummary>;
  native: NativeRuntimeBindingStore;
  auditEvents: Array<{
    type: string;
    aggregateId: string;
    actorId: string;
    payload: Record<string, unknown>;
  }>;
  sessionIdFor(accountId: string): string;
}

/** sessionId === accountId in this stub - `requireAnySession` below just echoes it back as the
 *  authenticated account, since the real session/account machinery is exercised elsewhere
 *  (tests/runtime-handoff-protocol.test.ts) and isn't what this suite is testing. */
function buildHarness(depsOverrides: Partial<RuntimeHandoffDomainDeps> = {}): Harness {
  const conversations = new Map<string, ConversationSummary>();
  const native = new NativeRuntimeBindingStore();
  const auditEvents: Harness["auditEvents"] = [];
  const deps: RuntimeHandoffDomainDeps = {
    conversations,
    requireAnySession: (sessionId) => {
      if (sessionId === null || sessionId.length === 0) {
        throw new Cp2Error(401, "AUTH_REQUIRED", "Sign in required.");
      }
      const account: AccountSummary = {
        id: sessionId,
        primaryAuthChannel: "device",
        primaryAuthDestination: sessionId,
        identityLevel: "device"
      };
      const user: UserSummary = {
        id: `${sessionId}:user`,
        accountId: sessionId,
        displayName: "Test user",
        language: "en"
      };
      return {
        account,
        user,
        session: { id: sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString() }
      };
    },
    nativeRuntimeBindings: native,
    setConversationRuntimeBinding: (conversationId, runtimeBindingId, now) => {
      const conversation = conversations.get(conversationId);
      if (conversation === undefined) return;
      conversations.set(conversationId, {
        ...conversation,
        runtimeBindingId,
        updatedAt: now.toISOString()
      });
    },
    recordAuditEvent: (input) =>
      auditEvents.push({
        type: input.type,
        aggregateId: input.aggregateId,
        actorId: input.actorId,
        payload: input.payload
      }),
    ...depsOverrides
  };
  return {
    domain: new RuntimeHandoffDomain(deps),
    conversations,
    native,
    auditEvents,
    sessionIdFor: (accountId) => accountId
  };
}

/** Materializes an available primary model (+ host + installation) on the global default binding,
 *  and creates+registers one conversation pointed at it, ready for immediate use. */
function seedConversation(
  harness: Harness,
  modelId: string
): { conversationId: string; accountId: string } {
  const accountId = `acct-${modelId}`;
  const now = new Date().toISOString();
  harness.native.activateGlobalDefaultModel({
    model: buildModel(modelId),
    executionTarget: "backend",
    checkedAt: now,
    updatedBy: "system"
  });
  const conversationId = `conv-${modelId}`;
  harness.conversations.set(conversationId, buildConversation(conversationId, accountId));
  return { conversationId, accountId };
}

describe("RuntimeHandoffDomain", () => {
  it("bootstraps a legacy handoff (section 20) the first time a task with no prior checkpoint is resolved", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-a");
    const resolved = harness.domain.resolveHandoff(harness.sessionIdFor(accountId), conversationId);

    expect(resolved.activeHandoff.parentHandoffId).toBeNull();
    expect(resolved.activeHandoff.checkpointVersion).toBe(1);
    expect(resolved.taskHead.activeHandoffId).toBe(resolved.activeHandoff.id);
    expect(resolved.taskHead.nextCheckpointVersion).toBe(2);
    expect(resolved.isRuntimeStale).toBe(false);
    expect(resolved.runtimeInstance).toBeNull();
    expect(
      harness.auditEvents.some((event) => event.type === "runtime_handoff.legacy_bootstrapped")
    ).toBe(true);
  });

  it("rejects resolving a task that belongs to another account", () => {
    const harness = buildHarness();
    const { conversationId } = seedConversation(harness, "model-b");
    expect(() => harness.domain.resolveHandoff("someone-else", conversationId)).toThrow(Cp2Error);
  });

  it("creates immutable, parent-linked checkpoints with atomically increasing versions, and does not move the head unless promoted", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-c");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);

    const unpromoted = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      goal: "Unpromoted checkpoint",
      currentState: "still working"
    });
    expect(unpromoted.promoted).toBe(false);
    expect(unpromoted.handoff.checkpointVersion).toBe(2);
    expect(unpromoted.handoff.parentHandoffId).toBe(bootstrap.activeHandoff.id);
    // Head must not have moved.
    expect(harness.domain.resolveHandoff(sessionId, conversationId).taskHead.activeHandoffId).toBe(
      bootstrap.activeHandoff.id
    );

    const promoted = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      goal: "Promoted checkpoint",
      currentState: "done with step 2",
      expectedHandoffId: bootstrap.activeHandoff.id,
      promote: true
    });
    expect(promoted.promoted).toBe(true);
    expect(promoted.handoff.checkpointVersion).toBe(3);
    expect(promoted.taskHead.activeHandoffId).toBe(promoted.handoff.id);
    expect(harness.domain.resolveHandoff(sessionId, conversationId).taskHead.activeHandoffId).toBe(
      promoted.handoff.id
    );

    // Immutability: the row returned for v1 (the bootstrap) is unchanged by later checkpoints.
    const v1Again = harness.domain.getHandoffByVersion(sessionId, conversationId, 1);
    expect(v1Again).toEqual(bootstrap.activeHandoff);
  });

  it("rejects promotion when expectedHandoffId does not match the current head (optimistic concurrency, section 7)", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-d");
    const sessionId = harness.sessionIdFor(accountId);
    harness.domain.resolveHandoff(sessionId, conversationId);

    expect(() =>
      harness.domain.createCheckpoint(sessionId, {
        taskId: conversationId,
        promote: true,
        expectedHandoffId: "stale-handoff-id"
      })
    ).toThrow(Cp2Error);
    try {
      harness.domain.createCheckpoint(sessionId, {
        taskId: conversationId,
        promote: true,
        expectedHandoffId: "stale-handoff-id"
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Cp2Error);
      expect((error as Cp2Error).statusCode).toBe(409);
      expect((error as Cp2Error).code).toBe("RUNTIME_HANDOFF_CONFLICT");
    }
  });

  it("requires expectedHandoffId when promoting (section 7)", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-e");
    const sessionId = harness.sessionIdFor(accountId);
    harness.domain.resolveHandoff(sessionId, conversationId);
    expect(() =>
      harness.domain.createCheckpoint(sessionId, { taskId: conversationId, promote: true })
    ).toThrow(Cp2Error);
  });

  it("swaps the model end-to-end: task/conversation id unchanged, new checkpoint resumes from nextAction, transcript is never touched", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-f");
    const sessionId = harness.sessionIdFor(accountId);

    // Install a second, distinct model on the *same* execution host as the current one (a pure
    // model-dimension swap keeps agent/host fixed) via the same global-default-slot helper used to
    // seed the conversation, which is why this reuses activateGlobalDefaultModel rather than
    // activateVerifiedModel (which would provision its own, different host).
    const now = new Date().toISOString();
    harness.native.activateGlobalDefaultModel({
      model: buildModel("model-f-replacement"),
      executionTarget: "backend",
      checkedAt: now,
      updatedBy: "system"
    });

    const before = harness.domain.resolveHandoff(sessionId, conversationId);
    harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: before.activeHandoff.id,
      nextAction: "Summarize the last three orders",
      pendingActions: [{ id: "a1", description: "Summarize orders" }]
    });
    const preSwap = harness.domain.resolveHandoff(sessionId, conversationId);

    const result = harness.domain.performSwap(sessionId, {
      taskId: conversationId,
      dimension: "model",
      targetId: "model-f-replacement",
      expectedHandoffId: preSwap.activeHandoff.id
    });

    expect(result.activationFailed).toBe(false);
    expect(result.handoff.taskId).toBe(conversationId);
    expect(result.handoff.conversationId).toBe(conversationId);
    expect(result.handoff.runtime.modelId).toBe("model-f-replacement");
    expect(result.handoff.nextAction).toBe("Summarize the last three orders");
    expect(result.handoff.pendingActions).toEqual(preSwap.activeHandoff.pendingActions);
    expect(result.handoff.parentHandoffId).toBe(preSwap.activeHandoff.id);
    expect(result.runtimeInstance.status).toBe("READY");
    expect(result.runtimeInstance.activeHandoffId).toBe(result.handoff.id);

    const resolvedAfter = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(resolvedAfter.taskHead.activeHandoffId).toBe(result.handoff.id);
    expect(resolvedAfter.isRuntimeStale).toBe(false);
  });

  it("swaps the agent end-to-end without mutating conversation/task identity", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-g");
    const sessionId = harness.sessionIdFor(accountId);
    const now = new Date().toISOString();
    harness.native.activateVerifiedModel({
      agentId: "second-agent",
      agentName: "Second agent",
      businessId: null,
      accountId,
      model: buildModel("model-g"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "system",
      checkedAt: now
    });
    const before = harness.domain.resolveHandoff(sessionId, conversationId);
    const result = harness.domain.performSwap(sessionId, {
      taskId: conversationId,
      dimension: "agent",
      targetId: "second-agent",
      expectedHandoffId: before.activeHandoff.id
    });
    expect(result.handoff.runtime.agentId).toBe("second-agent");
    expect(result.handoff.taskId).toBe(conversationId);
    expect(result.activationFailed).toBe(false);
  });

  it("never mutates a shared runtime binding in place when swapping (section 9)", () => {
    const harness = buildHarness();
    const { conversationId: conv1, accountId } = seedConversation(harness, "model-h");
    const sessionId = harness.sessionIdFor(accountId);
    // A second conversation on the same account, sharing the same starting binding.
    const conv2 = "conv-model-h-2";
    harness.conversations.set(conv2, buildConversation(conv2, accountId));
    const sharedBindingId = harness.conversations.get(conv1)?.runtimeBindingId;
    expect(harness.conversations.get(conv2)?.runtimeBindingId).toBe(sharedBindingId);
    const sharedBindingBefore = harness.native.bindingsMap.get(sharedBindingId as string);

    const now = new Date().toISOString();
    harness.native.activateVerifiedModel({
      agentId: "isolated-agent",
      agentName: "Isolated agent",
      businessId: null,
      accountId,
      model: buildModel("model-h-alt"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "system",
      checkedAt: now
    });
    const before = harness.domain.resolveHandoff(sessionId, conv1);
    harness.domain.performSwap(sessionId, {
      taskId: conv1,
      dimension: "agent",
      targetId: "isolated-agent",
      expectedHandoffId: before.activeHandoff.id
    });

    // conv1 moved; conv2, which shared the pre-swap binding, must be completely untouched.
    expect(harness.conversations.get(conv1)?.runtimeBindingId).not.toBe(sharedBindingId);
    expect(harness.conversations.get(conv2)?.runtimeBindingId).toBe(sharedBindingId);
    expect(harness.native.bindingsMap.get(sharedBindingId as string)).toEqual(sharedBindingBefore);
  });

  it("leaves the old runtime fully authoritative when a swap's candidate chain fails compatibility validation (Prepare-phase failure)", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-i");
    const sessionId = harness.sessionIdFor(accountId);
    const before = harness.domain.resolveHandoff(sessionId, conversationId);

    expect(() =>
      harness.domain.performSwap(sessionId, {
        taskId: conversationId,
        dimension: "model",
        targetId: "does-not-exist",
        expectedHandoffId: before.activeHandoff.id
      })
    ).toThrow(Cp2Error);

    const after = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(after.taskHead.activeHandoffId).toBe(before.activeHandoff.id);
    expect(after.activeHandoff.runtime).toEqual(before.activeHandoff.runtime);
  });

  it("preserves the active checkpoint and binding when activation validation fails", () => {
    const auditEvents: Harness["auditEvents"] = [];
    const conversations = new Map<string, ConversationSummary>();
    const native = new NativeRuntimeBindingStore();
    // Legacy-bootstrap (resolveHandoff, before any swap) is the *first* resolveBindingForConversation
    // call and must succeed normally; the swap's own Activate-phase resolution is the second call -
    // that is the one this test simulates failing, to prove a runtime start failure never unwinds an
    // already-committed checkpoint/task-head (section 12).
    let resolveCalls = 0;
    const failingNative: RuntimeHandoffDomainDeps["nativeRuntimeBindings"] = Object.assign(
      Object.create(Object.getPrototypeOf(native)),
      native,
      {
        resolveBindingForConversation: (bindingId: string, conversationId: string) => {
          resolveCalls += 1;
          if (resolveCalls > 1) {
            throw new Cp2Error(503, "RUNTIME_MODELS_UNAVAILABLE", "Simulated activation failure.");
          }
          return native.resolveBindingForConversation(bindingId, conversationId);
        }
      }
    );
    const accountId = "acct-activation-fail";
    const domain = new RuntimeHandoffDomain({
      conversations,
      requireAnySession: (sessionId) => {
        if (sessionId === null) throw new Cp2Error(401, "AUTH_REQUIRED", "Sign in required.");
        return {
          account: {
            id: sessionId,
            primaryAuthChannel: "device",
            primaryAuthDestination: sessionId,
            identityLevel: "device"
          },
          user: { id: `${sessionId}:user`, accountId: sessionId, displayName: "T", language: "en" },
          session: { id: sessionId, expiresAt: new Date(Date.now() + 60_000).toISOString() }
        };
      },
      nativeRuntimeBindings: failingNative,
      setConversationRuntimeBinding: (conversationId, runtimeBindingId, now) => {
        const conversation = conversations.get(conversationId);
        if (conversation === undefined) return;
        conversations.set(conversationId, {
          ...conversation,
          runtimeBindingId,
          updatedAt: now.toISOString()
        });
      },
      recordAuditEvent: (input) =>
        auditEvents.push({
          type: input.type,
          aggregateId: input.aggregateId,
          actorId: input.actorId,
          payload: input.payload
        })
    });
    const now = new Date().toISOString();
    native.activateGlobalDefaultModel({
      model: buildModel("model-j"),
      executionTarget: "backend",
      checkedAt: now,
      updatedBy: "system"
    });
    native.activateVerifiedModel({
      agentId: "activation-fail-agent",
      agentName: "Activation fail agent",
      businessId: null,
      accountId,
      model: buildModel("model-j-alt"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "system",
      checkedAt: now
    });
    const conversationId = "conv-activation-fail";
    conversations.set(conversationId, buildConversation(conversationId, accountId));
    const sessionId = accountId;
    const before = domain.resolveHandoff(sessionId, conversationId);

    const bindingBefore = conversations.get(conversationId)?.runtimeBindingId;
    expect(() =>
      domain.performSwap(sessionId, {
        taskId: conversationId,
        dimension: "agent",
        targetId: "activation-fail-agent",
        expectedHandoffId: before.activeHandoff.id
      })
    ).toThrow("Simulated activation failure");
    const after = domain.resolveHandoff(sessionId, conversationId);
    expect(after.taskHead.activeHandoffId).toBe(before.activeHandoff.id);
    expect(conversations.get(conversationId)?.runtimeBindingId).toBe(bindingBefore);
  });

  it("detects runtime drift when the runtime instance's checkpoint lags the task head", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-k");
    const sessionId = harness.sessionIdFor(accountId);
    harness.domain.resume(sessionId, { taskId: conversationId });
    const stale = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(stale.isRuntimeStale).toBe(false);

    harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: stale.activeHandoff.id
    });

    const drifted = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(drifted.taskHead.activeHandoffId).not.toBe(drifted.runtimeInstance?.activeHandoffId);
    expect(drifted.isRuntimeStale).toBe(true);
  });

  it("rolls back the head to an earlier checkpoint without mutating any handoff row or the binding (section 14)", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-l");
    const sessionId = harness.sessionIdFor(accountId);
    const h1 = harness.domain.resolveHandoff(sessionId, conversationId).activeHandoff;
    const h2 = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: h1.id,
      currentState: "step 2"
    }).handoff;
    const h3 = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: h2.id,
      currentState: "step 3"
    }).handoff;
    const bindingBeforeRollback = harness.conversations.get(conversationId)?.runtimeBindingId;

    const rollback = harness.domain.rollback(sessionId, {
      taskId: conversationId,
      targetHandoffId: h2.id,
      expectedHandoffId: h3.id
    });

    expect(rollback.taskHead.activeHandoffId).toBe(h2.id);
    expect(rollback.activeHandoff).toEqual(h2);
    expect(harness.domain.getHandoffByVersion(sessionId, conversationId, 3).currentState).toBe(
      "step 3"
    );
    // Binding/runtime configuration is untouched by rollback.
    expect(harness.conversations.get(conversationId)?.runtimeBindingId).toBe(bindingBeforeRollback);
  });

  it("is idempotent for repeated swap requests carrying the same idempotency key (section 6.2)", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-m");
    const sessionId = harness.sessionIdFor(accountId);
    const now = new Date().toISOString();
    harness.native.activateVerifiedModel({
      agentId: "idem-agent",
      agentName: "Idempotency agent",
      businessId: null,
      accountId,
      model: buildModel("model-m-alt"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "system",
      checkedAt: now
    });
    const before = harness.domain.resolveHandoff(sessionId, conversationId);
    const idempotencyKey = "retry-key-1";

    const first = harness.domain.performSwap(sessionId, {
      taskId: conversationId,
      dimension: "agent",
      targetId: "idem-agent",
      expectedHandoffId: before.activeHandoff.id,
      idempotencyKey
    });
    const second = harness.domain.performSwap(sessionId, {
      taskId: conversationId,
      dimension: "agent",
      targetId: "idem-agent",
      expectedHandoffId: before.activeHandoff.id,
      idempotencyKey
    });

    expect(second.handoff.id).toBe(first.handoff.id);
    expect(
      harness.domain.resolveHandoff(sessionId, conversationId).taskHead.nextCheckpointVersion
    ).toBe(before.taskHead.nextCheckpointVersion + 1);
  });

  it("does not create duplicate promoted checkpoints for a repeated checkpoint request with the same idempotency key", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-n");
    const sessionId = harness.sessionIdFor(accountId);
    const before = harness.domain.resolveHandoff(sessionId, conversationId);
    const idempotencyKey = "checkpoint-retry-1";

    const first = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: before.activeHandoff.id,
      currentState: "checkpoint A",
      idempotencyKey
    });
    const second = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: before.activeHandoff.id,
      currentState: "checkpoint A",
      idempotencyKey
    });

    expect(second.handoff.id).toBe(first.handoff.id);
    expect(
      harness.domain.resolveHandoff(sessionId, conversationId).taskHead.nextCheckpointVersion
    ).toBe(before.taskHead.nextCheckpointVersion + 1);
  });

  it("gives concurrent conflicting swaps against the same expected head exactly one winner and one 409 (no lost update)", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-o");
    const sessionId = harness.sessionIdFor(accountId);
    const now = new Date().toISOString();
    harness.native.activateVerifiedModel({
      agentId: "racer-a",
      agentName: "Racer A",
      businessId: null,
      accountId,
      model: buildModel("model-o-a"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "system",
      checkedAt: now
    });
    harness.native.activateVerifiedModel({
      agentId: "racer-b",
      agentName: "Racer B",
      businessId: null,
      accountId,
      model: buildModel("model-o-b"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "system",
      checkedAt: now
    });
    const before = harness.domain.resolveHandoff(sessionId, conversationId);

    const attempt = (targetId: string) => {
      try {
        return {
          ok: true as const,
          result: harness.domain.performSwap(sessionId, {
            taskId: conversationId,
            dimension: "agent",
            targetId,
            expectedHandoffId: before.activeHandoff.id
          })
        };
      } catch (error) {
        return { ok: false as const, error };
      }
    };
    // This process is single-threaded and every domain call here is synchronous, so "concurrent"
    // dispatch collapses to sequential calls that both read the same pre-race expectedHandoffId -
    // exactly the scenario optimistic concurrency (section 7) exists to catch.
    const first = attempt("racer-a");
    const second = attempt("racer-b");

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { ok: false; error: unknown }).error).toBeInstanceOf(Cp2Error);
    expect(((losers[0] as { ok: false; error: unknown }).error as Cp2Error).statusCode).toBe(409);

    const finalVersions = [
      ...(harness.domain.resolveHandoff(sessionId, conversationId).taskHead
        ? [harness.domain.resolveHandoff(sessionId, conversationId).taskHead.activeHandoffId]
        : [])
    ];
    expect(finalVersions).toHaveLength(1);
  });

  it("allocates strictly increasing, unique checkpoint versions for a task across mixed checkpoint/swap/rollback operations", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "model-p");
    const sessionId = harness.sessionIdFor(accountId);
    const now = new Date().toISOString();
    // Two more models on the *same* shared global-default host as the seeded one, so alternating
    // "model" swaps between them never trips the execution-host compatibility check.
    harness.native.activateGlobalDefaultModel({
      model: buildModel("model-p-alt"),
      executionTarget: "backend",
      checkedAt: now,
      updatedBy: "system"
    });
    void accountId;

    let head = harness.domain.resolveHandoff(sessionId, conversationId).activeHandoff;
    const versions = [head.checkpointVersion];
    const targets = ["model-p", "model-p-alt"];
    for (let i = 0; i < 4; i += 1) {
      const swap = harness.domain.performSwap(sessionId, {
        taskId: conversationId,
        dimension: "model",
        targetId: targets[i % targets.length] as string,
        expectedHandoffId: head.id
      });
      head = swap.handoff;
      versions.push(head.checkpointVersion);
    }
    const checkpointResult = harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: head.id,
      currentState: "final checkpoint"
    });
    head = checkpointResult.handoff;
    versions.push(head.checkpointVersion);
    const rollback = harness.domain.rollback(sessionId, {
      taskId: conversationId,
      targetHandoffId: (versions[1] !== undefined
        ? harness.domain.getHandoffByVersion(sessionId, conversationId, versions[1] as number)
        : head
      ).id,
      expectedHandoffId: head.id
    });
    // Rollback moves the head pointer but must not allocate a new version or duplicate one.
    expect(rollback.activeHandoff.checkpointVersion).toBe(versions[1]);

    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

describe("RuntimeHandoffDomain offline sync and merge", () => {
  it("syncs a causally-ordered batch of offline checkpoints, assigning versions in order, without promoting by default", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-a");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);
    const runtime = bootstrap.activeHandoff.runtime;

    const c1 = buildOfflineCheckpoint({
      id: "offline-c1",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime,
      currentState: "offline step 1"
    });
    const c2 = buildOfflineCheckpoint({
      id: "offline-c2",
      parentHandoffId: "offline-c1",
      runtime,
      currentState: "offline step 2"
    });

    const result = harness.domain.syncOfflineCheckpoints(sessionId, {
      taskId: conversationId,
      checkpoints: [c1, c2]
    });

    expect(result.syncedHandoffs).toHaveLength(2);
    expect(result.syncedHandoffs[0]?.id).toBe("offline-c1");
    expect(result.syncedHandoffs[0]?.checkpointVersion).toBe(2);
    expect(result.syncedHandoffs[1]?.id).toBe("offline-c2");
    expect(result.syncedHandoffs[1]?.checkpointVersion).toBe(3);
    expect(result.syncedHandoffs[1]?.parentHandoffId).toBe("offline-c1");
    // Not promoted by default - head is still at the online bootstrap checkpoint.
    expect(result.taskHead.activeHandoffId).toBe(bootstrap.activeHandoff.id);
    expect(
      harness.domain.resolveHandoff(sessionId, conversationId).taskHead.nextCheckpointVersion
    ).toBe(4);
  });

  it("promotes the head to the last synced checkpoint (or an explicit promoteToHandoffId) when promote:true", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-b");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);
    const runtime = bootstrap.activeHandoff.runtime;
    const c1 = buildOfflineCheckpoint({
      id: "offline-b-c1",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime
    });

    const result = harness.domain.syncOfflineCheckpoints(sessionId, {
      taskId: conversationId,
      checkpoints: [c1],
      promote: true,
      expectedHandoffId: bootstrap.activeHandoff.id
    });

    expect(result.taskHead.activeHandoffId).toBe("offline-b-c1");
    expect(harness.domain.resolveHandoff(sessionId, conversationId).taskHead.activeHandoffId).toBe(
      "offline-b-c1"
    );
  });

  it("rejects a batch submitted out of causal order", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-c");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);
    const runtime = bootstrap.activeHandoff.runtime;
    const orphan = buildOfflineCheckpoint({
      id: "offline-c-orphan",
      parentHandoffId: "does-not-exist-yet",
      runtime
    });

    expect(() =>
      harness.domain.syncOfflineCheckpoints(sessionId, {
        taskId: conversationId,
        checkpoints: [orphan]
      })
    ).toThrow(Cp2Error);
    try {
      harness.domain.syncOfflineCheckpoints(sessionId, {
        taskId: conversationId,
        checkpoints: [orphan]
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Cp2Error);
      expect((error as Cp2Error).code).toBe("RUNTIME_OFFLINE_PARENT_MISSING");
    }
  });

  it("is idempotent for a retried sync (same checkpoint id, same content) and rejects a retried sync with different content", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-d");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);
    const runtime = bootstrap.activeHandoff.runtime;
    const c1 = buildOfflineCheckpoint({
      id: "offline-d-c1",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime,
      currentState: "step 1"
    });

    const first = harness.domain.syncOfflineCheckpoints(sessionId, {
      taskId: conversationId,
      checkpoints: [c1]
    });
    const second = harness.domain.syncOfflineCheckpoints(sessionId, {
      taskId: conversationId,
      checkpoints: [c1]
    });
    expect(second.syncedHandoffs[0]?.id).toBe(first.syncedHandoffs[0]?.id);
    // No duplicate version was allocated for the retried sync.
    expect(
      harness.domain.resolveHandoff(sessionId, conversationId).taskHead.nextCheckpointVersion
    ).toBe(bootstrap.taskHead.nextCheckpointVersion + 1);

    const conflicting = buildOfflineCheckpoint({
      id: "offline-d-c1",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime,
      currentState: "a different step 1"
    });
    expect(() =>
      harness.domain.syncOfflineCheckpoints(sessionId, {
        taskId: conversationId,
        checkpoints: [conflicting]
      })
    ).toThrow(Cp2Error);
  });

  it("rejects an offline checkpoint whose runtime triple no longer exists", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-e");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);
    const bogus = buildOfflineCheckpoint({
      id: "offline-e-c1",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime: {
        agentId: "does-not-exist",
        modelId: "does-not-exist",
        executionHostId: "does-not-exist"
      }
    });
    expect(() =>
      harness.domain.syncOfflineCheckpoints(sessionId, {
        taskId: conversationId,
        checkpoints: [bogus]
      })
    ).toThrow(Cp2Error);
  });

  it("merges two offline branches into one checkpoint carrying both as ancestors, and promotes the head to it", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-f");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);
    const runtime = bootstrap.activeHandoff.runtime;

    // Two checkpoints forked from the same parent while offline - a genuine branch.
    const branchA = buildOfflineCheckpoint({
      id: "offline-f-a",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime,
      currentState: "branch A"
    });
    const branchB = buildOfflineCheckpoint({
      id: "offline-f-b",
      parentHandoffId: bootstrap.activeHandoff.id,
      runtime,
      currentState: "branch B"
    });
    const synced = harness.domain.syncOfflineCheckpoints(sessionId, {
      taskId: conversationId,
      checkpoints: [branchA, branchB]
    });
    expect(synced.taskHead.activeHandoffId).toBe(bootstrap.activeHandoff.id);

    const merge = harness.domain.mergeCheckpoints(sessionId, {
      taskId: conversationId,
      branchHandoffIds: ["offline-f-a", "offline-f-b"],
      currentState: "merged branch A and B",
      expectedHandoffId: bootstrap.activeHandoff.id
    });

    expect(merge.handoff.parentHandoffId).toBe("offline-f-a");
    expect(merge.handoff.mergedFromHandoffIds).toEqual(["offline-f-b"]);
    expect(merge.handoff.currentState).toBe("merged branch A and B");
    expect(merge.taskHead.activeHandoffId).toBe(merge.handoff.id);
    expect(harness.domain.resolveHandoff(sessionId, conversationId).taskHead.activeHandoffId).toBe(
      merge.handoff.id
    );
  });

  it("rejects a merge with fewer than two branches, an unknown branch id, or a stale expectedHandoffId", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "offline-g");
    const sessionId = harness.sessionIdFor(accountId);
    const bootstrap = harness.domain.resolveHandoff(sessionId, conversationId);

    expect(() =>
      harness.domain.mergeCheckpoints(sessionId, {
        taskId: conversationId,
        branchHandoffIds: [bootstrap.activeHandoff.id],
        expectedHandoffId: bootstrap.activeHandoff.id
      })
    ).toThrow(Cp2Error);

    expect(() =>
      harness.domain.mergeCheckpoints(sessionId, {
        taskId: conversationId,
        branchHandoffIds: [bootstrap.activeHandoff.id, "does-not-exist"],
        expectedHandoffId: bootstrap.activeHandoff.id
      })
    ).toThrow(Cp2Error);

    expect(() =>
      harness.domain.mergeCheckpoints(sessionId, {
        taskId: conversationId,
        branchHandoffIds: [bootstrap.activeHandoff.id, bootstrap.activeHandoff.id],
        expectedHandoffId: "stale-handoff-id"
      })
    ).toThrow(Cp2Error);
  });
});

describe("acknowledged hosted/local transfers", () => {
  function setup() {
    const h = buildHarness();
    const owner = seedConversation(h, "portable-model");
    const source = h.domain.resolveHandoff(owner.accountId, owner.conversationId).activeHandoff;
    const hosted = h.native.hostsMap.get(source.runtime.executionHostId)!;
    const local = {
      ...hosted,
      id: "local-host",
      type: "installed-app",
      accountId: owner.accountId,
      capabilities: [...hosted.capabilities, "runtime-handoff-v1"],
      configuration: { deviceId: "device" }
    };
    h.native.hostsMap.set(local.id, local);
    const installation = [...h.native.installationsMap.values()].find(
      (item) => item.executionHostId === hosted.id
    )!;
    h.native.installationsMap.set("local-installation", {
      ...installation,
      id: "local-installation",
      executionHostId: local.id
    });
    const input = {
      taskId: owner.conversationId,
      deviceId: "device",
      targetExecutionHostId: local.id,
      expectedHandoffId: source.id,
      idempotencyKey: "transfer-key"
    };
    const heartbeat = () =>
      h.domain.heartbeatHost(owner.accountId, owner.conversationId, local.id, "device", true);
    const begin = () => h.domain.beginTransfer(owner.accountId, input);
    const complete = (id: string) => {
      const op = h.domain.getTransfer(owner.accountId, owner.conversationId, id);
      const cp = h.domain.handoffsMap.get(op.checkpointId!)!;
      return h.domain.completeTransfer(owner.accountId, owner.conversationId, id, "device", {
        handoffId: cp.id,
        agentId: cp.runtime.agentId,
        modelId: cp.runtime.modelId,
        harness: true,
        artifacts: true,
        protectedContext: true,
        businessState: true
      });
    };
    return { h, owner, source, hosted, local, input, heartbeat, begin, complete };
  }

  it("fails immediately without a registered target and never changes the active runtime", () => {
    const f = setup();
    f.h.native.hostsMap.delete(f.local.id);
    const cap = f.h.domain.capabilities(f.owner.accountId, f.owner.conversationId, "device");
    expect(cap.handoff).toMatchObject({
      available: false,
      supported: false,
      reason: "LOCAL_RUNTIME_NOT_REGISTERED"
    });
    expect(() => f.begin()).toThrow("not registered");
    expect(f.h.domain.transfersMap.size).toBe(0);
    expect(
      f.h.domain.resolveHandoff(f.owner.accountId, f.owner.conversationId).activeHandoff.id
    ).toBe(f.source.id);
  });

  it("requires a live bridge on its provisioned device, independently of model installation", () => {
    const f = setup();
    expect(
      f.h.domain.capabilities(f.owner.accountId, f.owner.conversationId, "device").local[0]
    ).toMatchObject({ supported: true, configured: true, available: false, reachable: false });
    expect(() => f.begin()).toThrow("currently connected");
    f.heartbeat();
    expect(
      f.h.domain.capabilities(f.owner.accountId, f.owner.conversationId, "device").local[0]
        ?.available
    ).toBe(true);
    expect(
      f.h.domain.capabilities(f.owner.accountId, f.owner.conversationId, "another-device").local[0]
        ?.available
    ).toBe(false);
    expect(() =>
      f.h.domain.heartbeatHost(
        f.owner.accountId,
        f.owner.conversationId,
        f.local.id,
        "another-device",
        true
      )
    ).toThrow("no provisioned");
  });

  it("preserves portable execution state in both directions and commits only after exact restore", () => {
    const f = setup();
    f.heartbeat();
    const checkpoint = f.h.domain.createCheckpoint(f.owner.accountId, {
      taskId: f.owner.conversationId,
      expectedHandoffId: f.source.id,
      promote: true,
      nextAction: "Receive tool result",
      pendingActions: [{ id: "tool-1", description: "Await stock lookup", status: "pending" }],
      relevantContext: [{ kind: "document", refId: "protected-reference" }]
    });
    f.input.expectedHandoffId = checkpoint.handoff.id;
    const op = f.begin();
    expect(op.status).toBe("TARGET_ACTIVATING");
    expect(
      f.h.domain.resolveHandoff(f.owner.accountId, f.owner.conversationId).activeHandoff.id
    ).toBe(checkpoint.handoff.id);
    const target = f.h.domain.handoffsMap.get(op.checkpointId!)!;
    expect(target.pendingActions).toEqual(checkpoint.handoff.pendingActions);
    expect(target.relevantContext).toEqual(checkpoint.handoff.relevantContext);
    expect(target.runtime).toEqual({ ...f.source.runtime, executionHostId: f.local.id });
    expect(f.complete(op.id).status).toBe("COMPLETED");
    const back = f.h.domain.beginTransfer(f.owner.accountId, {
      ...f.input,
      idempotencyKey: "back",
      expectedHandoffId: target.id,
      targetExecutionHostId: f.hosted.id
    });
    expect(f.complete(back.id).status).toBe("COMPLETED");
    const restored = f.h.domain.resolveHandoff(f.owner.accountId, f.owner.conversationId);
    expect(restored.activeHandoff.runtime).toEqual(f.source.runtime);
    expect(restored.activeHandoff.nextAction).toBe("Receive tool result");
    expect(f.h.auditEvents.map((item) => item.type)).toContain("runtime.restore_completed");
  });

  it("completes a transfer whose soft deadline has already passed when a valid receipt arrives, instead of losing it to its own expiry check", () => {
    // Real prepare/resume work can plausibly outrun the 120s soft expiresAt deadline even when it
    // fully succeeds. completeTransfer must not be the first thing to observe that lateness and
    // force-fail its own operation before ever looking at the receipt - regression for a bug where
    // an otherwise-successful local handoff was reported as failed and could not be retried.
    const f = setup();
    f.heartbeat();
    const op = f.begin();
    const cp = f.h.domain.handoffsMap.get(op.checkpointId!)!;
    const late = new Date(Date.parse(op.expiresAt) + 1);
    f.h.domain.heartbeatHost(
      f.owner.accountId,
      f.owner.conversationId,
      f.local.id,
      "device",
      true,
      late
    );
    const result = f.h.domain.completeTransfer(
      f.owner.accountId,
      f.owner.conversationId,
      op.id,
      "device",
      {
        handoffId: cp.id,
        agentId: cp.runtime.agentId,
        modelId: cp.runtime.modelId,
        harness: true,
        artifacts: true,
        protectedContext: true,
        businessState: true
      },
      late
    );
    expect(result.status).toBe("COMPLETED");
    expect(
      f.h.domain.resolveHandoff(f.owner.accountId, f.owner.conversationId).activeHandoff.id
    ).toBe(cp.id);
  });

  it("still expires a transfer that was already observed as stale before a late completion arrives", () => {
    // Contrast with the test above: once expiry has been externally recorded (e.g. a status poll
    // already ran past the deadline), a subsequent completion for that same operation must not
    // resurrect it - only completeTransfer's own internal checks are deadline-exempt.
    const f = setup();
    f.heartbeat();
    const op = f.begin();
    const late = new Date(Date.parse(op.expiresAt) + 1);
    f.h.domain.getTransfer(f.owner.accountId, f.owner.conversationId, op.id, late);
    expect(f.complete(op.id).status).toBe("FAILED");
  });

  it("deduplicates retries, rejects changed payloads and crossing transfers, and restores operation progress", () => {
    const f = setup();
    f.heartbeat();
    const op = f.begin();
    expect(f.begin().id).toBe(op.id);
    expect(() =>
      f.h.domain.beginTransfer(f.owner.accountId, { ...f.input, idempotencyKey: "other" })
    ).toThrow("already in progress");
    expect(() =>
      f.h.domain.beginTransfer(f.owner.accountId, {
        ...f.input,
        targetExecutionHostId: f.hosted.id
      })
    ).toThrow("already used");
    f.h.domain.restore({
      runtimeTransfers: [...f.h.domain.transfersMap.values()],
      runtimeHandoffs: [...f.h.domain.handoffsMap.values()],
      runtimeTaskHeads: [...f.h.domain.taskHeadsMap.values()]
    });
    expect(
      f.h.domain.capabilities(f.owner.accountId, f.owner.conversationId, "device").activeTransfer
        ?.id
    ).toBe(op.id);
    expect(f.complete(op.id).status).toBe("COMPLETED");
    expect(f.complete(op.id).status).toBe("COMPLETED");
    expect(f.h.domain.transfersMap.size).toBe(1);
  });

  it.each(["host lost", "bad receipt", "expired", "stale head"])(
    "preserves hosted execution when %s",
    (reason) => {
      const f = setup();
      f.heartbeat();
      const op = f.begin();
      if (reason === "host lost")
        f.h.domain.heartbeatHost(
          f.owner.accountId,
          f.owner.conversationId,
          f.local.id,
          "device",
          false
        );
      if (reason === "expired")
        f.h.domain.getTransfer(
          f.owner.accountId,
          f.owner.conversationId,
          op.id,
          new Date(Date.parse(op.expiresAt) + 1)
        );
      if (reason === "stale head")
        f.h.domain.taskHeadsMap.set(f.owner.conversationId, {
          ...f.h.domain.taskHeadsMap.get(f.owner.conversationId)!,
          activeHandoffId: "advanced"
        });
      const result =
        reason === "bad receipt"
          ? f.h.domain.completeTransfer(f.owner.accountId, f.owner.conversationId, op.id, "device")
          : f.complete(op.id);
      expect(result.status).toBe("FAILED");
      expect(result.failureCode).toBeTruthy();
      expect(f.h.domain.taskHeadsMap.get(f.owner.conversationId)?.activeHandoffId).toBe(
        reason === "stale head" ? "advanced" : f.source.id
      );
    }
  );

  it("rejects cross-account, cross-business, and cross-device operations including retries", () => {
    const f = setup();
    f.heartbeat();
    const op = f.begin();
    expect(() => f.h.domain.getTransfer("attacker", f.owner.conversationId, op.id)).toThrow(
      "another account"
    );
    expect(() =>
      f.h.domain.completeTransfer(f.owner.accountId, f.owner.conversationId, op.id, "other")
    ).toThrow("initiating device");
    f.h.domain.failTransfer(f.owner.accountId, f.owner.conversationId, op.id, "device");
    f.h.native.hostsMap.set(f.local.id, { ...f.local, businessId: "foreign-business" });
    expect(() =>
      f.h.domain.beginTransfer(f.owner.accountId, { ...f.input, idempotencyKey: "new" })
    ).toThrow("another account or business");
  });
  it("records checkpoint failure without replacing the source", () => {
    const f = setup();
    f.heartbeat();
    const write = vi.spyOn(f.h.domain.handoffsMap, "set").mockImplementation(() => {
      throw new Error("Checkpoint store failed");
    });
    try {
      expect(f.begin()).toMatchObject({ status: "FAILED", failureCode: "CHECKPOINT_FAILED" });
      expect(f.h.domain.taskHeadsMap.get(f.owner.conversationId)?.activeHandoffId).toBe(
        f.source.id
      );
    } finally {
      write.mockRestore();
    }
  });

  it("excludes executing turns, head writes during transfer, and hosted execution after local commit", () => {
    const f = setup();
    f.heartbeat();
    const acquired = f.h.domain.acquireTurn(f.owner.conversationId, f.owner.accountId, "shop");
    expect(() => f.begin()).toThrow("current turn is still executing");
    acquired.release();
    const op = f.begin();
    expect(() => f.h.domain.acquireTurn(f.owner.conversationId, f.owner.accountId, "shop")).toThrow(
      "turn or handoff"
    );
    expect(() =>
      f.h.domain.createCheckpoint(f.owner.accountId, {
        taskId: f.owner.conversationId,
        promote: true,
        expectedHandoffId: f.source.id
      })
    ).toThrow("already in progress");
    f.complete(op.id);
    expect(() => f.h.domain.acquireTurn(f.owner.conversationId, f.owner.accountId, "shop")).toThrow(
      "local runtime"
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Durable execution event log + fencing (docs/architecture/durable-execution-plane.md).
// ---------------------------------------------------------------------------------------------

/** Minimal fake turn: `checkpointAfterTurn` only reads `id`, `status`, and a few `plan` fields -
 *  the rest is present only to satisfy the type. */
function buildFakeTurn(overrides: { id: string; toolName?: string }): RuntimeTurnSummary {
  return {
    id: overrides.id,
    sessionId: "session",
    businessId: "shop",
    actorId: "actor",
    message: "test",
    normalizedInput: "test",
    parserIntent: "unknown",
    parserConfidence: 1,
    status: "completed",
    context: {} as RuntimeContextSummary,
    plan: {
      id: `${overrides.id}-plan`,
      toolName: (overrides.toolName ?? "unknown.clarify") as RuntimePlannedAction["toolName"],
      risk: "low",
      requiresConfirmation: false,
      status: "safe_to_execute",
      input: {},
      validationErrors: [],
      confirmationToken: null,
      executedAt: null
    },
    verification: {} as RuntimeVerificationResult,
    model: null,
    response: "ok",
    toolResult: null,
    telemetry: [],
    runtimeVersion: 1,
    createdAt: new Date().toISOString()
  };
}

describe('RuntimeHandoffDomain execution fencing (durable-execution-plane.md "Fencing")', () => {
  it("CRITICAL: rejects a checkpoint commit from an execution whose fence token a rebind has superseded", () => {
    // Execution A owns the task, captures its fence token via acquireTurn (mirrors fence=41 in
    // the spec's example scenario), then a handoff (performSwap - a rebind) happens *before*
    // Execution A's own checkpoint write lands (mirrors fence=42 for Execution B). Execution A's
    // late checkpoint attempt must be rejected, and the swap's own checkpoint must remain the
    // task's canonical state - not overwritten by the stale turn.
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-a");
    const sessionId = harness.sessionIdFor(accountId);
    harness.native.activateGlobalDefaultModel({
      model: buildModel("fence-model-a-replacement"),
      executionTarget: "backend",
      checkedAt: new Date().toISOString(),
      updatedBy: "system"
    });

    // Execution A acquires the task (no rebind has happened yet, so fenceToken is null - fencing
    // has nothing to compare against until the first rebind, exactly as documented on
    // RuntimeTaskInstance.fenceToken).
    const executionA = harness.domain.acquireTurn(conversationId, accountId, "shop");
    expect(executionA.fenceToken).toBeNull();
    executionA.release();

    // The first rebind mints fence token 1 for this task.
    const before = harness.domain.resolveHandoff(sessionId, conversationId);
    const swap = harness.domain.performSwap(sessionId, {
      taskId: conversationId,
      dimension: "model",
      targetId: "fence-model-a-replacement",
      expectedHandoffId: before.activeHandoff.id
    });
    expect(swap.runtimeInstance.fenceToken).toBe(1);

    // Execution B (this handoff) now owns the task at fence 1. A second execution (C) acquires
    // the task after the rebind, correctly capturing that fence token - mirroring the spec's
    // "Execution #42 receives fence 42" step.
    const executionC = harness.domain.acquireTurn(conversationId, accountId, "shop");
    expect(executionC.fenceToken).toBe(1);
    executionC.release();

    // A second rebind (resume) mints fence token 2 - Execution C's captured token (1) is now
    // stale.
    harness.domain.resume(sessionId, { taskId: conversationId });
    expect(harness.domain.taskInstancesMap.get(conversationId)?.fenceToken).toBe(2);

    const beforeRejection = harness.domain.resolveHandoff(sessionId, conversationId).activeHandoff;
    expect(() =>
      harness.domain.checkpointAfterTurn(
        conversationId,
        buildFakeTurn({ id: "execution-c-late-commit" }),
        1 // Execution C's stale, superseded fence token.
      )
    ).toThrow(Cp2Error);
    try {
      harness.domain.checkpointAfterTurn(
        conversationId,
        buildFakeTurn({ id: "execution-c-late-commit-2" }),
        1
      );
    } catch (error) {
      expect(error).toBeInstanceOf(Cp2Error);
      expect((error as Cp2Error).statusCode).toBe(409);
      expect((error as Cp2Error).code).toBe("STALE_EXECUTION_FENCE");
    }

    // The rejected mutation never landed: the task head still points at the same checkpoint it
    // did immediately before the rejected commit attempt.
    const after = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(after.taskHead.activeHandoffId).toBe(beforeRejection.id);

    // The rejection itself is durably observable.
    const events = harness.domain.listExecutionEvents(sessionId, conversationId);
    const rejectionEvents = events.filter(
      (event) => event.eventType === "EXECUTION_FENCE_REJECTED"
    );
    expect(rejectionEvents.length).toBeGreaterThan(0);
    expect(rejectionEvents[0]?.payload).toMatchObject({
      expectedFenceToken: 1,
      currentFenceToken: 2
    });
  });

  it("accepts a checkpoint commit whose captured fence token still matches the task's current execution", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-b");
    const sessionId = harness.sessionIdFor(accountId);
    harness.domain.resume(sessionId, { taskId: conversationId });
    const acquired = harness.domain.acquireTurn(conversationId, accountId, "shop");
    acquired.release();
    expect(() =>
      harness.domain.checkpointAfterTurn(
        conversationId,
        buildFakeTurn({ id: "fresh-turn" }),
        acquired.fenceToken
      )
    ).not.toThrow();
    const after = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(after.activeHandoff.currentState).toContain("fresh-turn");
  });

  it("duplicate resume: the later resume wins and mints a fresh fence, superseding the earlier one", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-c");
    const sessionId = harness.sessionIdFor(accountId);
    const first = harness.domain.resume(sessionId, { taskId: conversationId });
    const second = harness.domain.resume(sessionId, { taskId: conversationId });
    expect(second.runtimeInstance.fenceToken).toBeGreaterThan(first.runtimeInstance.fenceToken);
    expect(second.runtimeInstance.executionId).not.toBe(first.runtimeInstance.executionId);
    // The first resume's fence token can no longer commit.
    expect(() =>
      harness.domain.checkpointAfterTurn(
        conversationId,
        buildFakeTurn({ id: "first-resume-late-commit" }),
        first.runtimeInstance.fenceToken
      )
    ).toThrow("moved on from");
  });

  it("cancelExecution is idempotent and durably records EXECUTION_CANCELLED", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-d");
    const sessionId = harness.sessionIdFor(accountId);
    harness.domain.resolveHandoff(sessionId, conversationId);
    const first = harness.domain.cancelExecution(sessionId, conversationId);
    expect(first.status).toBe("STOPPED");
    const second = harness.domain.cancelExecution(sessionId, conversationId);
    expect(second.executionId).toBe(first.executionId); // no-op on an already-stopped task
    const events = harness.domain.listExecutionEvents(sessionId, conversationId);
    expect(events.filter((event) => event.eventType === "EXECUTION_CANCELLED")).toHaveLength(1);
  });

  it("produces a strictly increasing, per-task event sequence across checkpoint/swap/resume", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-e");
    const sessionId = harness.sessionIdFor(accountId);
    harness.native.activateGlobalDefaultModel({
      model: buildModel("fence-model-e-replacement"),
      executionTarget: "backend",
      checkedAt: new Date().toISOString(),
      updatedBy: "system"
    });
    const before = harness.domain.resolveHandoff(sessionId, conversationId);
    harness.domain.createCheckpoint(sessionId, {
      taskId: conversationId,
      promote: true,
      expectedHandoffId: before.activeHandoff.id
    });
    const midway = harness.domain.resolveHandoff(sessionId, conversationId);
    harness.domain.performSwap(sessionId, {
      taskId: conversationId,
      dimension: "model",
      targetId: "fence-model-e-replacement",
      expectedHandoffId: midway.activeHandoff.id
    });
    harness.domain.resume(sessionId, { taskId: conversationId });

    const events = harness.domain.listExecutionEvents(sessionId, conversationId);
    expect(events.length).toBeGreaterThan(3);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.sequenceNumber).toBe(events[i - 1]!.sequenceNumber + 1);
    }
    expect(events.map((event) => event.eventType)).toContain("HANDOFF_STARTED");
    expect(events.map((event) => event.eventType)).toContain("RUNTIME_REBOUND");
    expect(events.map((event) => event.eventType)).toContain("HANDOFF_COMPLETED");
    expect(events.map((event) => event.eventType)).toContain("EXECUTION_RESUMED");
  });

  it("createCheckpoint (the general checkpoint API, e.g. for a future out-of-process LocalHandoffHost) also honors an expectedFenceToken", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-g");
    const sessionId = harness.sessionIdFor(accountId);
    const firstResume = harness.domain.resume(sessionId, { taskId: conversationId });
    const capturedFenceToken = firstResume.runtimeInstance.fenceToken;

    // A concurrent rebind supersedes the captured fence token.
    harness.domain.resume(sessionId, { taskId: conversationId });

    const beforeAttempt = harness.domain.resolveHandoff(sessionId, conversationId);
    expect(() =>
      harness.domain.createCheckpoint(sessionId, {
        taskId: conversationId,
        promote: true,
        expectedHandoffId: beforeAttempt.activeHandoff.id,
        expectedFenceToken: capturedFenceToken
      })
    ).toThrow("moved on from");
    // Not promoted: the head is unchanged by the rejected attempt.
    expect(harness.domain.resolveHandoff(sessionId, conversationId).taskHead.activeHandoffId).toBe(
      beforeAttempt.taskHead.activeHandoffId
    );

    // A non-promoting checkpoint (a branch, not a commit to the canonical head) is unaffected by
    // fencing - only a promotion can overwrite the task's canonical state.
    expect(() =>
      harness.domain.createCheckpoint(sessionId, {
        taskId: conversationId,
        promote: false,
        expectedFenceToken: capturedFenceToken
      })
    ).not.toThrow();

    // The current fence token still works.
    const current = harness.domain.resolveHandoff(sessionId, conversationId);
    const currentFenceToken = harness.domain.taskInstancesMap.get(conversationId)?.fenceToken;
    expect(() =>
      harness.domain.createCheckpoint(sessionId, {
        taskId: conversationId,
        promote: true,
        expectedHandoffId: current.activeHandoff.id,
        expectedFenceToken: currentFenceToken
      })
    ).not.toThrow();
  });

  it("inspect() reports resume eligibility and the latest event window without exposing secrets", () => {
    const harness = buildHarness();
    const { conversationId, accountId } = seedConversation(harness, "fence-model-f");
    const sessionId = harness.sessionIdFor(accountId);
    harness.domain.resolveHandoff(sessionId, conversationId);
    const inspection = harness.domain.inspect(sessionId, conversationId);
    expect(inspection.resumeEligible).toBe(true);
    expect(inspection.resumeBlockedReason).toBeNull();
    expect(inspection.latestEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(inspection)).not.toMatch(/password|secret|token.*[a-f0-9]{32}/i);

    const release = harness.domain.acquireTurn(conversationId, accountId, "shop");
    const busy = harness.domain.inspect(sessionId, conversationId);
    expect(busy.resumeEligible).toBe(false);
    expect(busy.resumeBlockedReason).toBe("EXECUTION_IN_PROGRESS");
    release.release();
  });
});
