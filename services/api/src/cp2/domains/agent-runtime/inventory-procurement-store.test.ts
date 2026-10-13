import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresInventoryProcurementStore,
  type SupplierQuoteInput
} from "./inventory-procurement-store.js";
import { createPostgresBusinessTaskStore } from "./business-task-store.js";
import { createPostgresBusinessEnvironmentStore } from "./business-environment-store.js";
import { createPostgresBusinessTaskStepStore } from "./business-task-step-store.js";
import { stableUuid } from "./shared.js";
import { createBusinessTaskEvaluationReader } from "./business-task-evaluation-reader.js";
import { recordVerifiedTaskExperience } from "./task-experience.js";
import type { RuntimeExperience } from "@grogoni/shared-types";
import { deleteNativeRuntimeScope } from "./native-runtime-maintenance.js";
import { createPostgresBusinessTaskVerifier } from "./business-task-verification.js";
import { compileBusinessTask, type BusinessEnvironmentManifest } from "@grogoni/tool-core";
import { createCp2Store, readSessionCookie } from "../../store.js";
import { buildApi } from "../../../app.js";
import { executeBusinessTaskRootStep } from "./business-task-execution.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("committed inventory procurement drafts", () => {
  const schema = `procurement_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const actor = { sessionId: "actor", businessId: "business" };
  const authorize = ({ sessionId }: { sessionId: string | null }) => {
    if (!sessionId || sessionId === "denied") throw new Error("unauthorized");
    return { userId: sessionId };
  };
  const repository = createPostgresInventoryProcurementStore(pool, authorize);
  const tasks = createPostgresBusinessTaskStore(pool, authorize);
  const environments = createPostgresBusinessEnvironmentStore(pool, authorize, () => ({
    agentId: "agent",
    runtimeInstanceId: "runtime",
    runtimeSessionId: "session"
  }));
  const steps = createPostgresBusinessTaskStepStore(pool, authorize);
  const manifest: BusinessEnvironmentManifest = {
    id: "grogoni.retail.inventory",
    version: "1.0.0",
    name: "Inventory",
    description: "Fixture",
    domain: "retail",
    capabilities: ["procurement.prepare"],
    observationSchema: {},
    verificationPolicyId: "grogoni.inventory.replenishment.v1",
    evaluationPolicyId: "grogoni.inventory.outcomes.v1",
    executionMode: "LIVE",
    status: "ACTIVE"
  };
  let now: Date;
  let actionId: string;
  const quote = (
    id: string,
    productId: string,
    supplierId: string,
    unitPriceMinor: number
  ): SupplierQuoteInput => ({
    id,
    productId,
    supplierId,
    unitPriceMinor,
    priceIncludesCharges: true,
    currency: "KES",
    unit: "unit",
    minQuantityMilli: 1000,
    incrementMilli: 1000,
    availableQuantityMilli: 100_000,
    leadTimeDays: 0,
    expiresAt: new Date(now.getTime() + 86400_000).toISOString()
  });
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const name of [
      "113_business_tasks.sql",
      "114_business_task_steps.sql",
      "115_runtime_approvals.sql",
      "117_business_task_verifications.sql",
      "118_task_verification_sequence.sql",
      "119_business_environment_instances.sql",
      "120_inventory_procurement.sql"
    ]) {
      await pool.query(
        await readFile(
          new URL(`../../../../../../infra/db/migrations/${name}`, import.meta.url),
          "utf8"
        )
      );
    }
    for (const table of ["cp2_products", "cp2_invoices", "cp2_suppliers", "cp2_runtime_turns"])
      await pool.query(
        `create table ${table} (entity_id text primary key,business_id text,record jsonb not null)`
      );
  });
  beforeEach(async () => {
    now = new Date();
    await pool.query(
      "truncate business_purchase_drafts,business_supplier_quotes,business_environment_instances,business_environment_task_verifications,business_environment_task_steps,business_environment_tasks,cp2_products,cp2_invoices,cp2_suppliers,cp2_runtime_turns"
    );
    for (const product of [
      { id: "beans", quantity: 1 },
      { id: "rice", quantity: 10 }
    ])
      await pool.query("insert into cp2_products values ($1,'business',$2::jsonb)", [
        product.id,
        JSON.stringify({ ...product, unit: "unit", businessId: "business" })
      ]);
    for (const id of ["a", "b", "c"])
      await pool.query("insert into cp2_suppliers values ($1,'business',$2::jsonb)", [
        id,
        JSON.stringify({ id, businessId: "business" })
      ]);
    await pool.query("insert into cp2_invoices values ('sales','business',$1::jsonb)", [
      JSON.stringify({
        id: "sales",
        businessId: "business",
        status: "confirmed",
        confirmedAt: new Date(now.getTime() - 7 * 86400_000).toISOString(),
        items: [
          { productId: "beans", quantity: 14 },
          { productId: "rice", quantity: 35 }
        ]
      })
    ]);
    await repository.recordQuote(actor, quote("beans-expensive", "beans", "a", 30_000), now);
    await repository.recordQuote(actor, quote("beans-cheap", "beans", "b", 20_000), now);
    await repository.recordQuote(actor, quote("rice", "rice", "c", 100_000), now);
    const task = await tasks.create(actor, manifest, {
      taskId: "task",
      objective: "Prepare replenishment orders within KES 15,000 for three days",
      executionMode: "LIVE",
      constraints: { budgetMinor: 1_500_000, currency: "KES", horizonDays: 3 },
      steps: [
        {
          id: "prepare",
          capability: "procurement.prepare",
          input: { taskId: "task" },
          dependencies: [],
          expectedOutput: "Purchase drafts, not submitted orders"
        }
      ]
    });
    actionId = stableUuid(task.plan[0]!.idempotencyKey);
    await environments.create(actor, "task");
    await environments.transition(actor, "task", 0, "READY");
    await environments.transition(actor, "task", 1, "RUNNING");
    await steps.claim(actor, "task", "prepare", 2);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  it("uses committed sales, inventory and quotes to prepare KES 6,000 of drafts within KES 15,000", async () => {
    const result = await repository.prepare(actor, "task", actionId, now);
    expect(result.recommendation).toMatchObject({ status: "READY", totalMinor: 600_000 });
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.map((draft) => draft.supplierId)).toEqual(["b", "c"]);
    expect(
      result.drafts.every(
        (draft) =>
          draft.status === "DRAFT" &&
          draft.submissionStatus === "NOT_SUBMITTED" &&
          draft.requiresSubmissionApproval
      )
    ).toBe(true);
    expect(result.recommendation.items.map((item) => item.quantityMilli)).toEqual([5000, 5000]);
    expect(
      (await pool.query("select sum(total_minor)::int as total from business_purchase_drafts"))
        .rows[0].total
    ).toBe(600_000);
    expect(
      (
        await pool.query(
          "select record->>'quantity' as quantity from cp2_products order by entity_id"
        )
      ).rows.map((row) => row.quantity)
    ).toEqual(["1", "10"]);
  });
  it("is idempotent across concurrent calls and repository recreation", async () => {
    const results = await Promise.all([
      repository.prepare(actor, "task", actionId, now),
      repository.prepare(actor, "task", actionId, now)
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await createPostgresInventoryProcurementStore(pool, authorize).prepare(
        actor,
        "task",
        actionId,
        now
      )
    ).toEqual(results[0]);
    expect(
      (await pool.query("select count(*)::int as n from business_purchase_drafts")).rows[0].n
    ).toBe(2);
  });
  it("reports missing demand and suppliers without fabricating purchase drafts", async () => {
    await pool.query("delete from cp2_invoices");
    expect(await repository.prepare(actor, "task", actionId, now)).toMatchObject({
      recommendation: {
        status: "BLOCKED",
        issues: expect.arrayContaining([{ productId: "beans", code: "MISSING_DEMAND" }])
      },
      drafts: []
    });
    await pool.query("delete from cp2_suppliers");
    expect(
      (await pool.query("select count(*)::int as n from business_purchase_drafts")).rows[0].n
    ).toBe(0);
  });
  it("does not exceed a lower immutable task budget", async () => {
    await pool.query(
      "update business_environment_tasks set task=jsonb_set(task,'{constraints,budgetMinor}','100000')"
    );
    const result = await repository.prepare(actor, "task", actionId, now);
    expect(result.recommendation.status).toBe("PARTIAL");
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]!.totalMinor).toBe(100_000);
    expect(result.recommendation.issues).toContainEqual({
      productId: "rice",
      code: "BUDGET_INSUFFICIENT"
    });
  });
  it("rejects wrong actors, businesses, forged actions and stopped lifecycle state", async () => {
    for (const other of [
      { ...actor, sessionId: "other" },
      { ...actor, businessId: "other" },
      { ...actor, sessionId: "denied" }
    ])
      await expect(repository.prepare(other, "task", actionId, now)).rejects.toThrow();
    await expect(repository.prepare(actor, "task", randomUUID(), now)).rejects.toThrow(
      "exact compiled"
    );
    await environments.transition(actor, "task", 2, "SUSPENDED");
    await expect(repository.prepare(actor, "task", actionId, now)).rejects.toThrow("running");
    expect(
      (await pool.query("select count(*)::int as n from business_purchase_drafts")).rows[0].n
    ).toBe(0);
  });
  it("rolls back every draft if any authoritative write fails", async () => {
    await pool.query(
      "alter table business_purchase_drafts add constraint reject_draft_test check (supplier_id<>'c') not valid"
    );
    try {
      await expect(repository.prepare(actor, "task", actionId, now)).rejects.toThrow();
      expect(
        (await pool.query("select count(*)::int as n from business_purchase_drafts")).rows[0].n
      ).toBe(0);
    } finally {
      await pool.query("alter table business_purchase_drafts drop constraint reject_draft_test");
    }
  });
  it("keeps quotes immutable and scoped to existing products and suppliers", async () => {
    const original = quote("beans-cheap", "beans", "b", 20_000);
    expect(await repository.recordQuote(actor, original, now)).toMatchObject(original);
    await expect(
      repository.recordQuote(actor, { ...original, unitPriceMinor: 1 }, now)
    ).rejects.toThrow("different offer");
    await expect(
      repository.recordQuote(actor, quote("unknown", "beans", "missing", 10), now)
    ).rejects.toThrow("unavailable");
    await expect(
      repository.recordQuote(actor, { ...original, id: "invalid", unitPriceMinor: -1 }, now)
    ).rejects.toThrow("Invalid");
    await expect(
      repository.recordQuote(
        actor,
        JSON.parse(
          JSON.stringify({ ...original, id: "unknown-fees", priceIncludesCharges: false })
        ) as SupplierQuoteInput,
        now
      )
    ).rejects.toThrow("all charges");
  });
  it("does not silently reuse a price quote after the product quantity unit changes", async () => {
    await pool.query(
      "update cp2_products set record=jsonb_set(record,'{unit}','\"case\"') where entity_id='beans'"
    );
    const result = await repository.prepare(actor, "task", actionId, now);
    expect(result.recommendation.status).toBe("PARTIAL");
    expect(result.recommendation.issues).toContainEqual({
      productId: "beans",
      code: "NO_ELIGIBLE_SUPPLIER"
    });
    expect(
      result.drafts.every((draft) =>
        draft.items.every((item) => draft.units[item.productId] === "unit")
      )
    ).toBe(true);
  });
  it("purges draft graphs on actor deletion and anonymizes shared-business quote provenance", async () => {
    await repository.prepare(actor, "task", actionId, now);
    expect(await deleteNativeRuntimeScope(pool, ["actor"], [])).toBe(8);
    expect(
      (await pool.query("select count(*)::int as n from business_purchase_drafts")).rows[0].n
    ).toBe(0);
    expect(
      (await pool.query("select distinct created_by from business_supplier_quotes")).rows
    ).toEqual([{ created_by: "deleted-user" }]);
    expect(await deleteNativeRuntimeScope(pool, [], ["business"])).toBe(3);
  });
  async function executed() {
    const result = await repository.prepare(actor, "task", actionId, now);
    const claim = (await steps.list(actor, "task"))[0]!;
    await steps.record(actor, "task", "prepare", claim.claim_id, {
      status: "VERIFYING",
      runtimeTurnId: "turn",
      observation: {}
    });
    await pool.query("insert into cp2_runtime_turns values ('turn','business',$1::jsonb)", [
      JSON.stringify({
        id: "turn",
        sessionId: "session",
        businessId: "business",
        actorId: "actor",
        status: "completed",
        verification: { ok: true },
        createdAt: now.toISOString(),
        plan: { id: actionId, toolName: "procurement.prepare", input: { taskId: "task" } },
        toolResult: result
      })
    ]);
    return result;
  }
  const verify = () =>
    createPostgresBusinessTaskVerifier(pool, authorize).verify({
      ...actor,
      taskId: "task",
      stepId: "prepare"
    });
  it("independently verifies all six categories before durable prepared-task completion", async () => {
    await executed();
    const report = await verify();
    expect(report.status).toBe("PASSED");
    expect(report.evaluation).toMatchObject({
      executionSuccess: true,
      reward: null,
      outcomeStatus: "PENDING",
      inventory: {
        budgetCompliance: 1,
        orderAccuracy: 1,
        forecastAccuracy: null,
        stockoutReduction: null
      }
    });
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((check) => check.status === "PASSED")).toBe(true);
    const reader = createBusinessTaskEvaluationReader(pool, authorize);
    expect(await reader.completedTask!(actor, "task")).toBeNull();
    await environments.transition(actor, "task", 2, "VERIFYING");
    expect((await environments.transition(actor, "task", 3, "COMPLETED")).instance.status).toBe(
      "COMPLETED"
    );
    const proof = await reader.completedTask!(actor, "task");
    expect(proof?.report.experienceEvidence?.count).toBeGreaterThan(0);
    const experiences = new Map<string, RuntimeExperience>();
    const extracted = recordVerifiedTaskExperience(experiences, proof!, new Date());
    expect(extracted).toMatchObject({ validationState: "candidate", corroborationCount: 1 });
    expect(
      recordVerifiedTaskExperience(
        experiences,
        (await reader.completedTask!(actor, "task"))!,
        new Date()
      )
    ).toEqual(extracted);
    expect(await reader.completedTask!({ ...actor, sessionId: "other" }, "task")).toBeNull();
    expect(await reader.completedTask!({ ...actor, businessId: "other" }, "task")).toBeNull();
  });
  it("does not trust runtime success after a draft record or its quote price is changed", async () => {
    await executed();
    await pool.query("update business_purchase_drafts set total_minor=total_minor+1");
    expect((await verify()).status).toBe("FAILED");
    await pool.query("update business_purchase_drafts set total_minor=total_minor-1");
    await pool.query(
      "update business_supplier_quotes set record=jsonb_set(record,'{unitPriceMinor}','1') where quote_id='beans-cheap'"
    );
    expect((await verify()).status).toBe("FAILED");
  });
  it("does not promote partial or missing-demand preparation to completed success", async () => {
    await pool.query("delete from cp2_invoices");
    await executed();
    expect((await verify()).status).toBe("INCONCLUSIVE");
    await environments.transition(actor, "task", 2, "VERIFYING");
    await expect(environments.transition(actor, "task", 3, "COMPLETED")).rejects.toThrow(
      "uncertain"
    );
  });
  it("prepares and independently verifies drafts through the real canonical runtime", async () => {
    const runtime = createCp2Store({
      businessTaskEvaluations: createBusinessTaskEvaluationReader(pool, (input) =>
        runtime.authorizeBusinessPermission(input)
      ),
      inventoryProcurement: createPostgresInventoryProcurementStore(pool, (input) =>
        runtime.authorizeBusinessPermission(input)
      )
    });
    const app = buildApi({ cp2: { store: runtime } });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "254700009911", pin: "1234" }
      });
      expect(signup.statusCode).toBe(200);
      const cookie = String(signup.headers["set-cookie"]).split(";")[0];
      const business = await app.inject({
        method: "POST",
        url: "/businesses",
        headers: { cookie },
        payload: { name: "Fixture procurement shop", language: "en" }
      });
      expect(business.statusCode).toBe(200);
      const businessId = business.json().business.id as string;
      const actualActor = { sessionId: readSessionCookie(cookie), businessId };
      const authorizeActual = (input: Parameters<typeof runtime.authorizeBusinessPermission>[0]) =>
        runtime.authorizeBusinessPermission(input);
      const { userId } = authorizeActual({ ...actualActor, permission: "business:read" });
      const conversation = runtime.createConversation({
        ...actualActor,
        kind: "personal",
        activeShopId: businessId
      });
      const taskId = conversation.conversation.id;
      const session = runtime.createRuntimeSession({
        ...actualActor,
        idempotencyKey: `business-task:${taskId}`
      });
      const effective = await runtime.getEffectiveRuntime({
        ...actualActor,
        conversationId: taskId
      });
      const agent = runtime.getAgentRuntime(actualActor);
      const actualTasks = createPostgresBusinessTaskStore(pool, authorizeActual);
      const actualSteps = createPostgresBusinessTaskStepStore(pool, authorizeActual);
      const actualEnvironments = createPostgresBusinessEnvironmentStore(
        pool,
        authorizeActual,
        () => ({
          agentId: agent.agentId,
          runtimeInstanceId: effective.binding?.id ?? "isolated-fixture-runtime",
          runtimeSessionId: session.id
        })
      );
      for (const product of [
        { id: "actual-beans", quantity: 1 },
        { id: "actual-rice", quantity: 10 }
      ])
        await pool.query("insert into cp2_products values ($1,$2,$3::jsonb)", [
          product.id,
          businessId,
          JSON.stringify({ ...product, unit: "unit", businessId })
        ]);
      for (const id of ["actual-a", "actual-b", "actual-c"])
        await pool.query("insert into cp2_suppliers values ($1,$2,$3::jsonb)", [
          id,
          businessId,
          JSON.stringify({ id, businessId })
        ]);
      await pool.query("insert into cp2_invoices values ('actual-sales',$1,$2::jsonb)", [
        businessId,
        JSON.stringify({
          id: "actual-sales",
          businessId,
          status: "confirmed",
          confirmedAt: new Date(Date.now() - 7 * 86400_000 + 3600_000).toISOString(),
          items: [
            { productId: "actual-beans", quantity: 14 },
            { productId: "actual-rice", quantity: 35 }
          ]
        })
      ]);
      const actualProcurement = createPostgresInventoryProcurementStore(pool, authorizeActual);
      const confirmedOffer = quote("actual-expensive", "actual-beans", "actual-a", 30_000);
      const quoteTask = compileBusinessTask({
        taskId: `${taskId}-quote`,
        businessId,
        actorId: userId,
        objective: "Record the supplier offer",
        manifest: { ...manifest, capabilities: ["procurement.quote.record"] },
        authorizedCapabilities: ["procurement.quote.record"],
        executionMode: "LIVE",
        constraints: { budgetMinor: null, currency: null, horizonDays: null },
        steps: [
          {
            id: "quote",
            capability: "procurement.quote.record",
            input: { ...confirmedOffer },
            dependencies: [],
            expectedOutput: "Owner-confirmed supplier quote"
          }
        ],
        now: new Date()
      });
      const proposal = await runtime.createRuntimeTurn({
        ...actualActor,
        conversationId: taskId,
        plannedStep: quoteTask.plan[0]!,
        message: "Record this supplier offer"
      });
      expect(proposal.turn.status).toBe("needs_confirmation");
      expect(
        (
          await pool.query(
            "select count(*)::int as n from business_supplier_quotes where business_id=$1",
            [businessId]
          )
        ).rows[0].n
      ).toBe(0);
      const confirmed = await runtime.createRuntimeTurn({
        ...actualActor,
        conversationId: taskId,
        runtimeSessionId: proposal.session.id,
        confirmationToken: proposal.turn.plan.confirmationToken!,
        message: "Confirm the exact supplier offer"
      });
      expect(confirmed.turn.status).toBe("completed");
      for (const offer of [
        quote("actual-cheap", "actual-beans", "actual-b", 20_000),
        quote("actual-rice", "actual-rice", "actual-c", 100_000)
      ])
        await actualProcurement.recordQuote(actualActor, offer);
      const task = await actualTasks.create(actualActor, manifest, {
        taskId,
        objective: "Prepare purchase orders for three days within KES 15,000",
        executionMode: "LIVE",
        constraints: { budgetMinor: 1_500_000, currency: "KES", horizonDays: 3 },
        steps: [
          {
            id: "prepare",
            capability: "procurement.prepare",
            input: { taskId },
            dependencies: [],
            expectedOutput: "Purchase drafts, not submitted orders"
          }
        ]
      });
      await actualEnvironments.create(actualActor, taskId);
      await actualEnvironments.transition(actualActor, taskId, 0, "READY");
      await actualEnvironments.transition(actualActor, taskId, 1, "RUNNING");
      const execution = await executeBusinessTaskRootStep({
        ...actualActor,
        taskId,
        stepId: "prepare",
        expectedEnvironmentRevision: 2,
        manifest,
        tasks: actualTasks,
        steps: actualSteps,
        environments: actualEnvironments,
        runtime,
        commitRuntime: async () => {
          for (const turn of runtime.snapshot().runtimeTurns)
            await pool.query("insert into cp2_runtime_turns values ($1,$2,$3::jsonb)", [
              turn.id,
              turn.businessId,
              JSON.stringify(turn)
            ]);
        }
      });
      expect(execution.status).toBe("VERIFYING");
      const turn = runtime.snapshot().runtimeTurns.at(-1)!;
      expect(turn.plan.id).toBe(stableUuid(task.plan[0]!.idempotencyKey));
      expect(turn.sessionId).toBe(session.id);
      expect(turn.actorId).toBe(userId);
      expect(turn.toolResult).toMatchObject({
        recommendation: { status: "READY", totalMinor: 600_000 },
        drafts: expect.any(Array)
      });
      expect(
        (
          await createPostgresBusinessTaskVerifier(pool, authorizeActual).verify({
            ...actualActor,
            taskId,
            stepId: "prepare"
          })
        ).status
      ).toBe("PASSED");
      await actualEnvironments.transition(actualActor, taskId, 2, "VERIFYING");
      await actualEnvironments.transition(actualActor, taskId, 3, "COMPLETED");
      const experience = await runtime.recordVerifiedBusinessTaskExperience({
        ...actualActor,
        taskId
      });
      expect(experience).toMatchObject({
        validationState: "candidate",
        corroborationCount: 1,
        agentId: agent.agentId
      });
      expect(await runtime.businessTaskExperienceAdvice({ ...actualActor, taskId })).toEqual([]);
      const fresh = createCp2Store({
        businessTaskEvaluations: createBusinessTaskEvaluationReader(pool, authorizeActual)
      });
      fresh.hydrateSnapshot(runtime.snapshot());
      expect(await fresh.recordVerifiedBusinessTaskExperience({ ...actualActor, taskId })).toEqual(
        experience
      );
    } finally {
      await app.close();
    }
  }, 15000);
});
