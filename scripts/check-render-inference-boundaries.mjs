// The API never loads or runs a model in-process: server-side generation goes to Ollama over HTTP
// (OLLAMA_BASE_URL, docs/local-first-cloud-audit.md) and device-local models run on members' own
// devices. This script fails the build if API code depends on an in-process inference engine, or if
// the Render Blueprint reintroduces a hosted inference, agent-runtime or OCR service that the
// local-first runtime retired.
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";

const apiManifest = JSON.parse(readFileSync("services/api/package.json", "utf8"));
const dependencyNames = Object.keys(apiManifest.dependencies ?? {});
const blockedDependencies = [
  "node-llama-cpp",
  "llama-node",
  "@huggingface/transformers",
  "onnxruntime-node",
  "onnxruntime-web",
  "ollama"
];
const blockedImportPatterns = [
  /^@grogoni\/ai-runtime\/(?:src|local-model|ollama-model|llama-runtime|artifact-loader)(?:\/|$)/u,
  /(?:^|\/)(?:local-model|ollama-model|browser-model\.worker|llama-runtime|artifact-loader)(?:\.js)?$/u,
  /(?:llama|gguf).*(?:loader|worker|binding)/iu
];
const importPatterns = [
  /\bimport\s+(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
];
const violations = dependencyNames
  .filter((dependency) => blockedDependencies.includes(dependency))
  .map((dependency) => `services/api/package.json depends on ${dependency}`);

for (const root of ["services/api/src", "services/api/dist"]) {
  for (const file of listCodeFiles(root)) {
    const source = readFileSync(file, "utf8");
    if (source.includes("LOCAL_MODEL_")) {
      violations.push(`${relative(process.cwd(), file)} reads Render-local inference settings`);
    }
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1] ?? "";
        if (blockedImportPatterns.some((blocked) => blocked.test(specifier))) {
          violations.push(`${relative(process.cwd(), file)} imports ${specifier}`);
        }
      }
    }
  }
}

const blueprint = readFileSync("render.yaml", "utf8");

// The Render Blueprint must not declare a hosted inference, ZeroClaw, or OCR service of any kind.
const forbiddenBlueprintMarkers = [
  "grogoni-inference",
  "services/ai-runtime/Dockerfile",
  "BACKEND_INFERENCE_ENABLED",
  "BACKEND_INFERENCE_BASE_URL",
  "BACKEND_INFERENCE_MODEL_ID",
  "mountPath: /var/lib/grogoni-models",
  "OLLAMA_KEEP_ALIVE",
  "INFERENCE_ENGINE",
  "key: INFERENCE_SERVICE_TOKEN",
  "grogoni-zeroclaw",
  "ghcr.io/zeroclaw-labs/zeroclaw",
  "grogoni-ocr-worker",
  "services/receipt-ocr-service"
];
for (const forbidden of forbiddenBlueprintMarkers) {
  if (blueprint.includes(forbidden)) {
    violations.push(
      `Render Blueprint still declares the retired Render-hosted inference marker ${forbidden}`
    );
  }
}

const apiStart = blueprint.indexOf("name: grogoni");
const nextService = blueprint.indexOf("\n  - type:", apiStart);
const apiService = blueprint.slice(apiStart, nextService === -1 ? undefined : nextService);

// The API service must never be configured to load a model itself.
for (const forbidden of ["LOCAL_MODEL_", "llama.cpp", ".gguf", "OLLAMA_BASE_URL"]) {
  if (apiService.toLowerCase().includes(forbidden.toLowerCase())) {
    violations.push(`Render API service contains forbidden local-inference marker ${forbidden}`);
  }
}
// The API service itself must stay `type: web`, not a private service - checked as an adjacency,
// not a bare `apiService.includes("type: pserv")`, so a `fromService: { type: pserv }` reference in
// its envVars does not trip it.
if (!/-\s+type:\s*web\s*\n\s*name:\s*grogoni/u.test(blueprint)) {
  violations.push("Render API service must declare `type: web`, not a private service (pserv).");
}
// Environment settings retired by the API must not be provisioned by the Blueprint.
const apiConfig = readFileSync("services/api/src/config.ts", "utf8");
const removedSettings = apiConfig.match(/const removed = \[([\s\S]*?)\]\.filter/u)?.[1] ?? "";
for (const match of removedSettings.matchAll(/"([A-Z][A-Z0-9_]*)"/gu)) {
  if (apiService.includes(`key: ${match[1]}\n`)) {
    violations.push(`Render API service declares retired environment setting ${match[1]}`);
  }
}

// The browser must never receive an inference service token or model-storage credentials.
for (const forbidden of [
  "VITE_INFERENCE_SERVICE_TOKEN",
  "VITE_GROGONI_INFERENCE_SERVICE_TOKEN",
  "VITE_NEON_MODEL_STORAGE",
  "VITE_VERCEL_INFERENCE"
]) {
  if (blueprint.includes(forbidden)) {
    violations.push(`The browser must never receive ${forbidden}`);
  }
}

if (violations.length > 0) {
  console.error("Render inference boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Runtime deployment boundaries verified; retired API cloud settings are not provisioned."
);

function listCodeFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listCodeFiles(path);
    return entry.isFile() && [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(entry.name))
      ? [path]
      : [];
  });
}
