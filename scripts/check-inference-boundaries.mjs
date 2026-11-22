// The API never loads or runs a model in-process: server-side generation goes to Ollama over HTTP
// (OLLAMA_BASE_URL, docs/local-first-cloud-audit.md) and device-local models run on members' own
// devices. This script fails the build if API code depends on an in-process inference engine, or if
// the deploy configuration (vercel.json) would hand the browser an inference or model-storage secret.
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
      violations.push(
        `${relative(process.cwd(), file)} reads retired local-model inference settings`
      );
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

const deployConfig = readFileSync("vercel.json", "utf8");

// The deploy configuration must not bring back a hosted inference, ZeroClaw or OCR service.
for (const forbidden of [
  "grogoni-inference",
  "BACKEND_INFERENCE_ENABLED",
  "BACKEND_INFERENCE_BASE_URL",
  "BACKEND_INFERENCE_MODEL_ID",
  "OLLAMA_KEEP_ALIVE",
  "INFERENCE_ENGINE",
  "INFERENCE_SERVICE_TOKEN",
  "LOCAL_MODEL_",
  "VITE_INFERENCE_CLIENT_FIRST",
  "zeroclaw",
  "ocr-worker",
  "receipt-ocr-service"
]) {
  if (deployConfig.toLowerCase().includes(forbidden.toLowerCase())) {
    violations.push(`vercel.json contains the retired inference marker ${forbidden}`);
  }
}
// Settings the API refuses at boot (config.ts rejectRemovedCloudConfiguration) must not be set.
const apiConfig = readFileSync("services/api/src/config.ts", "utf8");
const removedSettings = apiConfig.match(/const removed = \[([\s\S]*?)\]\.filter/u)?.[1] ?? "";
for (const match of removedSettings.matchAll(/"([A-Z][A-Z0-9_]*)"/gu)) {
  if (deployConfig.includes(`"${match[1]}"`)) {
    violations.push(`vercel.json sets retired environment setting ${match[1]}`);
  }
}

// The browser must never receive an inference service token or model-storage credentials.
for (const forbidden of [
  "VITE_INFERENCE_SERVICE_TOKEN",
  "VITE_GROGONI_INFERENCE_SERVICE_TOKEN",
  "VITE_NEON_MODEL_STORAGE",
  "VITE_VERCEL_INFERENCE"
]) {
  if (deployConfig.includes(forbidden)) {
    violations.push(`The browser must never receive ${forbidden}`);
  }
}

if (violations.length > 0) {
  console.error("Inference boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Inference boundaries verified: no in-process model engine, no inference secret sent to the browser."
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
