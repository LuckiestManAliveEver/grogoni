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
  ownerRouteGzip: 170 * 1024
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
