import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Render Blueprint", () => {
  it("wires external Neon URLs into every database consumer and migrates before deploy", async () => {
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");

    expect(blueprint).not.toContain("\ndatabases:");
    expect(blueprint).not.toContain("fromDatabase:");
    expect(blueprint).toContain("CP2_STORE\n        value: postgres");
    expect(blueprint).toContain("name: grogoni\n    runtime: node");
    expect(blueprint).toContain("plan: starter");
    expect(blueprint).toMatch(
      /domains:\n\s+- grogoni\.com\n(?:.|\n)*?\s+- api\.grogoni\.com\n(?:.|\n)*?\s+- "\*\.grogoni\.com"/u
    );
    // build:production runs (and gates on) a clean compile before db:migrate, not after: a
    // destructive migration must never commit against the shared production database ahead of a
    // build that turns out not to compile - see docs/architecture/native-runtime-deployment.md §3.
    expect(blueprint).toContain(
      "buildCommand: COREPACK_HOME=/tmp/corepack corepack pnpm install --frozen-lockfile && COREPACK_HOME=/tmp/corepack corepack pnpm build:production && COREPACK_HOME=/tmp/corepack corepack pnpm db:migrate && REQUIRE_NEON_DATABASE=true COREPACK_HOME=/tmp/corepack corepack pnpm db:verify-schema"
    );
    expect(blueprint).not.toContain("preDeployCommand:");
    expect(blueprint.match(/key: DATABASE_URL\n\s+sync: false/g)?.length).toBeGreaterThanOrEqual(4);
    expect(
      blueprint.match(/key: DIRECT_DATABASE_URL\n\s+sync: false/g)?.length
    ).toBeGreaterThanOrEqual(4);
    expect(blueprint).toContain("name: grogoni-account-purge");
    expect(blueprint).toContain("corepack pnpm db:purge-accounts");
    expect(blueprint).toContain("key: ACCOUNT_DELETION_PROCESSORS_JSON\n        sync: false");
    expect(blueprint).toContain("key: ACCOUNT_DELETION_WEBHOOK_SECRET\n        sync: false");
  });

  it("declares authentication dependencies without SMS verification", async () => {
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
    const api = blueprint.slice(
      blueprint.indexOf("name: grogoni"),
      blueprint.indexOf("name: grogoni-rate-limit-cache")
    );

    for (const continuitySecret of [
      "PASSWORD_HASH_SECRET",
      "AUTH_AUDIT_HMAC_SECRET",
      "OTP_HMAC_SECRET",
      "PIN_HASH_SECRET",
      "AUTH_TOKEN_ENCRYPTION_KEY",
      "GROGONI_INFERENCE_SERVICE_TOKEN"
    ]) {
      expect(api).toContain(`${continuitySecret}\n        sync: false`);
      expect(api).not.toContain(`${continuitySecret}\n        generateValue: true`);
    }
    expect(api).toContain("RESEND_API_KEY\n        sync: false");
    expect(api).not.toMatch(/AUTH_SMS|SMS_GATEWAY|ANDROID_SMS|LOCAL_SMS/u);
    expect(api).toContain('GROGONI_EMAIL_FROM\n        value: "Grogoni <messages@grogoni.com>"');
  });

  it("routes inference to Vercel instead of hosting it on Render", async () => {
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
    const rootManifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };
    const staging = blueprint.slice(blueprint.indexOf("name: grogoni-web-staging"));
    const production = blueprint.slice(
      blueprint.indexOf("name: grogoni"),
      blueprint.indexOf("name: grogoni-rate-limit-cache")
    );
    const api = blueprint.slice(
      blueprint.indexOf("name: grogoni"),
      blueprint.indexOf("name: grogoni-rate-limit-cache")
    );

    expect(staging).toContain("VITE_DEPLOYMENT_ENV\n        value: staging");
    expect(staging).toContain("Content-Security-Policy");
    expect(staging).toContain("Cross-Origin-Embedder-Policy");
    expect(staging).toContain("Cross-Origin-Opener-Policy");
    expect(production).toContain("VITE_API_BASE_URL\n        value: https://grogoni.com");
    expect(production).toContain("apps/web/**");
    expect(blueprint).not.toMatch(/name: grogoni-web\n\s+runtime: static/u);
    // Browser-local inference was retired (see
    // docs/adr/ADR-device-independent-runtime-and-registry-discovery.md): the browser never talks
    // to GitHub/Hugging Face or runs WASM directly, so neither the client-inference feature flags
    // nor the CSP allowances they required belong in the Blueprint anymore.
    expect(blueprint).not.toContain("VITE_BROWSER_LOCAL_INFERENCE_ENABLED");
    expect(blueprint).not.toContain("VITE_INFERENCE_CLIENT_FIRST");
    expect(blueprint).not.toContain("VITE_INFERENCE_BROWSER_WEBGPU_ENABLED");
    expect(blueprint).not.toContain("VITE_INFERENCE_BROWSER_WASM_ENABLED");
    expect(blueprint).not.toContain("VITE_INFERENCE_NATIVE_BRIDGE_ENABLED");
    expect(blueprint).not.toContain("wasm-unsafe-eval");
    expect(blueprint).not.toContain("huggingface.co");
    expect(blueprint).not.toContain("raw.githubusercontent.com");
    expect(blueprint).not.toContain("LOCAL_MODEL_");
    expect(blueprint).toContain("corepack pnpm build:production");
    expect(rootManifest.scripts["build:production"]).toContain("check:render-inference-boundaries");

    // Render no longer hosts a private inference service - Vercel executes inference
    // (docs/architecture/inference-runtime.md), so none of the old inference private-service/
    // Docker/disk machinery may appear in the Blueprint at all. A private service is not banned
    // outright, though: grogoni-ocr-worker (docs/receipt-ocr.md) is a legitimate `type: pserv`
    // for a bounded OCR tool, not a model runtime, and check:render-inference-boundaries already
    // guards the API service block specifically against reintroducing `type: pserv` there.
    expect(blueprint).not.toContain("grogoni-inference");
    expect(blueprint).not.toContain("dockerfilePath: ./services/ai-runtime/Dockerfile");
    expect(blueprint).not.toContain("mountPath: /var/lib/grogoni-models");
    expect(blueprint).not.toMatch(/type: pserv\n\s+name: grogoni-inference/u);
    expect(blueprint).not.toContain("BACKEND_INFERENCE_ENABLED");
    expect(blueprint).not.toContain("BACKEND_INFERENCE_BASE_URL");
    expect(blueprint).not.toContain("BACKEND_INFERENCE_MODEL_ID");
    expect(blueprint).not.toContain("GROGONI_PRIMARY_PROVIDER_MODEL_ID");
    expect(blueprint).not.toContain("OLLAMA_KEEP_ALIVE");
    expect(blueprint).not.toContain("key: INFERENCE_SERVICE_TOKEN");
    expect(blueprint).not.toContain("VITE_INFERENCE_SERVICE_TOKEN");
    expect(blueprint).not.toContain("VITE_NEON_MODEL_STORAGE");
    expect(blueprint).not.toContain("VITE_VERCEL_INFERENCE");

    // The API service proxies to Vercel over a shared bearer token and mints signed Neon
    // artifact URLs; it never runs llama.cpp/Ollama itself.
    expect(api).not.toContain("OLLAMA_BASE_URL");
    expect(api).not.toContain("llama.cpp");
    expect(api).not.toContain(".gguf");
    expect(api).toContain("key: VERCEL_INFERENCE_URL");
    expect(api).toContain("key: GROGONI_INFERENCE_SERVICE_TOKEN");
    expect(api).toContain("GROGONI_INFERENCE_SERVICE_TOKEN\n        sync: false");
    expect(api).toContain("key: NEON_MODEL_STORAGE_ENDPOINT");
    expect(api).toContain("key: NEON_MODEL_STORAGE_ACCESS_KEY_ID");
    expect(api).toContain("key: NEON_MODEL_STORAGE_SECRET_ACCESS_KEY");
    expect(api).toContain('INFERENCE_REQUIRED\n        value: "true"');
    // The default model (GPT-6 Luna) is provider-routed on the backend target; Vercel still hosts
    // the self-hosted models a shop can choose.
    expect(api).toContain("PLATFORM_DEFAULT_EXECUTION_TARGET\n        value: backend");
    expect(api).toContain("PLATFORM_DEFAULT_MODEL_ID\n        value: gpt-6-luna");
    expect(api).toContain("INFERENCE_DEFAULT_MODEL\n        value: gpt-6-luna");
    expect(api).toContain("PLATFORM_DEFAULT_AGENT_ADAPTER_ID\n        value: zeroclaw");

    expect(blueprint).toContain('INFERENCE_OWNER_NODE_ENABLED\n        value: "true"');
    expect(blueprint).not.toContain("INFERENCE_CLOUD_FALLBACK_ENABLED");
    expect(blueprint).toContain("INFERENCE_JOB_SIGNING_SECRET\n        generateValue: true");
    expect(production).toContain('VITE_INFERENCE_OWNER_NODE_ENABLED\n        value: "true"');
    expect(production).toContain('VITE_INFERENCE_MAX_FALLBACKS\n        value: "3"');
  });

  it("deploys ZeroClaw as a locked-down private agent runtime wired to the API", async () => {
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
    const api = blueprint.slice(
      blueprint.indexOf("name: grogoni"),
      blueprint.indexOf("name: grogoni-rate-limit-cache")
    );
    const zeroclaw = blueprint.slice(
      blueprint.indexOf("name: grogoni-zeroclaw\n"),
      blueprint.indexOf("name: grogoni-web-staging")
    );
    expect(blueprint).toMatch(/type: pserv\n\s+name: grogoni-zeroclaw\n/u);
    expect(zeroclaw).toContain("url: ghcr.io/zeroclaw-labs/zeroclaw:v0.8.5");
    // Text only: no ZeroClaw tools, read-only, no cross-turn session memory.
    expect(zeroclaw).toContain("ZEROCLAW_risk_profiles__default__level\n        value: readonly");
    expect(zeroclaw).toContain(
      'ZEROCLAW_risk_profiles__default__deny_all_tools\n        value: "true"'
    );
    expect(zeroclaw).toContain('ZEROCLAW_gateway__session_persistence\n        value: "false"');
    expect(zeroclaw).toContain("ZEROCLAW_gateway__webhook_secret\n        generateValue: true");
    expect(zeroclaw).toContain(
      "ZEROCLAW_providers__models__openai__default__model\n        value: gpt-6-luna"
    );
    expect(zeroclaw).toContain(
      "ZEROCLAW_providers__models__openai__default__api_key\n        sync: false"
    );
    expect(api).toContain("envVarKey: ZEROCLAW_gateway__webhook_secret");
    expect(api).toMatch(/ZEROCLAW_GATEWAY_URL\n\s+fromService:\n\s+name: grogoni-zeroclaw/u);
  });

  it("deploys the OCR worker as a private service and wires the API to it", async () => {
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
    const api = blueprint.slice(
      blueprint.indexOf("name: grogoni"),
      blueprint.indexOf("name: grogoni-rate-limit-cache")
    );
    // The API's fromService reference to this worker (asserted below) textually precedes the
    // worker's own service block, so anchor on the block header itself rather than a bare
    // `indexOf("name: grogoni-ocr-worker")`, which would match that earlier reference first.
    const ocrWorkerStart = blueprint.indexOf("- type: pserv\n    name: grogoni-ocr-worker");
    const nextService = blueprint.indexOf("\n  - type:", ocrWorkerStart + 1);
    const ocrWorker = blueprint.slice(ocrWorkerStart, nextService === -1 ? undefined : nextService);

    expect(ocrWorkerStart).toBeGreaterThan(-1);
    expect(ocrWorker).toContain("runtime: docker");
    expect(ocrWorker).toContain("dockerfilePath: ./services/receipt-ocr-service/Dockerfile");
    expect(ocrWorker).toContain("dockerContext: ./services/receipt-ocr-service");
    expect(ocrWorker).toContain('key: OCR_WORKER_PORT\n        value: "8090"');
    expect(ocrWorker).toContain("key: OCR_ENGINE_PRIMARY\n        value: paddleocr");

    // The API resolves OCR_WORKER_URL from the worker's private-network address rather than a
    // manually pasted URL - see the http:// normalization in services/api/src/cp2/ocr-provider.ts
    // for the "hostport" -> URL translation this requires.
    expect(api).toMatch(
      /key: OCR_WORKER_URL\n\s+fromService:\n\s+name: grogoni-ocr-worker\n\s+type: pserv\n\s+property: hostport/u
    );
  });
});
