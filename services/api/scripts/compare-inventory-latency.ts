/**
 * Compares two hosted inventory benchmark reports (pnpm eval:inventory:hosted --output <file>) for
 * a generation-setting change: pass rate per recipe, and model latency / completion tokens per
 * fixture. Deterministic: same reports, same table. Exits 1 when the candidate passes fewer cases
 * than the baseline, so a faster setting can never be accepted at a quality cost.
 *
 *   pnpm exec tsx services/api/scripts/compare-inventory-latency.ts baseline.json candidate.json
 */
import { readFileSync } from "node:fs";

interface ReportCase {
  fixtureId: string;
  status: string;
  modelLatencyMs?: number | null;
  completionTokens?: number | null;
}
interface Report {
  evaluationSettings?: Record<string, unknown>;
  models: { configuration: { id?: string; recipeVersion?: string }; cases: ReportCase[] }[];
}

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath)
  throw new Error("Usage: compare-inventory-latency.ts <baseline.json> <candidate.json>");
const load = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Report;
const baseline = load(baselinePath);
const candidate = load(candidatePath);

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const summarize = (report: Report) => {
  const cases = report.models.flatMap((model) => model.cases);
  const latency = cases.flatMap((item) =>
    typeof item.modelLatencyMs === "number" ? [item.modelLatencyMs] : []
  );
  const tokens = cases.flatMap((item) =>
    typeof item.completionTokens === "number" ? [item.completionTokens] : []
  );
  return {
    settings: report.evaluationSettings ?? {},
    passed: cases.filter((item) => item.status === "PASSED").length,
    cases: cases.length,
    latencyP50Ms: percentile(latency, 50),
    latencyP90Ms: percentile(latency, 90),
    latencyMeanMs: latency.length
      ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length)
      : null,
    completionTokensTotal: tokens.reduce((a, b) => a + b, 0)
  };
};

const before = summarize(baseline);
const after = summarize(candidate);
const change = (a: number | null, b: number | null) =>
  a === null || b === null || a === 0 ? null : `${Math.round(((b - a) / a) * 100)}%`;

console.log(
  JSON.stringify(
    {
      baseline: before,
      candidate: after,
      latencyP50Change: change(before.latencyP50Ms, after.latencyP50Ms),
      latencyP90Change: change(before.latencyP90Ms, after.latencyP90Ms),
      completionTokensChange: change(before.completionTokensTotal, after.completionTokensTotal),
      qualityHeld: after.passed >= before.passed && after.cases === before.cases
    },
    null,
    2
  )
);

console.log("\nrecipe\tfixture\tbaseline ms\tcandidate ms\tbaseline tok\tcandidate tok\tstatus");
for (const [index, model] of candidate.models.entries()) {
  const reference = baseline.models[index];
  for (const item of model.cases) {
    const old = reference?.cases.find((other) => other.fixtureId === item.fixtureId);
    console.log(
      [
        model.configuration.recipeVersion ?? model.configuration.id ?? index,
        item.fixtureId,
        old?.modelLatencyMs ?? "-",
        item.modelLatencyMs ?? "-",
        old?.completionTokens ?? "-",
        item.completionTokens ?? "-",
        `${old?.status ?? "-"} -> ${item.status}`
      ].join("\t")
    );
  }
}

if (!(after.passed >= before.passed && after.cases === before.cases)) process.exit(1);
