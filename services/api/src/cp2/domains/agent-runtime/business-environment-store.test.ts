import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresBusinessEnvironmentStore } from "./business-environment-store.js";
import type { EnvironmentVerificationCategory } from "@grogoni/tool-core";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("durable environment lifecycle", () => {
  const schema = `environment_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const actor = { sessionId: "actor", businessId: "business" };
  const now = new Date("2026-10-01T00:00:00Z");
  let denied = false;
  let binding = { agentId: "agent", runtimeInstanceId: "runtime", runtimeSessionId: "session" };
  const authorize = ({
    sessionId,
    permission
  }: {
    sessionId: string | null;
    permission: string;
  }) => {
    if (!sessionId || (denied && permission === "product:read")) throw new Error("unauthorized");
    return { userId: sessionId };
  };
  const store = createPostgresBusinessEnvironmentStore(pool, authorize, () => binding);
  const checks = (
    [
      "STRUCTURAL",
      "AUTHORIZATION",
      "CONSTRAINT",
      "EXECUTION",
      "PERSISTENCE",
      "OUTCOME"
    ] as EnvironmentVerificationCategory[]
  ).map((category) => ({
    category,
    status: "PASSED",
    evidenceRefs: ["state:committed"],
    reason: "fixture"
  }));
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const name of [
      "113_business_tasks.sql",
      "114_business_task_steps.sql",
      "117_business_task_verifications.sql",
      "118_task_verification_sequence.sql",
      "119_business_environment_instances.sql"
    ]) {
      await pool.query(
        await readFile(
          new URL(`../../../../../../infra/db/migrations/${name}`, import.meta.url),
          "utf8"
        )
      );
    }
  });
  beforeEach(async () => {
    denied = false;
    binding = { agentId: "agent", runtimeInstanceId: "runtime", runtimeSessionId: "session" };
    await pool.query(
      "truncate business_environment_instances,business_environment_task_verifications,business_environment_task_steps,business_environment_tasks"
    );
    const task = {
      id: "task",
      businessId: "business",
      actorId: "actor",
      environmentId: "inventory",
      environmentVersion: "1.0.0",
      executionMode: "READ_ONLY",
      plan: [
        { id: "observe", capability: "products.list", verificationPolicyId: "inventory.read.v1" }
      ]
    };
    await pool.query(
      `insert into business_environment_tasks (business_id,task_id,actor_id,environment_id,environment_version,task)
      values ('business','task','actor','inventory','1.0.0',$1::jsonb)`,
      [JSON.stringify(task)]
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  async function running() {
    await store.create(actor, "task", now);
    await store.transition(actor, "task", 0, "READY", now);
    return store.transition(actor, "task", 1, "RUNNING", now);
  }
  async function verified() {
    await pool.query(
      `insert into business_environment_task_steps (business_id,task_id,step_id,actor_id,claim_id,status,runtime_turn_id)
      values ('business','task','observe','actor',$1,'VERIFYING','turn')`,
      [randomUUID()]
    );
    const report = {
      id: randomUUID(),
      businessId: "business",
      taskId: "task",
      stepId: "observe",
      actorId: "actor",
      runtimeTurnId: "turn",
      stateVersion: "state",
      policyId: "inventory.read.v1",
      status: "PASSED",
      checks
    };
    await pool.query(
      `insert into business_environment_task_verifications (id,business_id,task_id,step_id,actor_id,runtime_turn_id,state_version,status,report)
      values ($1,'business','task','observe','actor','turn','state','PASSED',$2::jsonb)`,
      [report.id, JSON.stringify(report)]
    );
  }
  it("persists pinned identity and returns the same instance after recreation", async () => {
    const first = await store.create(actor, "task", now);
    expect(first.instance).toMatchObject({
      status: "CREATED",
      environmentVersion: "1.0.0",
      ...binding
    });
    expect(
      await createPostgresBusinessEnvironmentStore(pool, authorize, () => binding).create(
        actor,
        "task",
        now
      )
    ).toEqual(first);
    expect(await store.get(actor, "task")).toEqual(first);
    expect(await store.get({ ...actor, sessionId: "other" }, "task")).toBeNull();
    expect(await store.get({ ...actor, businessId: "other" }, "task")).toBeNull();
  });
  it("serializes competing revisions and rejects stale controllers", async () => {
    await store.create(actor, "task", now);
    const attempts = await Promise.allSettled([
      store.transition(actor, "task", 0, "READY", now),
      store.transition(actor, "task", 0, "READY", now)
    ]);
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    await expect(store.transition(actor, "task", 0, "RUNNING", now)).rejects.toMatchObject({
      code: "business_environment_conflict"
    });
  });
  it("resumes only the suspended state and forbids reopening a terminal task", async () => {
    await running();
    await store.transition(actor, "task", 2, "SUSPENDED", now);
    await expect(store.transition(actor, "task", 3, "READY", now)).rejects.toThrow("resume");
    await store.transition(actor, "task", 3, "RUNNING", now);
    await store.transition(actor, "task", 4, "CANCELLED", now);
    await expect(store.transition(actor, "task", 5, "RUNNING", now)).rejects.toThrow("transition");
  });
  it("rechecks current capability permission and runtime binding before running", async () => {
    await store.create(actor, "task", now);
    await store.transition(actor, "task", 0, "READY", now);
    denied = true;
    await expect(store.transition(actor, "task", 1, "RUNNING", now)).rejects.toThrow(
      "unauthorized"
    );
    denied = false;
    binding.runtimeSessionId = "different";
    await expect(store.transition(actor, "task", 1, "RUNNING", now)).rejects.toThrow("binding");
  });
  it("does not accept model success or incomplete evidence for completion", async () => {
    await running();
    await store.transition(actor, "task", 2, "VERIFYING", now);
    await expect(store.transition(actor, "task", 3, "COMPLETED", now)).rejects.toThrow(
      "Every planned step"
    );
    await verified();
    await pool.query(
      "update business_environment_task_verifications set report=jsonb_set(report,'{checks}','[]')"
    );
    await expect(store.transition(actor, "task", 3, "COMPLETED", now)).rejects.toThrow(
      "verified, durable"
    );
  });
  it("completes only after all native report categories pass and the lifecycle write commits", async () => {
    await running();
    await verified();
    await store.transition(actor, "task", 2, "VERIFYING", now);
    const result = await store.transition(actor, "task", 3, "COMPLETED", now);
    expect(result.instance.status).toBe("COMPLETED");
    expect(result.revision).toBe(4);
    const saved = (await pool.query("select completion from business_environment_instances"))
      .rows[0].completion;
    expect(saved).toMatchObject({
      durability: "COMMITTED",
      taskId: "task",
      environmentInstanceId: result.instance.id
    });
    expect(saved.checks).toHaveLength(6);
  });
  it("blocks expired execution and isolates lifecycle changes by actor and business", async () => {
    await store.create(actor, "task", now);
    await store.transition(actor, "task", 0, "READY", now);
    for (const other of [
      { ...actor, sessionId: "other" },
      { ...actor, businessId: "other" }
    ]) {
      await expect(store.transition(other, "task", 1, "RUNNING", now)).rejects.toMatchObject({
        code: "business_environment_not_found"
      });
    }
    const later = new Date(now.getTime() + 24 * 60 * 60_000);
    await expect(store.transition(actor, "task", 1, "RUNNING", later)).rejects.toThrow("expired");
    expect((await store.transition(actor, "task", 1, "EXPIRED", later)).instance.status).toBe(
      "EXPIRED"
    );
  });
  it("does not report completion when its authoritative write fails", async () => {
    await running();
    await verified();
    await store.transition(actor, "task", 2, "VERIFYING", now);
    await pool.query(
      "alter table business_environment_instances add constraint reject_completion_test check (instance->>'status'<>'COMPLETED') not valid"
    );
    try {
      await expect(store.transition(actor, "task", 3, "COMPLETED", now)).rejects.toThrow();
      const row = (
        await pool.query("select instance,revision,completion from business_environment_instances")
      ).rows[0];
      expect(row.instance.status).toBe("VERIFYING");
      expect(row.revision).toBe(3);
      expect(row.completion).toBeNull();
    } finally {
      await pool.query(
        "alter table business_environment_instances drop constraint reject_completion_test"
      );
    }
  });
  it("rechecks completion authorization and rejects a mismatched verification policy", async () => {
    await running();
    await verified();
    await store.transition(actor, "task", 2, "VERIFYING", now);
    denied = true;
    await expect(store.transition(actor, "task", 3, "COMPLETED", now)).rejects.toThrow(
      "unauthorized"
    );
    denied = false;
    await pool.query(
      "update business_environment_task_verifications set report=jsonb_set(report,'{policyId}','\"other\"')"
    );
    await expect(store.transition(actor, "task", 3, "COMPLETED", now)).rejects.toThrow(
      "mismatched"
    );
  });
});
