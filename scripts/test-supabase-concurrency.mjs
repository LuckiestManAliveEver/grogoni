import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

if (!process.argv.includes("--live")) throw new Error("Pass --live to run read-only load probes.");
const base =
  process.env.SMOKE_API_URL ??
  "https://gnmndzsughifhboqvsgd.supabase.co/functions/v1/api-candidate";
const region = process.env.SMOKE_EDGE_REGION ?? "us-east-1";
const maxP95 = Number(process.env.SMOKE_MAX_P95_MS ?? 5000);
async function probe(path) {
  const url = new URL(base + path);
  if (url.hostname.endsWith(".supabase.co")) url.searchParams.set("forceFunctionRegion", region);
  const started = performance.now();
  const response = await fetch(url, {
    headers: { "x-region": region },
    signal: globalThis.AbortSignal.timeout(30000)
  });
  await response.json();
  return {
    status: response.status,
    ms: Math.round(performance.now() - started),
    region: response.headers.get("x-sb-edge-region")
  };
}
for (const path of ["/health", "/public/storefronts"]) {
  assert.equal((await probe(path)).status, 200);
  for (const count of [10, 25]) {
    const results = await Promise.all(Array.from({ length: count }, () => probe(path)));
    const sorted = results.map((result) => result.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(count * 0.95) - 1];
    console.log(
      JSON.stringify({
        path,
        concurrent: count,
        failures: results.filter((result) => result.status !== 200).length,
        medianMs: sorted[Math.floor(count / 2)],
        p95Ms: p95,
        maxMs: sorted.at(-1),
        regions: [...new Set(results.map((result) => result.region))]
      })
    );
    assert.ok(
      results.every((result) => result.status === 200),
      "Concurrent requests must all succeed."
    );
    assert.ok(p95 <= maxP95, `${path} p95 ${p95}ms exceeds ${maxP95}ms`);
  }
}
