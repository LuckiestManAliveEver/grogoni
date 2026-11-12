import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { buildDaemonGateway } from "../src/daemon/gateway.js";
import { createDaemonExecutor, readDaemonCapabilities } from "../src/daemon/executor.js";
import { createPostgresDaemonTaskStore, daemonQueueMigrations } from "../src/daemon/task-store.js";
import { runDaemonWorker } from "../src/daemon/worker.js";

/** Disposable local operator test fixture; never uses the production database implicitly. */
export async function createLinkedDaemonTestHost() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required.");
  const environment = { ...process.env, OPENROUTER_MAX_OUTPUT_TOKENS: "128" };
  const modelId = "gpt-6-luna";
  const capabilities = readDaemonCapabilities(environment, modelId);
  const url =
    process.env.CP2_POSTGRES_TEST_DATABASE_URL ??
    "postgres://daemon_test:daemon_test_only@127.0.0.1:55439/daemon_test";
  const schema = `linked_model_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const store = createPostgresDaemonTaskStore(pool);
  const token = randomBytes(32).toString("hex");
  const gateway = buildDaemonGateway({
    store,
    token,
    ready: () => true,
    defaults: { modelId, agentAdapterId: "grogoni" },
    refusal: capabilities.refusal
  });
  const controller = new AbortController();
  let worker: Promise<void> | undefined;
  const close = async () => {
    controller.abort();
    await worker;
    await gateway.close();
    await pool.end();
    await admin.query(`drop schema if exists ${schema} cascade`);
    await admin.end();
  };
  try {
    await admin.query(`create schema ${schema}`);
    for (const file of daemonQueueMigrations)
      await pool.query(
        await readFile(new URL(`../../../infra/db/migrations/${file}`, import.meta.url), "utf8")
      );
    const base = await gateway.listen({ host: "127.0.0.1", port: 0 });
    worker = runDaemonWorker({
      store,
      execute: createDaemonExecutor(environment),
      signal: controller.signal,
      pollMs: 100,
      taskTimeoutMs: 120_000
    });
    return { base, token, store, modelId, close };
  } catch (error) {
    await close();
    throw error;
  }
}
