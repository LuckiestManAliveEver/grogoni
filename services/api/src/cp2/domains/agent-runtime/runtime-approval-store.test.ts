import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresRuntimeApprovalStore,
  createPostgresRuntimeApprovalMaintenance
} from "./runtime-approval-store.js";
import type { PendingRuntimeAction } from "./shared.js";
import { createCp2Store } from "../../store.js";
import { buildApi } from "../../../app.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("durable exact-action runtime approvals", () => {
  const schema = `approvals_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const approvals = createPostgresRuntimeApprovalStore(pool);
  const now = new Date();
  const pending = (): PendingRuntimeAction => ({
    sessionId: "runtime-session",
    businessId: "business",
    actorId: "actor",
    conversationId: "conversation",
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    intent: "add_product",
    action: {
      id: randomUUID(),
      toolName: "product.create",
      risk: "medium",
      requiresConfirmation: true,
      status: "needs_confirmation",
      input: { name: "Sugar", unit: "kg", quantity: 10, sellingPrice: 150 },
      validationErrors: [],
      confirmationToken: "secret-token",
      executedAt: null
    }
  });
  const claim = {
    token: "secret-token",
    businessId: "business",
    actorId: "actor",
    runtimeSessionId: "runtime-session",
    conversationId: "conversation",
    now
  };
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const name of [
      "113_business_tasks.sql",
      "114_business_task_steps.sql",
      "115_runtime_approvals.sql",
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
    await pool.query(
      "truncate business_runtime_approvals,business_environment_instances,business_environment_task_verifications,business_environment_task_steps,business_environment_tasks"
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  it("stores only a token digest and preserves the exact proposed action across recreation", async () => {
    const proposal = pending();
    await approvals.put(claim.token, proposal);
    const stored = (await pool.query("select * from business_runtime_approvals")).rows[0];
    expect(JSON.stringify(stored)).not.toContain(claim.token);
    const fresh = createPostgresRuntimeApprovalStore(pool);
    expect(await fresh.claim(claim)).toMatchObject({
      intent: "add_product",
      action: { ...proposal.action, confirmationToken: null }
    });
  });
  it("binds business, actor, runtime session, conversation and expiry without consuming on mismatch", async () => {
    await approvals.put(claim.token, pending());
    for (const mismatch of [
      { businessId: "other" },
      { actorId: "other" },
      { runtimeSessionId: "other" },
      { conversationId: null },
      { now: new Date(now.getTime() + 60_000) }
    ]) {
      await expect(approvals.claim({ ...claim, ...mismatch })).rejects.toMatchObject({
        code: "runtime_confirmation_not_found"
      });
    }
    await expect(approvals.claim(claim)).resolves.toMatchObject({ businessId: "business" });
  });
  it("atomically consumes before execution and never reopens a claim after an uncertain result", async () => {
    await approvals.put(claim.token, pending());
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => approvals.claim(claim))
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    await expect(createPostgresRuntimeApprovalStore(pool).claim(claim)).rejects.toMatchObject({
      code: "runtime_confirmation_not_found"
    });
  });
  it("does not acknowledge an approval when its durable insert fails", async () => {
    await pool.query(
      "alter table business_runtime_approvals add constraint reject_approval_test check (false) not valid"
    );
    try {
      await expect(approvals.put(claim.token, pending())).rejects.toThrow();
      expect(
        (await pool.query("select count(*)::int as n from business_runtime_approvals")).rows[0].n
      ).toBe(0);
    } finally {
      await pool.query(
        "alter table business_runtime_approvals drop constraint reject_approval_test"
      );
    }
  });
  it("purges expired records after the bounded audit window and deletes only the requested ownership scope", async () => {
    await approvals.put("recent", pending());
    await approvals.put("old", {
      ...pending(),
      expiresAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000).toISOString()
    });
    await approvals.put("other", { ...pending(), actorId: "other", businessId: "other" });
    expect(await approvals.purgeExpired(now)).toBe(1);
    expect(await approvals.deleteScope(["actor"], [])).toBe(1);
    expect((await pool.query("select business_id from business_runtime_approvals")).rows).toEqual([
      { business_id: "other" }
    ]);
    expect(await approvals.deleteScope([], ["other"])).toBe(1);
  });
  it("does not allow maintenance transactions to issue or claim approvals", async () => {
    const maintenance = createPostgresRuntimeApprovalMaintenance(pool);
    await expect(maintenance.put(claim.token, pending())).rejects.toMatchObject({
      code: "runtime_approval_maintenance_only"
    });
    await approvals.put(claim.token, pending());
    await expect(maintenance.claim(claim)).rejects.toMatchObject({
      code: "runtime_approval_maintenance_only"
    });
    await expect(approvals.claim(claim)).resolves.toMatchObject({ actorId: "actor" });
  });
  async function nativeTask(businessId: string, actorId: string) {
    const taskId = `native-task-${actorId}`;
    const task = {
      id: taskId,
      businessId,
      actorId,
      environmentId: "inventory",
      environmentVersion: "1.0.0"
    };
    await pool.query(
      `insert into business_environment_tasks (business_id,task_id,actor_id,environment_id,environment_version,task)
      values ($1,$4,$2,'inventory','1.0.0',$3::jsonb)`,
      [businessId, actorId, JSON.stringify(task), taskId]
    );
    await pool.query(
      `insert into business_environment_task_steps (business_id,task_id,step_id,actor_id,claim_id,status,runtime_turn_id)
      values ($1,$4,'observe',$2,$3,'VERIFYING','turn')`,
      [businessId, actorId, randomUUID(), taskId]
    );
    await pool.query(
      `insert into business_environment_task_verifications (id,business_id,task_id,step_id,actor_id,runtime_turn_id,state_version,status,report)
      values ($1,$2,$4,'observe',$3,'turn','state','PASSED','{}')`,
      [randomUUID(), businessId, actorId, taskId]
    );
    await pool.query(
      `insert into business_environment_instances (business_id,task_id,actor_id,instance,expires_at)
      values ($1,$5,$2,$3::jsonb,$4)`,
      [
        businessId,
        actorId,
        JSON.stringify({ businessId, taskId, status: "VERIFYING" }),
        new Date(now.getTime() + 60_000),
        taskId
      ]
    );
    await approvals.put(`native-${actorId}`, { ...pending(), businessId, actorId });
  }
  it("atomically deletes the complete native task graph within actor or business scope", async () => {
    await nativeTask("business", "actor");
    await nativeTask("business", "other");
    expect(await approvals.deleteScope([], [])).toBe(0);
    expect(await approvals.deleteScope(["actor"], [])).toBe(5);
    expect((await pool.query("select actor_id from business_environment_tasks")).rows).toEqual([
      { actor_id: "other" }
    ]);
    expect(await approvals.deleteScope([], ["business"])).toBe(5);
    expect(await approvals.deleteScope(["actor"], ["business"])).toBe(0);
  });
  it("rolls back approvals and the task graph together when any native deletion fails", async () => {
    await nativeTask("business", "actor");
    await pool.query(
      "create table delete_blocker_fixture (business_id text,task_id text,foreign key (business_id,task_id) references business_environment_tasks (business_id,task_id))"
    );
    await pool.query("insert into delete_blocker_fixture values ('business','native-task-actor')");
    try {
      await expect(approvals.deleteScope(["actor"], [])).rejects.toThrow();
      for (const table of [
        "business_runtime_approvals",
        "business_environment_tasks",
        "business_environment_task_steps",
        "business_environment_task_verifications",
        "business_environment_instances"
      ]) {
        expect((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(1);
      }
    } finally {
      await pool.query("drop table delete_blocker_fixture");
    }
    expect(await approvals.deleteScope(["actor"], [])).toBe(5);
  });
  it("fences canonical confirmations while the task environment is stopped or rebound", async () => {
    await pool.query(`insert into business_environment_tasks (business_id,task_id,actor_id,environment_id,environment_version,task)
      values ('business','conversation','actor','inventory','1.0.0','{"id":"conversation","businessId":"business","actorId":"actor","environmentId":"inventory","environmentVersion":"1.0.0"}')`);
    await pool.query(
      `insert into business_environment_instances (business_id,task_id,actor_id,instance,expires_at)
      values ('business','conversation','actor','{"businessId":"business","taskId":"conversation","status":"SUSPENDED","runtimeSessionId":"runtime-session"}',$1)`,
      [new Date(now.getTime() + 60_000)]
    );
    await approvals.put(claim.token, pending());
    for (const status of ["SUSPENDED", "CANCELLED", "FAILED", "COMPLETED", "VERIFYING"]) {
      await pool.query(
        "update business_environment_instances set instance=jsonb_set(instance,'{status}',to_jsonb($1::text))",
        [status]
      );
      await expect(approvals.claim(claim)).rejects.toMatchObject({
        code: "runtime_confirmation_not_found"
      });
    }
    await pool.query(
      "update business_environment_instances set instance=jsonb_set(jsonb_set(instance,'{status}','\"AWAITING_APPROVAL\"'),'{runtimeSessionId}','\"different\"')"
    );
    await expect(approvals.claim(claim)).rejects.toMatchObject({
      code: "runtime_confirmation_not_found"
    });
    await pool.query(
      "update business_environment_instances set instance=jsonb_set(instance,'{runtimeSessionId}','\"runtime-session\"')"
    );
    await expect(approvals.claim(claim)).resolves.toMatchObject({ businessId: "business" });
  });
  it("confirms through a fresh canonical runtime using no in-memory pending action", async () => {
    const store = createCp2Store({
      runtimeApprovalStore: approvals,
      runtimeModelProvider: {
        name: "approval-test",
        async complete() {
          return {
            provider: "approval-test",
            status: "available",
            outputText: JSON.stringify({
              type: "tool",
              toolName: "product.update",
              input: { productName: "Sugar", sellingPrice: 175 },
              reason: "Create product"
            }),
            durationMs: 1,
            errorCode: null,
            metadata: {}
          };
        }
      }
    });
    const app = buildApi({ cp2: { store } });
    let freshApp: ReturnType<typeof buildApi> | undefined;
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "254700008817", pin: "1234" }
      });
      expect(signup.statusCode).toBe(200);
      const cookie = String(signup.headers["set-cookie"]).split(";")[0];
      const business = await app.inject({
        method: "POST",
        url: "/businesses",
        headers: { cookie },
        payload: { name: "Approval shop", language: "en" }
      });
      expect(business.statusCode).toBe(200);
      const businessId = business.json().business.id;
      const product = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/products`,
        headers: { cookie },
        payload: pending().action.input
      });
      expect(product.statusCode, product.body).toBe(200);
      // product.create auto-executes by default; the owner's binding makes it need approval.
      const profileUrl = `/businesses/${businessId}/agent-profile`;
      const profile = (
        await app.inject({ method: "GET", url: profileUrl, headers: { cookie } })
      ).json();
      const updated = await app.inject({
        method: "PUT",
        url: profileUrl,
        headers: { cookie },
        payload: {
          ...profile,
          skillBindings: profile.skillBindings.map((binding: { skillId: string }) =>
            binding.skillId === "product.create"
              ? { ...binding, requiredConfirmationLevel: "owner" }
              : binding
          )
        }
      });
      expect(updated.statusCode, updated.body).toBe(200);
      const proposed = await app.inject({
        method: "POST",
        url: `/businesses/${businessId}/runtime/turns`,
        headers: { cookie },
        payload: { message: "Please process this new item" }
      });
      expect(proposed.statusCode).toBe(200);
      expect(proposed.json().turn.status).toBe("needs_confirmation");
      const fresh = createCp2Store({
        runtimeApprovalStore: createPostgresRuntimeApprovalStore(pool)
      });
      fresh.hydrateSnapshot(store.snapshot());
      freshApp = buildApi({ cp2: { store: fresh } });
      const confirmed = await freshApp.inject({
        method: "POST",
        url: `/businesses/${businessId}/runtime/turns`,
        headers: { cookie },
        payload: {
          runtimeSessionId: proposed.json().session.id,
          confirmationToken: proposed.json().turn.plan.confirmationToken,
          message: "confirm"
        }
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().turn.status).toBe("completed");
      expect(confirmed.json().turn.plan.input).toEqual({ productName: "Sugar", sellingPrice: 175 });
      expect(confirmed.json().turn.toolResult).toMatchObject({ name: "Sugar" });
    } finally {
      await app.close();
      await freshApp?.close();
    }
  });
});
