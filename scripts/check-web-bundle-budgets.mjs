import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dist = join(process.cwd(), "apps/web/dist");
const manifest = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8"));
const entry = Object.values(manifest).find((item) => item.isEntry);
if (!entry) throw new Error("The web build manifest has no entry chunk.");

const initialFiles = new Set();
collectStaticFiles(entry, initialFiles);
const initialJavaScriptGzip = sumGzip([...initialFiles].filter((file) => file.endsWith(".js")));
const initialCssGzip = sumGzip([...initialFiles].filter((file) => file.endsWith(".css")));
const ownerRoute = Object.values(manifest).find(
  (item) => item.src?.endsWith("src/SokoApplication.tsx") || item.name === "SokoApplication"
);
// Everything opening the owner app downloads beyond the initial page: its chunk plus every chunk
// it statically imports. Measuring the chunk alone would let a split that merely moves code into
// a sibling eager chunk "pass" without saving the user a byte.
const ownerRouteFiles = new Set();
if (ownerRoute) collectStaticFiles(ownerRoute, ownerRouteFiles);
const ownerRouteGzip = sumGzip(
  [...ownerRouteFiles].filter((file) => file.endsWith(".js") && !initialFiles.has(file))
);

const budgets = {
  initialJavaScriptGzip: 250 * 1024,
  initialCssGzip: 50 * 1024,
  ownerRouteGzip: 170 * 1024
};
const measurements = { initialJavaScriptGzip, initialCssGzip, ownerRouteGzip };
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

function collectStaticFiles(chunk, files) {
  files.add(chunk.file);
  for (const css of chunk.css ?? []) files.add(css);
  for (const importedKey of chunk.imports ?? []) {
    const imported = manifest[importedKey];
    if (imported && !files.has(imported.file)) collectStaticFiles(imported, files);
  }
}

function sumGzip(files) {
  return files.reduce((sum, file) => sum + gzipBytes(file), 0);
}

function gzipBytes(file) {
  return gzipSync(readFileSync(join(dist, file))).byteLength;
}

function format(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}
