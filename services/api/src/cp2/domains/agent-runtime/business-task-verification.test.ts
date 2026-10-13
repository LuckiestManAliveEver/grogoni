import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresBusinessTaskStore } from "./business-task-store.js";
import { createPostgresBusinessTaskStepStore } from "./business-task-step-store.js";
import { createPostgresBusinessTaskVerifier } from "./business-task-verification.js";
import { createPostgresBusinessEnvironmentStore } from "./business-environment-store.js";
import { stableUuid } from "./shared.js";
import type { BusinessEnvironmentManifest } from "@grogoni/tool-core";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("independent committed inventory verification", () => {
  const schema = `verify_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const actor = { sessionId: "actor", businessId: "business" };
  const authorize = ({ sessionId }: { sessionId: string | null }) => {
    if (!sessionId || sessionId === "denied") throw new Error("unauthorized");
    return { userId: sessionId };
  };
  const tasks = createPostgresBusinessTaskStore(pool, authorize);
  const steps = createPostgresBusinessTaskStepStore(pool, authorize);
  const verifier = createPostgresBusinessTaskVerifier(pool, authorize);
  const manifest: BusinessEnvironmentManifest = {
    id: "grogoni.retail.inventory",
    version: "1.0.0",
    name: "Inventory",
    description: "Fixture",
    domain: "retail",
    capabilities: ["products.list"],
    observationSchema: {},
    verificationPolicyId: "grogoni.inventory.read.v1",
    evaluationPolicyId: "test.evaluate",
    executionMode: "READ_ONLY",
    status: "ACTIVE"
  };
  const product = { id: "product", businessId: "business", name: "Sugar", quantity: 10 };
  const request = { ...actor, taskId: "task", stepId: "observe" };
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
    await pool.query(
      "create table cp2_products (entity_id text primary key,business_id text,record jsonb not null)"
    );
    await pool.query(
      "create table cp2_runtime_turns (entity_id text primary key,business_id text,record jsonb not null)"
    );
  });
  beforeEach(async () => {
    await pool.query(
      "truncate business_environment_instances,business_environment_task_verifications,business_environment_task_steps,business_environment_tasks,cp2_products,cp2_runtime_turns"
    );
    const task = await tasks.create(actor, manifest, {
      taskId: "task",
      objective: "Inspect inventory",
      executionMode: "READ_ONLY",
      constraints: { budgetMinor: null, currency: null, horizonDays: null },
      steps: [
        {
          id: "observe",
          capability: "products.list",
          input: {},
          dependencies: [],
          expectedOutput: "Inventory"
        }
      ]
    });
    const environments = createPostgresBusinessEnvironmentStore(pool, authorize, () => ({
      agentId: "agent",
      runtimeInstanceId: "runtime",
      runtimeSessionId: "session"
    }));
    await environments.create(actor, task.id);
    await environments.transition(actor, task.id, 0, "READY");
    await environments.transition(actor, task.id, 1, "RUNNING");
    const claim = await steps.claim(actor, task.id, "observe", 2);
    await steps.record(actor, task.id, "observe", claim.claim_id, {
      status: "VERIFYING",
      runtimeTurnId: "turn",
      observation: {}
    });
    await pool.query("insert into cp2_products values ('product','business',$1::jsonb)", [
      JSON.stringify(product)
    ]);
    const turn = {
      id: "turn",
      sessionId: "session",
      businessId: "business",
      actorId: "actor",
      status: "completed",
      verification: { ok: true },
      plan: { id: stableUuid(task.plan[0]!.idempotencyKey), toolName: "products.list", input: {} },
      toolResult: [product]
    };
    await pool.query("insert into cp2_runtime_turns values ('turn','business',$1::jsonb)", [
      JSON.stringify(turn)
    ]);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  it("independently checks all six categories and durably deduplicates identical evidence", async () => {
    const first = await verifier.verify(request);
    expect(first.status).toBe("PASSED");
    expect(first.checks).toHaveLength(6);
    expect(
      first.checks.every((check) => check.status === "PASSED" && check.evidenceRefs.length > 0)
    ).toBe(true);
    expect(await createPostgresBusinessTaskVerifier(pool, authorize).verify(request)).toEqual(
      first
    );
    expect(
      (await pool.query("select count(*)::int as n from business_environment_task_verifications"))
        .rows[0].n
    ).toBe(1);
  });
  it("does not accept runtime success or model prose when authoritative inventory differs", async () => {
    await pool.query("update cp2_products set record=jsonb_set(record,'{quantity}','9')");
    const report = await verifier.verify(request);
    expect(report.status).toBe("INCONCLUSIVE");
    expect(report.checks.find((check) => check.category === "OUTCOME")?.status).toBe(
      "INCONCLUSIVE"
    );
  });
  it("orders a fresh recheck after changed-state evidence even when the original report is reused", async () => {
    const original = await verifier.verify(request);
    await pool.query("update cp2_products set record=jsonb_set(record,'{quantity}','9')");
    expect((await verifier.verify(request)).status).toBe("INCONCLUSIVE");
    await pool.query("update cp2_products set record=jsonb_set(record,'{quantity}','10')");
    expect(await verifier.verify(request)).toEqual(original);
    const latest = await pool.query(
      "select status from business_environment_task_verifications order by evidence_sequence desc limit 1"
    );
    expect(latest.rows[0].status).toBe("PASSED");
  });
  it("fails forged action identity and missing durable turns", async () => {
    await pool.query(
      "update cp2_runtime_turns set record=jsonb_set(record,'{plan,id}','\"forged\"')"
    );
    expect((await verifier.verify(request)).status).toBe("FAILED");
    await pool.query("delete from cp2_runtime_turns");
    expect((await verifier.verify(request)).status).toBe("FAILED");
  });
  it("rejects a completed turn from a runtime session other than the pinned instance", async () => {
    await pool.query(
      "update cp2_runtime_turns set record=jsonb_set(record,'{sessionId}','\"other-session\"')"
    );
    expect((await verifier.verify(request)).status).toBe("FAILED");
  });
  it("does not bless an unimplemented verification policy", async () => {
    await pool.query(
      "update business_environment_tasks set task=jsonb_set(task,'{plan,0,verificationPolicyId}','\"invented.policy\"')"
    );
    expect((await verifier.verify(request)).status).toBe("INCONCLUSIVE");
  });
  it("isolates actor and business reads and rechecks authorization before evidence access", async () => {
    for (const other of [
      { ...request, sessionId: "other" },
      { ...request, businessId: "other" }
    ]) {
      await expect(verifier.verify(other)).rejects.toMatchObject({
        code: "business_task_step_not_found"
      });
    }
    await expect(verifier.verify({ ...request, sessionId: "denied" })).rejects.toThrow(
      "unauthorized"
    );
  });
  it("cannot report success before the verification transaction commits", async () => {
    await pool.query(
      "alter table business_environment_task_verifications add constraint reject_report_test check (false) not valid"
    );
    try {
      await expect(verifier.verify(request)).rejects.toThrow();
      expect(
        (await pool.query("select count(*)::int as n from business_environment_task_verifications"))
          .rows[0].n
      ).toBe(0);
    } finally {
      await pool.query(
        "alter table business_environment_task_verifications drop constraint reject_report_test"
      );
    }
  });
  it("cannot add verification after the environment becomes terminal", async () => {
    const environments = createPostgresBusinessEnvironmentStore(pool, authorize, () => ({
      agentId: "agent",
      runtimeInstanceId: "runtime",
      runtimeSessionId: "session"
    }));
    await environments.transition(actor, "task", 2, "CANCELLED");
    await expect(verifier.verify(request)).rejects.toMatchObject({
      code: "business_environment_not_verifiable"
    });
    expect(
      (await pool.query("select count(*)::int as n from business_environment_task_verifications"))
        .rows[0].n
    ).toBe(0);
  });
});
