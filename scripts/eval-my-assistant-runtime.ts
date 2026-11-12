// Paid eval for "My Assistant" agent and model switching (docs/frontend/my-assistant.md).
// Run: pnpm eval:my-assistant-runtime [--report <path>]
// For every agent engine the details panel offers, switches the permanent daemon conversation to
// it through the same store call PUT /v1/conversations/:id/model makes (including the real model
// health check), derives the background task payload with the Edge daemon lane's own helper
// (daemon/conversation-runtime.ts), and runs the real daemon executor against the
// platform default model through OpenRouter (OPENROUTER_API_KEY from .env or .env.openrouter).
// Grades: the payload names the chosen engine, the executor's event stream shows that engine ran,
// and it answers a checkable question.
// Writes a JSON report; exit 0 = pass, 1 = below threshold, 2 = not run (no model configured).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  repositoryDefaultRuntimePolicy,
  type DaemonPayload
} from "../packages/shared-types/src/index.ts";
import { createCp2Store } from "../services/api/src/cp2/store.ts";
import { daemonConversationRuntime } from "../services/api/src/daemon/conversation-runtime.ts";
import { createOpenRouterRuntime } from "../services/api/src/inference/openrouter-runtime.ts";
import { createDaemonExecutor } from "../services/api/src/daemon/executor.ts";
import type { DaemonTask } from "../services/api/src/daemon/task-store.ts";

const passThreshold = 1; // Every offered engine must work: a listed choice that fails is a bug.
const reportFlag = process.argv.indexOf("--report");
const reportPath =
  reportFlag === -1 ? "/tmp/my-assistant-runtime/eval/report.json" : process.argv[reportFlag + 1]!;
const write = (report: unknown) => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
};

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  write({ status: "not_run", reason: "OPENROUTER_API_KEY is not set." });
  process.exit(2);
}

const runtime = createOpenRouterRuntime(process.env);
const store = createCp2Store({
  configuredModels: runtime.catalog(),
  modelRuntimeAdapterResolver: runtime.resolve
});
const owner = store.continueWithChannelPin({
  channel: "phone",
  destination: `+44207946${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`,
  pin: "1234"
});
const conversationId = store.getGrogoniSessionContext({
  sessionId: owner.session.id
}).conversationId;
const initial = store.getConversationModelSelection(owner.session.id, conversationId);
const modelId =
  initial.models.find((model) => model.id === repositoryDefaultRuntimePolicy.modelId)?.id ??
  initial.models[0]?.id;
if (modelId === undefined) {
  write({ status: "not_run", reason: "No configured models.", selection: initial });
  process.exit(2);
}

const executor = createDaemonExecutor(process.env);
const question = { message: "What is 17 + 25? Reply with only the number.", expected: "42" };
const cases = [];
for (const agent of initial.agents) {
  const started = Date.now();
  const row: Record<string, unknown> = { agentId: agent.id, label: agent.label, modelId };
  try {
    const selection = await store.selectConversationModel(owner.session.id, conversationId, {
      agentId: agent.id,
      modelId
    });
    row.selectedAgentId = selection.selectedAgentId;
    // The exact mapping the Edge daemon lane uses (authorizeConversation and the claim/execute
    // refresh), not a re-implementation of it.
    const payload: DaemonPayload = {
      kind: "agent",
      message: question.message,
      ...daemonConversationRuntime(store, conversationId)
    };
    row.payloadAgentAdapterId = payload.agentAdapterId;
    const now = new Date();
    const task: DaemonTask = {
      id: randomUUID(),
      idempotency_key: `eval:${agent.id}`,
      payload,
      status: "running",
      run_at: now,
      attempts: 1,
      max_attempts: 1,
      executions: 0,
      lease_token: null,
      lease_until: null,
      interval_ms: null,
      result: null,
      error_code: null,
      owner_user_id: null,
      lane: "server",
      created_at: now,
      updated_at: now
    };
    const result = (await executor(task, AbortSignal.timeout(90_000))) as {
      completion: { outputText?: string };
      eventTypes: string[];
    };
    const reply = result.completion.outputText ?? "";
    row.reply = reply.slice(0, 400);
    row.eventTypes = result.eventTypes;
    // Proof the executor ran the chosen engine, from what it emitted: only Pi streams message
    // updates; Grogoni's harness reports turn lifecycle events alone.
    const ranPi = result.eventTypes.includes("message_update");
    row.engineObserved = ranPi ? "pi" : "grogoni";
    row.engineMatches =
      selection.selectedAgentId === agent.id &&
      payload.agentAdapterId === agent.id &&
      row.engineObserved === agent.id;
    row.answerCorrect = reply.includes(question.expected);
    row.pass = row.engineMatches === true && row.answerCorrect === true;
  } catch (error) {
    row.pass = false;
    row.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  row.latencyMs = Date.now() - started;
  cases.push(row);
  console.log(`${row.pass ? "PASS" : "FAIL"} ${agent.label} on ${modelId} (${row.latencyMs}ms)`);
}

const passRate = cases.length === 0 ? 0 : cases.filter((row) => row.pass).length / cases.length;
const status = cases.length > 0 && passRate >= passThreshold ? "pass" : "fail";
write({
  status,
  passRate,
  passThreshold,
  modelId,
  agentsOffered: initial.agents,
  cases,
  finishedAt: new Date().toISOString()
});
console.log(
  `${status.toUpperCase()}: ${(passRate * 100).toFixed(0)}% of offered engines answered.`
);
process.exit(status === "pass" ? 0 : 1);
