import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression: the real-model eval died with "Detected unsettled top-level await" (exit 13) at
 * `await scoreClassifier(...)`. The model call's only pending handles were unreferenced (Node's
 * AbortSignal.timeout timer is unref'd, and an in-flight request can be too), so once every other
 * handle was gone Node exited with the classification still pending. The classifier now holds its
 * own referenced deadline, so a call always settles: with an answer, or a timeout by the limit.
 *
 * This runs the scoring loop the way the eval script does (a top-level await in a fresh Node
 * process) against a fake slow model whose only pending handle is an unref'd timer.
 */
const classifierUrl = new URL("../classifier.ts", import.meta.url).href;
const scoreUrl = new URL("./score.ts", import.meta.url).href;

function runScoring(modelDelayMs: number, timeoutMs: number) {
  const script = `
    import { createGuestIntentClassifier } from ${JSON.stringify(classifierUrl)};
    import { scoreClassifier, summarize } from ${JSON.stringify(scoreUrl)};
    const complete = (call) =>
      new Promise((resolve, reject) => {
        // Unreferenced, like the pending handles of a real in-flight model request.
        const timer = setTimeout(
          () => resolve({ text: '{"intent":"greeting","query":null}', modelId: "fake", latencyMs: ${modelDelayMs} }),
          ${modelDelayMs}
        );
        timer.unref();
        call.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(call.signal.reason); });
      });
    const classifier = createGuestIntentClassifier({ complete, modelId: "fake", timeoutMs: ${timeoutMs} });
    const items = [
      { message: "hello there", intent: "greeting", tags: [] },
      { message: "Habari gani", intent: "greeting", tags: [] },
      { message: "sugar", intent: "search", query: ["sugar"], tags: [] }
    ];
    const rows = await scoreClassifier(items, classifier, () => ({ intent: "search", query: "sugar" }), 2);
    const summary = summarize(rows);
    console.log(JSON.stringify({ sources: rows.map((row) => row.source), failures: summary.failures }));
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000
  });
}

describe("guest intent eval scoring loop", () => {
  it("settles every call when the model answers slowly within the limit", () => {
    const result = runScoring(300, 2_000);
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toEqual({
      sources: ["model", "model", "model"],
      failures: {}
    });
  }, 70_000);

  it("settles every call as a timeout when the model is slower than the limit", () => {
    const result = runScoring(30_000, 200);
    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({
      sources: ["rules_fallback", "rules_fallback", "rules_fallback"],
      failures: { model_timeout: 3 }
    });
  }, 70_000);
});
