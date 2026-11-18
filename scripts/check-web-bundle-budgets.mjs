import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { measureWebBundles } from "./web-bundle-measurements.mjs";

const dist = join(process.cwd(), "apps/web/dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8"));
const measurements = measureWebBundles(manifest, gzipBytes);

const budgets = {
  initialJavaScriptGzip: 250 * 1024,
  initialCssGzip: 50 * 1024,
  // Raised from 170 KiB: the owner route measured 183.15 KiB on main *before* this branch, so the
  // old budget was already unmeetable. This branch adds ~0.2 KiB (lazily-loaded commerce panels).
  // Set to 185 KiB to leave a small, explicit headroom rather than a click-through ceiling.
  // Raised to 190 KiB (approved 2026-11-18): instant messaging measured 173.54 KiB before and
  // 188.66 KiB after; the growth is the send/outbox/sync path every chat runs. The next cold
  // candidate to defer, if this needs room again, is CatalogueNestedCard (~6-7 KiB gzip).
  ownerRouteGzip: 190 * 1024
};
const failures = Object.entries(budgets).flatMap(([name, budget]) =>
  measurements[name] > budget
    ? [`${name}: ${format(measurements[name])} exceeds ${format(budget)}`]
    : []
);

console.log(
  JSON.stringify(
    {
      event: "web.bundle_budgets",
      measurements: Object.fromEntries(
        Object.entries(measurements).map(([name, bytes]) => [name, format(bytes)])
      ),
      budgets: Object.fromEntries(
        Object.entries(budgets).map(([name, bytes]) => [name, format(bytes)])
      )
    },
    null,
    2
  )
);

if (failures.length > 0) {
  throw new Error(`Web bundle budgets failed:\n${failures.join("\n")}`);
}

function gzipBytes(file) {
  return gzipSync(readFileSync(join(dist, file))).byteLength;
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}
