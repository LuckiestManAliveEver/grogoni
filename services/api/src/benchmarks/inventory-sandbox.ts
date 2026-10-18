import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { buildApi } from "../app.js";
import { createCp2Store, readSessionCookie } from "../cp2/store.js";
import { createInventoryTaskController } from "../cp2/domains/agent-runtime/inventory-task-controller.js";
import { createPostgresInventoryProcurementStore } from "../cp2/domains/agent-runtime/inventory-procurement-store.js";
import { createBusinessTaskEvaluationReader } from "../cp2/domains/agent-runtime/business-task-evaluation-reader.js";
import { stableUuid } from "../cp2/domains/agent-runtime/shared.js";
import { runtimeExecutedModelId } from "../cp2/domains/agent-runtime/runtime-model-evidence.js";
import { guardPgPoolErrors } from "../pg-pool-errors.js";
import {
  assertInventoryBenchmarkDatabase,
  type InventoryBenchmarkFixture
} from "./inventory-fixtures.js";

export async function createInventoryBenchmarkSandbox(
  connectionString: string,
  fixture: InventoryBenchmarkFixture,
  anchor: Date
) {
  assertInventoryBenchmarkDatabase(connectionString);
  const schema = `benchmark_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({
    connectionString,
    max: 3,
    options: `-c search_path=${schema} -c statement_timeout=15000`
  });
  guardPgPoolErrors(admin, () => undefined);
  guardPgPoolErrors(pool, () => undefined);
  let created = false;
  try {
    await admin.query(`create schema ${schema}`);
    created = true;
    for (const name of [
      "113_business_tasks.sql",
      "114_business_task_steps.sql",
      "115_runtime_approvals.sql",
      "117_business_task_verifications.sql",
      "118_task_verification_sequence.sql",
      "119_business_environment_instances.sql",
      "120_inventory_procurement.sql",
      "121_runtime_approval_rejection.sql"
    ])
      await pool.query(
        await readFile(new URL(`../../../../infra/db/migrations/${name}`, import.meta.url), "utf8")
      );
    for (const table of ["cp2_products", "cp2_invoices", "cp2_suppliers", "cp2_runtime_turns"])
      await pool.query(
        `create table ${table} (entity_id text primary key,business_id text not null,record jsonb not null)`
      );
    const store = createCp2Store({
      platformDefaultRuntime: {
        agentId: "builtin:shopkeeper:v1",
        agentName: "Shopkeeper",
        agentRuntimeAdapterId: "grogoni",
        modelId: "smollm2-360m",
        executionTarget: "local"
      },
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        executionTarget !== "local"
          ? undefined
          : {
              provider: "benchmark-deterministic-fixture",
              executionTarget: "local",
              canRun: async () => ({ available: true, errorCode: null, message: null }),
              healthCheck: async () => ({
                available: true,
                modelId,
                provider: "benchmark-deterministic-fixture",
                executionTarget: "local",
                latencyMs: 0,
                responsePreview: "fixture",
                errorCode: null,
                message: null,
                retryable: false
              }),
              generate: async () => {
                throw new Error("The deterministic benchmark executor cannot invoke a model.");
              }
            },
      businessTaskEvaluations: createBusinessTaskEvaluationReader(pool, (input) =>
        store.authorizeBusinessPermission(input)
      ),
      inventoryProcurement: createPostgresInventoryProcurementStore(pool, (input) =>
        store.authorizeBusinessPermission(input)
      )
    });
    const controller = createInventoryTaskController(
      store,
      (work) => work(pool),
      async () => {
        for (const turn of store.snapshot().runtimeTurns)
          await pool.query(
            `insert into cp2_runtime_turns values ($1,$2,$3::jsonb) on conflict(entity_id) do update set record=excluded.record`,
            [turn.id, turn.businessId, JSON.stringify(turn)]
          );
      }
    );
    store.setInventoryTaskController(controller);
    const app = buildApi({ cp2: { store, inventoryTaskController: controller } });
    try {
      const signup = await app.inject({
        method: "POST",
        url: "/auth/pin/signup",
        payload: { method: "phone", contact: "254700000001", pin: "1234" }
      });
      if (signup.statusCode !== 200) throw new Error("Benchmark owner setup failed.");
      const cookie = String(signup.headers["set-cookie"]).split(";")[0]!;
      const sessionId = readSessionCookie(cookie);
      const owner = signup.json().user.id as string;
      const business = await app.inject({
        method: "POST",
        url: "/businesses",
        headers: { cookie },
        payload: { name: "Synthetic benchmark shop", language: "en" }
      });
      if (business.statusCode !== 200) throw new Error("Benchmark business setup failed.");
      const businessId = business.json().business.id as string;
      const actor = { sessionId, businessId };
      for (const [id, quantity] of Object.entries(fixture.stock))
        await pool.query("insert into cp2_products values ($1,$2,$3::jsonb)", [
          id,
          businessId,
          JSON.stringify({
            id,
            businessId,
            name: id === "beans" ? "Beans" : "Rice",
            unit: "kg",
            quantity
          })
        ]);
      const suppliers = [
        { id: "expensive", name: "Expensive Wholesale" },
        { id: "cheap", name: "Cheap Wholesale" },
        { id: "rice", name: "Rice Wholesale" }
      ];
      if (fixture.suppliersAvailable)
        for (const supplier of suppliers)
          await pool.query("insert into cp2_suppliers values ($1,$2,$3::jsonb)", [
            supplier.id,
            businessId,
            JSON.stringify({ ...supplier, businessId })
          ]);
      await pool.query("insert into cp2_invoices values ('sales',$1,$2::jsonb)", [
        businessId,
        JSON.stringify({
          id: "sales",
          businessId,
          status: "confirmed",
          confirmedAt: new Date(anchor.getTime() - 7 * 86400000 + 3600000).toISOString(),
          items: [
            { productId: "beans", quantity: 14 },
            { productId: "rice", quantity: 35 }
          ]
        })
      ]);
      if (fixture.suppliersAvailable)
        for (const [id, productId, supplierId, unitPriceMinor] of [
          ["beans-expensive", "beans", "expensive", 30000],
          ["beans-cheap", "beans", "cheap", 20000],
          ["rice-offer", "rice", "rice", 100000]
        ] as const) {
          const quote = {
            id,
            businessId,
            productId,
            supplierId,
            unit: "kg",
            currency: "KES",
            unitPriceMinor,
            priceIncludesCharges: true,
            minQuantityMilli: 1000,
            incrementMilli: 1000,
            availableQuantityMilli: 100000,
            leadTimeDays: 0,
            expiresAt: new Date(anchor.getTime() + 86400000).toISOString()
          };
          await pool.query(
            "insert into business_supplier_quotes (business_id,quote_id,created_by,record) values ($1,$2,$3,$4::jsonb)",
            [businessId, id, owner, JSON.stringify(quote)]
          );
        }
      const parent = store.createConversation({
        sessionId,
        kind: "personal",
        activeShopId: businessId,
        title: "Benchmark source chat"
      });
      const message = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { cookie },
        payload: {
          conversationId: parent.conversation.id,
          clientMessageId: randomUUID(),
          author: "owner",
          content: { type: "text", text: fixture.goal },
          clientTimestamp: anchor.toISOString()
        }
      });
      if (message.statusCode !== 200) throw new Error("Benchmark message setup failed.");
      const messageId = message.json().id as string;
      const taskId = stableUuid(`inventory-task:${businessId}:${owner}:${messageId}`);
      return {
        schemaId: schema,
        taskId,
        businessId,
        async execute() {
          await controller.handle({
            ...actor,
            conversationId: parent.conversation.id,
            messageId,
            text: fixture.goal
          });
          const view = await controller.inspect(actor, taskId);
          return {
            view,
            turns: store.snapshot().runtimeTurns.map((turn) => ({
              id: turn.id,
              status: turn.status,
              capability: turn.plan.toolName,
              actionId: turn.plan.id,
              telemetry: turn.telemetry,
              modelInvoked: runtimeExecutedModelId(turn) !== null
            }))
          };
        },
        async close() {
          try {
            await app.close();
          } finally {
            try {
              await pool.end();
            } finally {
              try {
                await admin.query(`drop schema ${schema} cascade`);
              } finally {
                await admin.end();
              }
            }
          }
        }
      };
    } catch (error) {
      await app.close();
      throw error;
    }
  } catch (error) {
    await pool.end();
    if (created) await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    throw error;
  }
}
