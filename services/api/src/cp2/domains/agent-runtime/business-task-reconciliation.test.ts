import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresBusinessTaskReconciler } from "./business-task-reconciliation.js";
import { stableUuid } from "./shared.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("committed business task reconciliation", () => {
  const schema = `task_recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const actor = { sessionId: "owner", businessId: "business" };
  const authorize = ({ sessionId }: { sessionId: string | null }) => {
    if (!sessionId) throw new Error("unauthorized");
    return { userId: sessionId };
  };
  const recovery = createPostgresBusinessTaskReconciler(pool, authorize);
  const actionId = stableUuid("task:observe");
  function turn(overrides: Record<string, unknown> = {}) {
    return {
      id: "turn",
      businessId: "business",
      actorId: "owner",
      sessionId: "runtime",
      plan: { id: actionId, toolName: "products.list", input: {} },
      status: "completed",
      verification: { ok: true, roleAllowed: true, confirmationSatisfied: false },
      ...overrides
    };
  }
  async function saveTurn(record = turn()) {
    await pool.query("insert into cp2_runtime_turns values($1,$2,$3::jsonb)", [
      record.id,
      "business",
      JSON.stringify(record)
    ]);
  }
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const name of [
      "113_business_tasks.sql",
      "114_business_task_steps.sql",
      "115_runtime_approvals.sql",
      "119_business_environment_instances.sql"
    ])
      await pool.query(
        await readFile(
          new URL(`../../../../../../infra/db/migrations/${name}`, import.meta.url),
          "utf8"
        )
      );
    await pool.query(
      "create table cp2_runtime_turns(entity_id text primary key,business_id text not null,record jsonb not null)"
    );
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query(
      "truncate cp2_runtime_turns,business_runtime_approvals,business_environment_instances,business_environment_task_steps,business_environment_tasks"
    );
    await pool.query(
      `insert into business_environment_tasks(business_id,task_id,actor_id,environment_id,environment_version,task)
      values('business','task','owner','inventory','1.0.0',$1::jsonb)`,
      [
        JSON.stringify({
          id: "task",
          actorId: "owner",
          businessId: "business",
          environmentId: "inventory",
          environmentVersion: "1.0.0",
          plan: [
            {
              id: "observe",
              capability: "products.list",
              input: {},
              idempotencyKey: "task:observe"
            }
          ]
        })
      ]
    );
    await pool.query(`insert into business_environment_instances(business_id,task_id,actor_id,instance,expires_at)
      values('business','task','owner','{"businessId":"business","taskId":"task","status":"RUNNING","runtimeSessionId":"runtime"}',now()+interval '1 day')`);
    await pool.query(
      `insert into business_environment_task_steps(business_id,task_id,step_id,actor_id,claim_id,status)
      values('business','task','observe','owner',$1,'RUNNING')`,
      [randomUUID()]
    );
  });
  it.each(["RUNNING", "INCONCLUSIVE", "AWAITING_APPROVAL"])(
    "recovers %s only to independent verification and preserves the claim",
    async (status) => {
      await pool.query("update business_environment_task_steps set status=$1", [status]);
      const original = (await pool.query("select claim_id from business_environment_task_steps"))
        .rows[0];
      await saveTurn();
      const result = await recovery.reconcile(actor, "task", "observe", 0);
      expect(result).toMatchObject({
        recovered: true,
        step: {
          status: "VERIFYING",
          claim_id: original.claim_id,
          runtime_turn_id: "turn",
          observation: { verificationStatus: "NOT_VERIFIED", reconciled: true }
        }
      });
      const fresh = createPostgresBusinessTaskReconciler(pool, authorize);
      expect(await fresh.reconcile(actor, "task", "observe", 0)).toMatchObject({
        recovered: false,
        step: { status: "VERIFYING", runtime_turn_id: "turn" }
      });
    }
  );
  it.each([
    { actorId: "other" },
    { businessId: "other" },
    { sessionId: "other" },
    { status: "needs_confirmation" },
    { verification: { ok: false, roleAllowed: true } },
    { verification: { ok: true, roleAllowed: false } },
    { plan: { id: actionId, toolName: "products.list", input: { query: "other" } } },
    { plan: { id: "other", toolName: "products.list", input: {} } }
  ])("leaves mismatching evidence incomplete: %j", async (overrides) => {
    await saveTurn(turn(overrides));
    expect(await recovery.reconcile(actor, "task", "observe", 0)).toMatchObject({
      recovered: false,
      step: { status: "RUNNING", runtime_turn_id: null }
    });
  });
  it("never chooses between missing or ambiguous completed records", async () => {
    expect((await recovery.reconcile(actor, "task", "observe", 0)).recovered).toBe(false);
    await saveTurn();
    await saveTurn(turn({ id: "duplicate" }));
    expect((await recovery.reconcile(actor, "task", "observe", 0)).recovered).toBe(false);
  });
  it("requires exact, consumed approval evidence for approval-gated actions", async () => {
    const input = { id: "quote", productId: "product" };
    await pool.query(
      `update business_environment_tasks set task=jsonb_set(task,'{plan,0}', $1::jsonb)`,
      [
        JSON.stringify({
          id: "observe",
          capability: "procurement.quote.record",
          input,
          idempotencyKey: "task:observe"
        })
      ]
    );
    await saveTurn(
      turn({
        plan: { id: actionId, toolName: "procurement.quote.record", input },
        verification: { ok: true, roleAllowed: true, confirmationSatisfied: true }
      })
    );
    expect((await recovery.reconcile(actor, "task", "observe", 0)).recovered).toBe(false);
    await pool.query(
      `insert into business_runtime_approvals(token_hash,business_id,actor_id,runtime_session_id,conversation_id,intent,action,expires_at)
      values($1,'business','owner','runtime','task','unknown',$2::jsonb,now()+interval '1 hour')`,
      [
        "a".repeat(64),
        JSON.stringify({ id: actionId, toolName: "procurement.quote.record", input })
      ]
    );
    expect((await recovery.reconcile(actor, "task", "observe", 0)).recovered).toBe(false);
    await pool.query(
      "update business_runtime_approvals set status='CLAIMED',claimed_at=now(),conversation_id='other'"
    );
    expect((await recovery.reconcile(actor, "task", "observe", 0)).recovered).toBe(false);
    await pool.query("update business_runtime_approvals set conversation_id='task'");
    expect((await recovery.reconcile(actor, "task", "observe", 0)).recovered).toBe(true);
  });
  it.each(["SUSPENDED", "CANCELLED", "COMPLETED"])(
    "does not recover a %s environment",
    async (status) => {
      await saveTurn();
      await pool.query(
        "update business_environment_instances set instance=jsonb_set(instance,'{status}',to_jsonb($1::text))",
        [status]
      );
      await expect(recovery.reconcile(actor, "task", "observe", 0)).rejects.toMatchObject({
        code: "business_environment_not_recoverable"
      });
    }
  );
  it("fences stale revisions, expiry and other actors", async () => {
    await saveTurn();
    await expect(recovery.reconcile(actor, "task", "observe", 1)).rejects.toMatchObject({
      code: "business_environment_not_recoverable"
    });
    await expect(
      recovery.reconcile({ ...actor, sessionId: "other" }, "task", "observe", 0)
    ).rejects.toMatchObject({ code: "business_environment_not_recoverable" });
    await pool.query(
      "update business_environment_instances set expires_at=now()-interval '1 second'"
    );
    await expect(recovery.reconcile(actor, "task", "observe", 0)).rejects.toMatchObject({
      code: "business_environment_not_recoverable"
    });
  });
  it("does not reopen a failed step", async () => {
    await saveTurn();
    await pool.query("update business_environment_task_steps set status='FAILED'");
    expect(await recovery.reconcile(actor, "task", "observe", 0)).toMatchObject({
      recovered: false,
      step: { status: "FAILED" }
    });
  });
  it("reauthorizes the current capability before changing the journal", async () => {
    await saveTurn();
    const denied = createPostgresBusinessTaskReconciler(pool, (input) => {
      if (input.permission !== "business:read") throw new Error("capability revoked");
      return { userId: "owner" };
    });
    await expect(denied.reconcile(actor, "task", "observe", 0)).rejects.toThrow(
      "capability revoked"
    );
    expect(
      (await pool.query("select status,runtime_turn_id from business_environment_task_steps"))
        .rows[0]
    ).toEqual({ status: "RUNNING", runtime_turn_id: null });
  });
  it("serializes concurrent recovery without duplicate journal advancement", async () => {
    await saveTurn();
    const results = await Promise.all([
      recovery.reconcile(actor, "task", "observe", 0),
      recovery.reconcile(actor, "task", "observe", 0)
    ]);
    expect(results.filter((result) => result.recovered)).toHaveLength(1);
  });
});
