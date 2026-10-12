import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BusinessEnvironmentManifest } from "@grogoni/tool-core";
import { createPostgresBusinessTaskStore } from "./business-task-store.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL business task contracts", () => {
  const schema = `business_tasks_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const permissions: string[] = [];
  const store = createPostgresBusinessTaskStore(pool, ({ sessionId, permission }) => {
    if (sessionId === null || sessionId === "denied") throw new Error("not authorized");
    permissions.push(permission);
    return { userId: sessionId };
  });
  const actor = { sessionId: "actor-1", businessId: "business-1" };
  const manifest: BusinessEnvironmentManifest = {
    id: "grogoni.retail.inventory",
    version: "1.0.0",
    name: "Inventory",
    description: "Test fixture",
    domain: "retail",
    capabilities: ["products.list"],
    observationSchema: { type: "object" },
    verificationPolicyId: "inventory.verify.v1",
    evaluationPolicyId: "inventory.evaluate.v1",
    executionMode: "READ_ONLY",
    status: "ACTIVE"
  };
  const proposal = () => ({
    taskId: "conversation-1",
    objective: "Inspect inventory",
    executionMode: "READ_ONLY" as const,
    constraints: { budgetMinor: null, currency: null, horizonDays: null },
    steps: [
      {
        id: "observe",
        capability: "products.list" as const,
        input: {},
        dependencies: [],
        expectedOutput: "Products"
      }
    ]
  });
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    await pool.query(
      await readFile(
        new URL("../../../../../../infra/db/migrations/113_business_tasks.sql", import.meta.url),
        "utf8"
      )
    );
  });
  beforeEach(async () => {
    permissions.length = 0;
    await pool.query("truncate business_environment_tasks");
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it("commits before returning and survives repository recreation", async () => {
    const task = await store.create(actor, manifest, proposal());
    expect(permissions).toContain("business:read");
    expect(permissions.length).toBe(2);
    const fresh = createPostgresBusinessTaskStore(pool, () => ({ userId: "actor-1" }));
    expect(await fresh.get(actor, task.id)).toEqual(task);
    expect(await fresh.list(actor)).toEqual([task]);
    expect(
      (await pool.query("select count(*)::int as n from business_environment_tasks")).rows[0].n
    ).toBe(1);
  });

  it("deduplicates concurrent identical submissions and rejects changed intent", async () => {
    const tasks = await Promise.all([
      store.create(actor, manifest, proposal()),
      store.create(actor, manifest, proposal())
    ]);
    expect(tasks[0]).toEqual(tasks[1]);
    await expect(
      store.create(actor, manifest, { ...proposal(), objective: "Different objective" })
    ).rejects.toMatchObject({ code: "business_task_conflict" });
    expect(await store.get(actor, "conversation-1")).toEqual(tasks[0]);
  });

  it("isolates business and actor reads, and rejects unauthorized writes before persistence", async () => {
    await store.create(actor, manifest, proposal());
    expect(await store.get({ ...actor, businessId: "business-2" }, "conversation-1")).toBeNull();
    expect(await store.get({ ...actor, sessionId: "actor-2" }, "conversation-1")).toBeNull();
    expect(await store.list({ ...actor, sessionId: "actor-2" })).toEqual([]);
    await expect(
      store.create({ ...actor, sessionId: "denied" }, manifest, proposal())
    ).rejects.toThrow("authorized");
    await expect(
      store.create({ ...actor, sessionId: "actor-2" }, manifest, proposal())
    ).rejects.toMatchObject({ code: "business_task_conflict" });
    expect(await store.get(actor, "conversation-1")).toMatchObject({ actorId: "actor-1" });
  });

  it("does not acknowledge success when the database write fails", async () => {
    await pool.query(
      "alter table business_environment_tasks add constraint reject_test_write check (false) not valid"
    );
    try {
      await expect(store.create(actor, manifest, proposal())).rejects.toThrow();
      expect(await store.get(actor, "conversation-1")).toBeNull();
    } finally {
      await pool.query("alter table business_environment_tasks drop constraint reject_test_write");
    }
  });
});
