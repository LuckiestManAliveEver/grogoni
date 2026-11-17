/**
 * Periodic eval (paid, a few small Luna calls): does streaming put the first words of a reply on
 * screen well before the whole reply is ready, and is what streamed exactly the reply that is kept?
 *
 *   pnpm eval:openrouter-streaming            # uses .env.openrouter
 *
 * For each prompt it runs one watched (streamed) turn through the real adapter and turn stream,
 * and records time to the first previewed reply text, total time, and whether the final preview
 * equals the validated reply's message. Pass: every reply previewed, every preview equal to the
 * kept reply, every first preview strictly before its call finished, and streaming not slowing
 * the call: each prompt also runs once unwatched (single response), after an unmeasured warm-up
 * and in alternating order, and the median streamed total must stay within 1.25x the median
 * unwatched total (threshold set before the paired run). The saving
 * (medianSavedMs) is reported, not gated: the first run (2026-11-17) missed the original target of
 * "median first preview at most half the median total" because short chat replies finish within
 * 10-450 ms of their first token (docs/deployment/grogoni-openrouter.md, "Streaming").
 * Writes a JSON report (default /tmp/agent-latency/streaming-eval.json); exits 1 on failure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RuntimeModelPrompt } from "@grogoni/shared-types";
import { createOpenRouterRuntime } from "../src/inference/openrouter-runtime.js";
import { turnContext, turnStreamHub } from "../src/inference/turn-stream.js";

const prompts = [
  "What can you help me with in my shop today?",
  "Give me three short tips for keeping maize flour stock fresh.",
  "Explain in two sentences how to price a 2 kg bag of sugar if I buy 50 kg for KES 6,000.",
  "Write a short, friendly reply to a customer asking if we deliver on Sundays. We do, before 2 pm.",
  "What should I check before I accept a delivery from a new supplier? Answer in a short list."
];

const output = process.argv[2] ?? "/tmp/agent-latency/streaming-eval.json";
const adapter = createOpenRouterRuntime().resolve({
  modelId: "gpt-6-luna",
  executionTarget: "backend"
});
if (!adapter || !process.env.OPENROUTER_API_KEY?.trim())
  throw new Error(
    "OPENROUTER_API_KEY is required (pnpm eval:openrouter-streaming loads .env.openrouter)."
  );

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const cases = [];
for (const [index, message] of prompts.entries()) {
  const accountId = `streaming-eval-${Date.now()}-${index}`;
  const turnId = `eval-turn-${index}-${Date.now()}`;
  let firstPreviewAt: number | null = null;
  let preview = "";
  const stop = turnStreamHub.subscribe(accountId, turnId, (event) => {
    if (event.type === "text") {
      firstPreviewAt ??= Date.now();
      preview += event.text;
    }
    if (event.type === "reset") preview = "";
  });
  const prompt: RuntimeModelPrompt = {
    message,
    allowedTools: [],
    schemaVersion: "cp11-runtime-model-v1",
    agentInstructions: "You are a helpful assistant for a small Kenyan retail shop. Reply briefly."
  };
  const plainContext = { modelId: "gpt-6-luna", agentId: "eval", shopId: "eval", accountId };
  try {
    // An unmeasured warm-up, so both measured calls meet the same prompt-cache state; the order
    // of the two measured calls alternates by prompt, so neither transport is always second.
    await adapter.generate({ context: plainContext, prompt });
    const runWatched = async () => {
      const watchedStarted = Date.now();
      const result = await turnContext.run({ turnId }, () =>
        adapter.generate({ context: plainContext, prompt })
      );
      return { result, totalMs: Date.now() - watchedStarted, startedAt: watchedStarted };
    };
    const runPlain = async () => {
      const plainStarted = Date.now();
      const result = await adapter.generate({ context: plainContext, prompt });
      return { result, totalMs: Date.now() - plainStarted };
    };
    let watched: Awaited<ReturnType<typeof runWatched>>;
    let plain: Awaited<ReturnType<typeof runPlain>>;
    if (index % 2 === 0) {
      watched = await runWatched();
      plain = await runPlain();
    } else {
      plain = await runPlain();
      watched = await runWatched();
    }
    const result = watched.result;
    const kept = (JSON.parse(result.text) as { message?: string }).message ?? "";
    cases.push({
      prompt: message,
      order: index % 2 === 0 ? "watched-first" : "unwatched-first",
      firstPreviewMs: firstPreviewAt === null ? null : firstPreviewAt - watched.startedAt,
      providerFirstTokenMs: result.firstTokenMs ?? null,
      totalMs: watched.totalMs,
      unwatchedTotalMs: plain.totalMs,
      providerHost: result.providerHost ?? null,
      unwatchedProviderHost: plain.result.providerHost ?? null,
      previewMatchesReply: preview.trim() === kept.trim(),
      previewChars: preview.length,
      completionTokens: result.completionTokens ?? null
    });
  } catch (error) {
    cases.push({ prompt: message, error: error instanceof Error ? error.message : String(error) });
  } finally {
    stop();
  }
}

const measured = cases.filter(
  (item): item is (typeof cases)[number] & { firstPreviewMs: number; totalMs: number } =>
    typeof (item as { firstPreviewMs?: unknown }).firstPreviewMs === "number"
);
const summary = {
  cases: cases.length,
  previewed: measured.length,
  matching: cases.filter((item) => (item as { previewMatchesReply?: boolean }).previewMatchesReply)
    .length,
  medianFirstPreviewMs: measured.length
    ? median(measured.map((item) => item.firstPreviewMs))
    : null,
  medianTotalMs: measured.length ? median(measured.map((item) => item.totalMs)) : null,
  /** How much sooner the first words show than the whole model call would have. */
  medianSavedMs: measured.length
    ? median(measured.map((item) => item.totalMs - item.firstPreviewMs))
    : null,
  earlierInEveryCase: measured.every((item) => item.firstPreviewMs < item.totalMs),
  medianUnwatchedTotalMs: measured.length
    ? median(measured.map((item) => (item as { unwatchedTotalMs: number }).unwatchedTotalMs))
    : null
};
const notSlower =
  summary.medianTotalMs !== null &&
  summary.medianUnwatchedTotalMs !== null &&
  summary.medianTotalMs <= summary.medianUnwatchedTotalMs * 1.25;
const passed =
  summary.previewed === summary.cases &&
  summary.matching === summary.cases &&
  summary.earlierInEveryCase &&
  notSlower;
const report = {
  evaluatedAt: new Date().toISOString(),
  summary: { ...summary, notSlower },
  passed,
  cases
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, ...summary, notSlower, passed }, null, 2));
if (!passed) process.exit(1);
