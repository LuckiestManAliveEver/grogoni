/**
 * Periodic eval (CLAUDE.md's "paid, quality-measuring, threshold" test lane - not a pre-commit
 * gate test) for the *model-fallback* path: merchant messages that miss every deterministic
 * context-script rule and reach a real model call through createRuntimeTurn. "Model-fallback" here
 * means falling back from the deterministic context-script layer to a real model call - it has
 * nothing to do with the (removed) automatic local-to-cloud escalation feature; see
 * docs/architecture/provider-neutral-runtime.md.
 *
 * The model under test is the production server-side runtime: local Ollama, wired exactly as
 * src/index.ts wires it (OLLAMA_BASE_URL, OLLAMA_MODEL, the platform default model id). Replies are
 * graded by local Claude Code (`claude -p`, CLAUDE.md "LLM access"), never a hosted LLM API.
 *
 * Run: pnpm --filter @grogoni/api eval:ai   (or `pnpm eval:ai` from the repo root)
 * Set GROGONI_CLAUDE_BIN when the Claude Code CLI is not on PATH as `claude`.
 * Exits 0 with a report on pass >= threshold, non-zero otherwise. Skips (exit 0, no report) with a
 * clear message when Ollama or the judge is not available - this is dev/CI tooling, not a gate.
 */
import { writeFile } from "node:fs/promises";
import { buildApi } from "../src/app.js";
import { readEnvironment } from "../src/config.js";
import {
  createOllamaInferenceClient,
  createOllamaModelAdapter,
  type ModelRuntimeAdapter
} from "../src/inference/model-runtime.js";
import { createCp2Store } from "../src/cp2/store.js";
import { modelFallbackEvalScenarios } from "../../../tests/ai-eval/model-fallback-scenarios.js";
import { createClaudeCodeJudge, parseJudgeVerdict } from "./ai-eval-judge.js";

const judge = createClaudeCodeJudge({
  bin: process.env.GROGONI_CLAUDE_BIN?.trim() || "claude",
  log: (message) => console.warn(message)
});

const passThreshold = 0.8;
const reportPath = "/tmp/grogoni-ai-eval-report.json";

interface ScenarioResult {
  id: string;
  message: string;
  response: string;
  verdict: "PASS" | "FAIL";
  reason: string;
}

async function main() {
  const config = readEnvironment();
  const modelId = config.platformDefaultRuntime.modelId;
  const client = createOllamaInferenceClient({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
    timeoutMs: config.inferenceTimeoutMs
  });
  const health = await client.health();
  if (!health.available) {
    console.log(
      `Local Ollama is not ready (${health.errorCode ?? "unavailable"}: ${health.message ?? ""}) - ` +
        `skipping the AI eval. Start Ollama at ${health.endpoint} and run ` +
        `\`ollama pull ${config.ollamaModel}\`.`
    );
    return;
  }
  if (!(await judge.available())) {
    console.log(
      `The Claude Code CLI (${judge.bin}) is not available to judge replies - skipping the AI ` +
        "eval. Install Claude Code or set GROGONI_CLAUDE_BIN to its binary."
    );
    return;
  }

  const adapter: ModelRuntimeAdapter = createOllamaModelAdapter({
    modelId,
    ollamaModel: config.ollamaModel,
    client
  });
  const store = createCp2Store({
    modelRuntimeAdapterResolver: (input) =>
      input.executionTarget === "local" && input.modelId === modelId ? adapter : undefined
  });
  const app = buildApi({ cp2: { store } });

  // Always a valid Kenyan mobile number (2547 + 8 digits); arbitrary digits after 254 are not.
  const destination = `2547${Date.now().toString().slice(-8)}`;
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  if (signup.statusCode !== 200) {
    throw new Error(`Eval account signup failed: ${signup.body}`);
  }
  const cookie = String(signup.headers["set-cookie"]).split(";")[0] ?? "";
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({ name: "AI Eval Shop", language: "en" })
  });
  if (business.statusCode !== 200) {
    throw new Error(`Eval business creation failed: ${business.body}`);
  }
  const businessId = (business.json() as { business: { id: string } }).business.id;

  const results: ScenarioResult[] = [];
  for (const [index, scenario] of modelFallbackEvalScenarios.entries()) {
    const turnStartedAt = Date.now();
    console.log(
      `[eval] ${index + 1}/${modelFallbackEvalScenarios.length} ${scenario.id}: running turn`
    );
    const turnResponse = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ message: scenario.message })
    });
    if (turnResponse.statusCode !== 200) {
      results.push({
        id: scenario.id,
        message: scenario.message,
        response: "",
        verdict: "FAIL",
        reason: `Runtime turn request failed (${turnResponse.statusCode}): ${turnResponse.body}`
      });
      continue;
    }
    const turn = (turnResponse.json() as { turn: { response: string } }).turn;

    const judgePrompt = [
      "You are grading one AI assistant reply for a Kenyan small-business commerce app.",
      "",
      `Merchant message: ${scenario.message}`,
      `Assistant reply: ${turn.response}`,
      "",
      `Rubric: ${scenario.rubric}`,
      "",
      'Respond with strict JSON only: {"verdict":"PASS"|"FAIL","reason":"<one sentence>"}'
    ].join("\n");

    const judgeStartedAt = Date.now();
    const judgeText = await judge.grade(judgePrompt);
    console.log(
      `[eval] ${scenario.id}: turn ${judgeStartedAt - turnStartedAt}ms, judge ${Date.now() - judgeStartedAt}ms`
    );
    const parsedVerdict = parseJudgeVerdict(judgeText);
    results.push({
      id: scenario.id,
      message: scenario.message,
      response: turn.response,
      verdict: parsedVerdict.verdict,
      reason: parsedVerdict.reason
    });
  }

  await app.close();

  const passCount = results.filter((result) => result.verdict === "PASS").length;
  const passRate = passCount / results.length;

  for (const result of results) {
    console.log(`${result.verdict === "PASS" ? "✓" : "✗"} ${result.id}: ${result.reason}`);
  }
  console.log(
    `\n${passCount}/${results.length} passed (${(passRate * 100).toFixed(0)}%, threshold ${(passThreshold * 100).toFixed(0)}%)`
  );

  await writeFile(
    reportPath,
    JSON.stringify(
      {
        model: { id: modelId, ollamaModel: config.ollamaModel },
        passRate,
        threshold: passThreshold,
        results
      },
      null,
      2
    )
  );
  console.log(`Report written to ${reportPath}`);

  if (passRate < passThreshold) {
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => judge.dispose());
