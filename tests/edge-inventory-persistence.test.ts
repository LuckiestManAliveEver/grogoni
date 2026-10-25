import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

vi.mock("../services/api/src/edge-store-dependencies", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createEdgeStoreDependencies: () => ({
    platformDefaultRuntime: {
      agentId: "builtin:shopkeeper:v1",
      agentName: "Shopkeeper",
      agentRuntimeAdapterId: "grogoni",
      modelId: "smollm2-360m",
      executionTarget: "local"
    },
    modelRuntimeAdapterResolver: ({ modelId }: { modelId: string }) => ({
      provider: "fixture-deterministic-task",
      executionTarget: "local",
      canRun: async () => ({ available: true, errorCode: null, message: null }),
      healthCheck: async () => ({
        available: true,
        modelId,
        provider: "fixture-deterministic-task",
        executionTarget: "local",
        latencyMs: 1,
        responsePreview: "GROGONI_MODEL_OK",
        errorCode: null,
        message: null,
        retryable: false
      }),
      generate: async () => {
        throw new Error("Deterministic inventory must not invoke a model.");
      }
    })
  })
}));

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("Edge inventory persistence on PostgreSQL", () => {
  it.each(["read committed", "repeatable read"])(
    "keeps acknowledged drafts after an outer %s rollback",
    async (isolation) => {
      const pool = new Pool({ connectionString: databaseUrl, max: 4 });
      async function transaction<T>(
        work: (client: PoolClient) => Promise<T>,
        fail = false,
        level = "read committed"
      ) {
        const client = await pool.connect();
        try {
          await client.query(`begin isolation level ${level}`);
          const result = await work(client);
          if (fail) throw new Error("injected outer request failure");
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      }
      try {
        const store = createCp2Store();
        const baseline = store.snapshot();
        const owner = store.continueWithChannelPin({
          channel: "email",
          destination: `edge-inventory-${randomUUID()}@example.invalid`,
          pin: "1234"
        });
        const businessId = store.createBusiness({
          sessionId: owner.session.id,
          name: `Synthetic Edge inventory ${randomUUID()}`,
          language: "en",
          phoneNumber: `+25479${Date.now().toString().slice(-7)}`,
          phoneCountry: "KE"
        }).business.id;
        const conversation = store.createConversation({
          sessionId: owner.session.id,
          kind: "personal",
          activeShopId: businessId
        }).conversation;
        await transaction((client) =>
          saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
        );
        const productId = randomUUID();
        const supplierId = randomUUID();
        await pool.query(
          "insert into cp2_products (entity_id,business_id,record) values ($1,$2,$3::jsonb)",
          [
            productId,
            businessId,
            JSON.stringify({ id: productId, businessId, name: "Beans", unit: "kg", quantity: 1 })
          ]
        );
        await pool.query(
          "insert into cp2_suppliers (entity_id,business_id,record) values ($1,$2,$3::jsonb)",
          [
            supplierId,
            businessId,
            JSON.stringify({ id: supplierId, businessId, name: "Fixture wholesale" })
          ]
        );
        const invoiceId = randomUUID();
        await pool.query(
          "insert into cp2_invoices (entity_id,business_id,record) values ($1,$2,$3::jsonb)",
          [
            invoiceId,
            businessId,
            JSON.stringify({
              id: invoiceId,
              businessId,
              status: "confirmed",
              confirmedAt: new Date(Date.now() - 7 * 86400000 + 3600000).toISOString(),
              items: [{ productId, quantity: 14 }]
            })
          ]
        );
        const quoteId = randomUUID();
        await pool.query(
          "insert into business_supplier_quotes (business_id,quote_id,created_by,record) values ($1,$2,$3,$4::jsonb)",
          [
            businessId,
            quoteId,
            owner.account.id,
            JSON.stringify({
              id: quoteId,
              businessId,
              productId,
              supplierId,
              unit: "kg",
              currency: "KES",
              unitPriceMinor: 20000,
              priceIncludesCharges: true,
              minQuantityMilli: 1000,
              incrementMilli: 1000,
              availableQuantityMilli: 100000,
              leadTimeDays: 0,
              expiresAt: new Date(Date.now() + 86400000).toISOString()
            })
          ]
        );
        // The message's request commits; the background agent turn's own transaction (the next
        // one) fails after the inventory recipe acknowledged its drafts independently.
        let transactions = 0;
        let failFrom = Number.POSITIVE_INFINITY;
        const edge = await createEdgeDomainRoutes({
          transaction: (work) => transaction(work, ++transactions >= failFrom, isolation),
          approvalTransaction: (work) => transaction(work)
        });
        const payload = {
          conversationId: conversation.id,
          clientMessageId: randomUUID(),
          content: {
            type: "text",
            text: "Check my inventory, identify products likely to run out within three days, compare available suppliers, and prepare purchase orders within a KES 15,000 budget."
          },
          agent: { businessId, message: "This client-side message is not the task objective." }
        };
        const call = () =>
          edge.routes(
            new Request("https://grogoni.com/v1/messages", {
              method: "POST",
              headers: {
                cookie: `grogoni_session=${owner.session.id}`,
                "content-type": "application/json"
              },
              body: JSON.stringify(payload)
            }),
            "/v1/messages"
          );
        failFrom = transactions + 2;
        const accepted = await call();
        expect(accepted?.status, await accepted?.clone().text()).toBe(200);
        const { processing, id: messageId } = await accepted!.json();
        expect(processing.status).toBe("pending");
        await edge.settled();
        const turnState = () =>
          pool
            .query("select status from agent_chat_turns where message_id=$1", [messageId])
            .then((result) => result.rows[0]?.status);
        expect(await turnState()).toBe("failed");
        const drafts = await pool.query(
          "select record from business_purchase_drafts where business_id=$1",
          [businessId]
        );
        expect(drafts.rows).toHaveLength(1);
        expect(drafts.rows[0].record.submissionStatus).toBe("NOT_SUBMITTED");
        const turns = await pool.query(
          "select record from cp2_runtime_turns where business_id=$1",
          [businessId]
        );
        expect(turns.rows).toHaveLength(1);
        expect(turns.rows[0].record.status).toBe("completed");
        const evidence = await pool.query(
          "select status from business_environment_task_verifications where business_id=$1",
          [businessId]
        );
        expect(evidence.rows.some((row) => row.status === "PASSED")).toBe(true);
        failFrom = Number.POSITIVE_INFINITY;
        const replay = await call();
        expect(replay?.status, await replay?.clone().text()).toBe(200);
        await edge.settled();
        expect(await turnState()).toBe("completed");
        expect(
          (
            await pool.query("select record from business_purchase_drafts where business_id=$1", [
              businessId
            ])
          ).rows
        ).toEqual(drafts.rows);
        expect(
          (
            await pool.query("select record from cp2_runtime_turns where business_id=$1", [
              businessId
            ])
          ).rows
        ).toEqual(turns.rows);
      } finally {
        await pool.end();
      }
    },
    60000
  );
  it("loads binding graph edges without exposing another business's hosts or installations", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store();
      const baseline = store.snapshot();
      const owners = [0, 1].map((index) =>
        store.continueWithChannelPin({
          channel: "phone",
          destination: `+25479${Date.now().toString().slice(-6)}${index}`,
          pin: "1234"
        })
      );
      const businesses = owners.map(
        (owner) =>
          store.createBusiness({
            sessionId: owner.session.id,
            name: `Graph isolation ${randomUUID()}`,
            language: "en"
          }).business.id
      );
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      const graphs = businesses.map((businessId) => ({
        businessId,
        agent: randomUUID(),
        binding: randomUUID(),
        model: randomUUID(),
        host: randomUUID(),
        role: randomUUID(),
        installation: randomUUID()
      }));
      for (const graph of graphs) {
        for (const [table, id, businessId, record] of [
          [
            "cp2_native_runtime_agents",
            graph.agent,
            graph.businessId,
            {
              id: graph.agent,
              businessId: graph.businessId,
              status: "active",
              runtimeContractVersion: "1"
            }
          ],
          [
            "cp2_native_runtime_bindings",
            graph.binding,
            graph.businessId,
            {
              id: graph.binding,
              businessId: graph.businessId,
              agentId: graph.agent,
              status: "active",
              isDefault: false
            }
          ],
          ["cp2_native_runtime_models", graph.model, null, { id: graph.model }],
          [
            "cp2_native_execution_hosts",
            graph.host,
            graph.businessId,
            {
              id: graph.host,
              businessId: graph.businessId,
              credentialReference: "private-host-reference"
            }
          ],
          [
            "cp2_native_runtime_binding_models",
            graph.role,
            null,
            {
              id: graph.role,
              runtimeBindingId: graph.binding,
              modelId: graph.model,
              executionHostId: graph.host
            }
          ],
          [
            "cp2_native_model_installations",
            graph.installation,
            null,
            { id: graph.installation, modelId: graph.model, executionHostId: graph.host }
          ]
        ] as const)
          await client.query(
            `insert into ${table} (entity_id,business_id,parent_id,record) values ($1,$2,$3,$4::jsonb)`,
            [
              id,
              businessId,
              table === "cp2_native_runtime_bindings"
                ? graph.agent
                : table === "cp2_native_runtime_binding_models"
                  ? graph.binding
                  : table === "cp2_native_model_installations"
                    ? graph.host
                    : null,
              JSON.stringify(record)
            ]
          );
      }
      const scope = await createEdgeSnapshotScope(
        client,
        new Request("https://grogoni.com/v1/shops", {
          headers: { cookie: `grogoni_session=${owners[0]!.session.id}` }
        }),
        "/v1/shops"
      );
      const snapshot = await loadTransactionalCp2Snapshot(client, scope);
      for (const [collection, field] of [
        ["nativeRuntimeBindings", "binding"],
        ["nativeRuntimeModels", "model"],
        ["nativeExecutionHosts", "host"],
        ["nativeRuntimeBindingModels", "role"],
        ["nativeModelInstallations", "installation"]
      ] as const) {
        const ids = snapshot[collection]?.map((record) => record.id);
        expect(ids).toContain(graphs[0]![field]);
        expect(ids).not.toContain(graphs[1]![field]);
      }
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  }, 30000);
});
