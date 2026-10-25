import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createCp2Store, type Cp2Snapshot } from "../services/api/src/cp2/store";
import { edgeJobDefinitions, runEdgeJob } from "../services/api/src/edge-job-runner";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";
import { edgeBackgroundJobNames } from "../supabase/functions/api/application-routes";

const state = vi.hoisted(() => ({
  snapshot: undefined as Cp2Snapshot | undefined,
  loads: 0,
  saves: [] as { snapshot: Cp2Snapshot; previous: Cp2Snapshot }[],
  fulfillmentCalls: [] as { method: string; args: unknown[] }[],
  fulfillmentInputs: [] as Record<string, unknown>[]
}));

vi.mock("../services/api/src/cp2/postgres-store", async (original) => {
  const real = await original<Record<string, unknown>>();
  return {
    ...real,
    loadTransactionalCp2Snapshot: async () => {
      state.loads++;
      return structuredClone(state.snapshot);
    },
    saveTransactionalCp2Snapshot: async (
      _client: unknown,
      snapshot: Cp2Snapshot,
      previous: Cp2Snapshot
    ) => {
      state.saves.push({ snapshot: structuredClone(snapshot), previous });
    }
  };
});

vi.mock("../services/api/src/cp2/domains/fulfillment/service", async (original) => {
  const real = await original<Record<string, unknown>>();
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      state.fulfillmentCalls.push({ method, args });
      return result;
    };
  return {
    ...real,
    createPostgresFulfillmentService: (input: Record<string, unknown>) => {
      state.fulfillmentInputs.push(input);
      return {
        evaluateDueDispatches: record("evaluateDueDispatches", { evaluated: 0, failed: 0 }),
        purgeExpiredIdempotencyRecords: record("purgeExpiredIdempotencyRecords", 0),
        reconcileIntake: record("reconcileIntake", { takenIn: 0, orphaned: 0, failed: 0 }),
        deliverPendingOutboxEvents: record("deliverPendingOutboxEvents", {
          delivered: 0,
          failed: 0
        })
      };
    }
  };
});

function database(options: { lockAcquired?: boolean; deleted?: number } = {}) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("delete from cp2_edge_rate_limits") || sql.includes("agent_chat_turns"))
        return { rows: [], rowCount: options.deleted ?? 0 };
      return { rows: [], rowCount: 0 };
    })
  } as unknown as PoolClient;
  const transactions: { lockKey: string; storeLock: boolean }[] = [];
  return {
    queries,
    transactions,
    async jobTransaction<T>(
      input: { lockKey: string; storeLock: boolean },
      action: (client: PoolClient) => Promise<T>
    ) {
      transactions.push(input);
      if (options.lockAcquired === false) return { acquired: false as const };
      return { acquired: true as const, result: await action(client) };
    }
  };
}

const storePrototype = Object.getPrototypeOf(createCp2Store()) as Record<string, unknown>;
const now = new Date("2026-10-09T12:00:00.000Z");

beforeEach(() => {
  vi.restoreAllMocks();
  state.snapshot = createCp2Store().snapshot();
  state.loads = 0;
  state.saves = [];
  state.fulfillmentCalls = [];
  state.fulfillmentInputs = [];
});

describe("Edge background job runner", () => {
  it("defines exactly the jobs the Edge endpoint accepts", () => {
    expect(new Set(Object.keys(edgeJobDefinitions))).toEqual(new Set(edgeBackgroundJobNames));
  });

  it.each([
    ["notification_delivery", "deliverPendingMessageNotifications", [{ limit: 25 }]],
    ["connected_mailbox_sync", "syncDueConnectedMailboxes", [{ staleAfterMs: 300_000 }]],
    ["conversation_recycle_bin_purge", "purgeExpiredRecycleBinConversations", [now]],
    ["agent_owner_correction_retention", "purgeExpiredAgentOwnerCorrections", [now]],
    ["runtime_experience_retention", "purgeExpiredRuntimeExperiences", [now]],
    ["grogoniid_cooldown", "releaseExpiredGrogoniIds", [{ cooldownMs: 30 * 24 * 60 * 60_000 }]]
  ] as const)("%s calls the same store method as its Node runner", async (job, method, args) => {
    const spy = vi.spyOn(storePrototype as never, method as never).mockReturnValue(0 as never);
    const outcome = await runEdgeJob(database(), job, { environment: {}, now: () => now });
    expect(outcome.status).toBe("completed");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(...args);
    expect(state.loads).toBe(1);
    expect(state.saves).toHaveLength(1);
  });

  it.each([
    ["fulfillment_dispatch_evaluation", "evaluateDueDispatches"],
    ["fulfillment_idempotency_retention", "purgeExpiredIdempotencyRecords"],
    ["fulfillment_intake_reconcile", "reconcileIntake"],
    ["fulfillment_outbox_delivery", "deliverPendingOutboxEvents"]
  ] as const)("%s calls FulfillmentService.%s", async (job, method) => {
    const outcome = await runEdgeJob(database(), job, { environment: {} });
    expect(outcome.status).toBe("completed");
    expect(state.fulfillmentCalls.map((call) => call.method)).toEqual([method]);
  });

  it("fails the domain's startup, not each request, on an invalid fulfillment retention", async () => {
    const previous = process.env.FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS;
    process.env.FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS = "forever";
    try {
      await expect(
        createEdgeDomainRoutes({ transaction: (action) => action({} as PoolClient) })
      ).rejects.toThrow("FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS must be a positive integer.");
    } finally {
      if (previous === undefined) delete process.env.FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS;
      else process.env.FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS = previous;
    }
  });

  it("rejects an invalid fulfillment retention like the Node API instead of defaulting", async () => {
    await expect(
      runEdgeJob(database(), "fulfillment_outbox_delivery", {
        environment: { FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS: "forever" }
      })
    ).rejects.toThrow("FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS must be a positive integer.");
  });

  it("builds the fulfillment service like Node: outbox events reach the store's notifier", async () => {
    const notify = vi
      .spyOn(storePrototype as never, "deliverFulfillmentNotification" as never)
      .mockResolvedValue(undefined as never);
    await runEdgeJob(database(), "fulfillment_outbox_delivery", {
      environment: { FULFILLMENT_IDEMPOTENCY_RETENTION_HOURS: "48" }
    });
    const input = state.fulfillmentInputs[0]!;
    expect(input.idempotencyRetentionHours).toBe(48);
    const event = { id: "event-1", eventType: "delivery.completed" };
    await (input.deliverOutboxEvent as (event: unknown) => Promise<void>)(event);
    expect(notify).toHaveBeenCalledWith(event);
  });

  it("saves what the job changed, diffed against the loaded snapshot", async () => {
    vi.spyOn(storePrototype as never, "releaseExpiredGrogoniIds" as never).mockReturnValue(
      7 as never
    );
    const outcome = await runEdgeJob(database(), "grogoniid_cooldown", { environment: {} });
    expect(outcome.result).toEqual({ released: 7 });
    expect(state.saves[0]?.previous).toEqual(state.snapshot);
  });

  it("purges account deletions only when explicitly enabled, like the Node runner", async () => {
    const shops = vi
      .spyOn(storePrototype as never, "purgeExpiredShopDeletions" as never)
      .mockReturnValue(0 as never);
    vi.spyOn(storePrototype as never, "purgeExpiredAccountDeletions" as never).mockResolvedValue(
      [] as never
    );
    const db = database();

    const disabled = await runEdgeJob(db, "account_deletion_purge", { environment: {} });
    expect(disabled.status).toBe("disabled");
    expect(db.transactions).toHaveLength(0);
    expect(shops).not.toHaveBeenCalled();

    const enabled = await runEdgeJob(db, "account_deletion_purge", {
      environment: { ENABLE_ACCOUNT_DELETION_RUNNER: "true" },
      now: () => now
    });
    expect(enabled.status).toBe("completed");
    expect(shops).toHaveBeenCalledWith(now);
  });

  it("rejects a mailbox sync interval under a minute, like the Node runner", async () => {
    const spy = vi.spyOn(storePrototype as never, "syncDueConnectedMailboxes" as never);
    await expect(
      runEdgeJob(database(), "connected_mailbox_sync", {
        environment: { CONNECTED_MAILBOX_SYNC_INTERVAL_MS: "5000" }
      })
    ).rejects.toThrow("at least 60000 milliseconds");
    expect(spy).not.toHaveBeenCalled();
  });

  it("honors the Node runners' ENABLE_*=false switches", async () => {
    const spy = vi.spyOn(storePrototype as never, "deliverPendingMessageNotifications" as never);
    const outcome = await runEdgeJob(database(), "notification_delivery", {
      environment: { ENABLE_NOTIFICATION_DELIVERY_RUNNER: "false" }
    });
    expect(outcome.status).toBe("disabled");
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips instead of running twice when the previous run still holds the job lock", async () => {
    const spy = vi.spyOn(storePrototype as never, "deliverPendingMessageNotifications" as never);
    const outcome = await runEdgeJob(database({ lockAcquired: false }), "notification_delivery", {
      environment: {}
    });
    expect(outcome).toMatchObject({ status: "skipped", reason: "already_running" });
    expect(spy).not.toHaveBeenCalled();
    expect(state.loads).toBe(0);
    expect(state.saves).toHaveLength(0);
  });

  it("purges expired rate-limit windows without loading the domain store", async () => {
    const db = database({ deleted: 12 });
    const outcome = await runEdgeJob(db, "edge_rate_limit_retention", { environment: {} });
    expect(outcome.result).toEqual({ purged: 12 });
    expect(state.loads).toBe(0);
    expect(state.saves).toHaveLength(0);
    expect(db.queries.some((sql) => sql.startsWith("delete from cp2_edge_rate_limits"))).toBe(true);
    expect(db.transactions).toEqual([
      { lockKey: "edge:job:edge_rate_limit_retention", storeLock: false }
    ]);
  });

  it("fails abandoned agent turns and purges finished ones without loading the domain store", async () => {
    const db = database({ deleted: 3 });
    const outcome = await runEdgeJob(db, "agent_turn_recovery", { environment: {} });
    expect(outcome).toMatchObject({ status: "completed", result: { failed: 3, purged: 3 } });
    expect(state.loads).toBe(0);
    expect(state.saves).toHaveLength(0);
    expect(
      db.queries.some((sql) => sql.includes("update agent_chat_turns set status = 'failed'"))
    ).toBe(true);
    expect(db.queries.some((sql) => sql.includes("delete from agent_chat_turns"))).toBe(true);
    expect(db.transactions).toEqual([
      { lockKey: "edge:job:agent_turn_recovery", storeLock: false }
    ]);
  });

  it("rejects an unknown job", async () => {
    await expect(runEdgeJob(database(), "drop_everything", { environment: {} })).rejects.toThrow(
      "Unknown background job"
    );
  });
});
