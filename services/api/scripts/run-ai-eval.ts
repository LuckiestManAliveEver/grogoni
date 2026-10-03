/**
 * Periodic eval (CLAUDE.md's "paid, quality-measuring, threshold" test lane - not a pre-commit
 * gate test) for the *model-fallback* path: merchant messages that miss every deterministic
 * context-script rule and reach a real model call through createRuntimeTurn. "Model-fallback" here
 * means falling back from the deterministic context-script layer to a real model call - it has
 * nothing to do with the (removed) automatic local-to-cloud escalation feature; see
 * docs/architecture/provider-neutral-runtime.md.
 *
 * Reuses the exact production backend-adapter wiring from src/index.ts rather than inventing a
 * parallel path - see that file for the canonical wiring this mirrors. Nothing here calls Claude
 * Code or any tool outside this codebase's own inference stack.
 *
 * Run: pnpm --filter @grogoni/api eval:ai   (or `pnpm eval:ai` from the repo root)
 * Exits 0 with a report on pass >= threshold, non-zero otherwise. Skips (exit 0, no report) with
 * a clear message when no model backend is configured at all - this is dev/CI tooling, not a
 * required gate, so it must not fail a machine that simply has no model configured.
 */
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { buildApi } from "../src/app.js";
import { readEnvironment } from "../src/config.js";
import {
  createVercelInferenceClient,
  createVercelModelAdapter,
  type ModelRuntimeAdapter
} from "../src/inference/model-runtime.js";
import { createNeonModelArtifactStore } from "../src/inference/model-artifact-store.js";
import { createCp2Store } from "../src/cp2/store.js";
import { modelFallbackEvalScenarios } from "../../../tests/ai-eval/model-fallback-scenarios.js";

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

  if (config.vercelInferenceUrl === "") {
    console.log(
      "No Vercel inference host is configured (VERCEL_INFERENCE_URL is unset) - skipping the " +
        "AI eval. Set VERCEL_INFERENCE_URL, GROGONI_INFERENCE_SERVICE_TOKEN and the NEON_MODEL_" +
        "STORAGE_* credentials to a deployed services/ai-runtime instance to run this."
    );
    return;
  }

  const modelId = config.platformDefaultRuntime.modelId;
  const artifactPool = new Pool({ connectionString: config.databaseUrl, max: 2 });
  const artifactStore = createNeonModelArtifactStore({
    database: artifactPool,
    endpoint: config.neonModelStorageEndpoint,
    region: config.neonModelStorageRegion,
    accessKeyId: config.neonModelStorageAccessKeyId,
    secretAccessKey: config.neonModelStorageSecretAccessKey,
    downloadUrlTtlSeconds: config.modelArtifactUrlTtlSeconds
  });
  const client = createVercelInferenceClient({
    baseUrl: config.vercelInferenceUrl,
    serviceToken: config.inferenceServiceToken,
    timeoutMs: config.vercelInferenceTimeoutMs
  });
  const vercelAdapter: ModelRuntimeAdapter = createVercelModelAdapter({
    modelId,
    artifactStore,
    client
  });

  const modelRuntimeAdapters = new Map<string, ModelRuntimeAdapter>();
  modelRuntimeAdapters.set(`vercel:${modelId}`, vercelAdapter);
  const store = createCp2Store({
    modelRuntimeAdapterResolver: (input) =>
      modelRuntimeAdapters.get(`${input.executionTarget}:${input.modelId}`)
  });
  const app = buildApi({ cp2: { store } });

  const destination = `254${Date.now().toString().slice(-9)}`;
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
  for (const scenario of modelFallbackEvalScenarios) {
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

    const judgeText = await judge(judgePrompt, vercelAdapter, modelId);
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
  await artifactPool.end();

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
    JSON.stringify({ passRate, threshold: passThreshold, results }, null, 2)
  );
  console.log(`Report written to ${reportPath}`);

  if (passRate < passThreshold) {
    process.exitCode = 1;
  }
}

async function judge(
  prompt: string,
  adapter: ModelRuntimeAdapter,
  modelId: string
): Promise<string> {
  try {
    return await judgeViaVercel(prompt, adapter, modelId);
  } catch (error) {
    console.warn(
      `Vercel inference judge call failed, falling back to cloud: ${(error as Error).message}`
    );
  }
  return judgeViaOpenAi(prompt);
}

async function judgeViaVercel(
  prompt: string,
  adapter: ModelRuntimeAdapter,
  modelId: string
): Promise<string> {
  const result = await adapter.generate({
    context: {
      agentId: "builtin:pi:v1",
      shopId: "ai-eval",
      modelId,
      conversationId: "ai-eval:judge"
    },
    prompt: {
      message: prompt,
      allowedTools: [],
      schemaVersion: "cp11-runtime-model-v1"
    }
  });
  return result.text;
}

async function judgeViaOpenAi(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    throw new Error("No OPENAI_API_KEY configured for cloud fallback judging.");
  }
  const model = process.env.OPENAI_FAST_MODEL?.trim() || "gpt-5-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!response.ok) {
    throw new Error(`OpenAI judge call returned ${response.status}`);
  }
  const body = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return body.choices[0]?.message.content ?? "";
}

function parseJudgeVerdict(text: string): { verdict: "PASS" | "FAIL"; reason: string } {
  try {
    const match = text.match(/\{[\s\S]*\}/u);
    const parsed = JSON.parse(match?.[0] ?? text) as { verdict?: unknown; reason?: unknown };
    const verdict = parsed.verdict === "PASS" ? "PASS" : "FAIL";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason given by judge.";
    return { verdict, reason };
  } catch {
    return {
      verdict: "FAIL",
      reason: `Judge output was not parseable JSON: ${text.slice(0, 200)}`
    };
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
