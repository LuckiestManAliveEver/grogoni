import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresBusinessTaskStepStore } from "./business-task-step-store.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("durable business task step claims", () => {
  const schema = `task_steps_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const authorize = ({ sessionId }: { sessionId: string | null }) => {
    if (!sessionId || sessionId === "denied") throw new Error("unauthorized");
    return { userId: sessionId };
  };
  const store = createPostgresBusinessTaskStepStore(pool, authorize);
  const actor = { sessionId: "actor", businessId: "business" };
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const name of ["113_business_tasks.sql", "114_business_task_steps.sql"]) {
      await pool.query(
        await readFile(
          new URL(`../../../../../../infra/db/migrations/${name}`, import.meta.url),
          "utf8"
        )
      );
    }
  });
  beforeEach(async () => {
    await pool.query("truncate business_environment_task_steps,business_environment_tasks");
    const task = {
      id: "task",
      businessId: "business",
      actorId: "actor",
      environmentId: "test",
      environmentVersion: "1.0.0",
      plan: [
        { id: "observe", capability: "products.list", dependencies: [] },
        { id: "dependent", capability: "products.list", dependencies: ["observe"] }
      ]
    };
    await pool.query(
      `insert into business_environment_tasks
      (business_id,task_id,actor_id,environment_id,environment_version,task)
      values ('business','task','actor','test','1.0.0',$1::jsonb)`,
      [JSON.stringify(task)]
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  it("allows one concurrent claim and retains it across repository recreation", async () => {
    const attempts = await Promise.allSettled([
      store.claim(actor, "task", "observe"),
      store.claim(actor, "task", "observe")
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const fresh = createPostgresBusinessTaskStepStore(pool, authorize);
    expect(await fresh.list(actor, "task")).toHaveLength(1);
    await expect(fresh.claim(actor, "task", "observe")).rejects.toMatchObject({
      code: "business_task_step_already_started"
    });
  });
  it("requires the exact claim and writes a result only once", async () => {
    const claim = await store.claim(actor, "task", "observe");
    const result = {
      status: "VERIFYING" as const,
      runtimeTurnId: "turn",
      observation: { source: "runtime" }
    };
    await expect(
      store.record(actor, "task", "observe", randomUUID(), result)
    ).rejects.toMatchObject({ code: "business_task_step_claim_conflict" });
    expect(await store.record(actor, "task", "observe", claim.claim_id, result)).toMatchObject({
      status: "VERIFYING",
      runtime_turn_id: "turn"
    });
    await expect(
      store.record(actor, "task", "observe", claim.claim_id, result)
    ).rejects.toMatchObject({ code: "business_task_step_claim_conflict" });
    await expect(store.claim(actor, "task", "observe")).rejects.toMatchObject({
      code: "business_task_step_already_started"
    });
  });
  it("does not confuse returned output with verified dependencies", async () => {
    await expect(store.claim(actor, "task", "dependent")).rejects.toMatchObject({
      code: "business_task_dependencies_unverified"
    });
  });
  it("isolates claims and observations by authenticated actor and business", async () => {
    await store.claim(actor, "task", "observe");
    for (const other of [
      { ...actor, sessionId: "other" },
      { ...actor, businessId: "other" }
    ]) {
      await expect(store.list(other, "task")).rejects.toMatchObject({
        code: "business_task_not_found"
      });
      await expect(store.claim(other, "task", "observe")).rejects.toMatchObject({
        code: "business_task_not_found"
      });
    }
    await expect(store.claim({ ...actor, sessionId: "denied" }, "task", "observe")).rejects.toThrow(
      "unauthorized"
    );
  });
});
