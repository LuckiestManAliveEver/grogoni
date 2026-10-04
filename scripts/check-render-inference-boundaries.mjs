// Render is the control plane; it authenticates, resolves runtime bindings, and proxies inference
// requests to Vercel over HTTPS with a shared bearer token - it must never load or run a model
// itself (docs/architecture/inference-runtime.md). This script fails the build if that boundary
// is crossed in either direction: Render code depending on a local inference engine, or the
// Render Blueprint reintroducing a Render-hosted inference service.
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

// The inverse boundary: services/ai-runtime is a standalone Vercel deployment that executes
// inference only. It must never import Render's application code (auth, commerce APIs, database
// business logic, agent orchestration, MCP, messaging) or the web app - if it did, `vercel build`
// would either fail (services/api/apps/web aren't installed in the Vercel project) or silently
// bundle application code into the inference deployment.
const aiRuntimeManifest = JSON.parse(readFileSync("services/ai-runtime/package.json", "utf8"));
const allowedAiRuntimeDependencies = new Set(["@grogoni/shared-types", "node-llama-cpp"]);
for (const dependency of Object.keys(aiRuntimeManifest.dependencies ?? {})) {
  if (!allowedAiRuntimeDependencies.has(dependency)) {
    violations.push(
      `services/ai-runtime/package.json depends on ${dependency}, which is outside the ` +
        `narrow allowlist (${[...allowedAiRuntimeDependencies].join(", ")})`
    );
  }
}
const aiRuntimeForbiddenImportPatterns = [
  /(^|\/)services\/api(\/|$)/u,
  /(^|\/)apps\/web(\/|$)/u,
  /^(\.\.\/)+api\//u,
  /^(\.\.\/)+web\//u
];
for (const root of ["services/ai-runtime/src", "services/ai-runtime/api"]) {
  for (const file of listCodeFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1] ?? "";
        if (aiRuntimeForbiddenImportPatterns.some((blocked) => blocked.test(specifier))) {
          violations.push(
            `${relative(process.cwd(), file)} imports ${specifier}, crossing the ` +
              "Vercel inference deployment boundary into Render/web application code"
          );
        }
      }
    }
  }
}

const blueprint = readFileSync("render.yaml", "utf8");

// The Render Blueprint must no longer declare a Render-hosted inference service of any kind.
const forbiddenBlueprintMarkers = [
  "grogoni-inference",
  "services/ai-runtime/Dockerfile",
  "BACKEND_INFERENCE_ENABLED",
  "BACKEND_INFERENCE_BASE_URL",
  "BACKEND_INFERENCE_MODEL_ID",
  "mountPath: /var/lib/grogoni-models",
  "OLLAMA_KEEP_ALIVE",
  "INFERENCE_ENGINE",
  "key: INFERENCE_SERVICE_TOKEN"
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

// The API service must resolve inference through Vercel, never a local model engine.
for (const forbidden of ["LOCAL_MODEL_", "llama.cpp", ".gguf", "OLLAMA_BASE_URL"]) {
  if (apiService.toLowerCase().includes(forbidden.toLowerCase())) {
    violations.push(`Render API service contains forbidden local-inference marker ${forbidden}`);
  }
}
// The API service itself must stay `type: web`, not a private service - checked as an adjacency,
// not a bare `apiService.includes("type: pserv")`, because the API's envVars legitimately contain
// that substring inside a `fromService: { type: pserv }` reference to another private service (the
// OCR worker, docs/receipt-ocr.md), which is not this boundary's concern.
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

// The browser must never receive the inference service token or the Neon object-storage
// credentials that let Render mint signed model-artifact download URLs.
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
