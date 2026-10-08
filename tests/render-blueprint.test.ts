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
      "AUTH_TOKEN_ENCRYPTION_KEY"
    ]) {
      expect(api).toContain(`${continuitySecret}\n        sync: false`);
      expect(api).not.toContain(`${continuitySecret}\n        generateValue: true`);
    }
    // Hosted transactional email (Resend) was retired with the cloud providers; the API rejects
    // RESEND_API_KEY at boot, so the Blueprint must not provision it.
    expect(api).not.toContain("RESEND_API_KEY");
    expect(api).not.toMatch(/AUTH_SMS|SMS_GATEWAY|ANDROID_SMS|LOCAL_SMS/u);
    // The passkey RP ID must be the registrable domain of every expected origin, or
    // readAuthRuntimeConfig refuses to boot (regression: the rename left it as "grogoni").
    expect(api).toContain("WEBAUTHN_RP_ID\n        value: grogoni.com\n");
    expect(api).toContain('GROGONI_EMAIL_FROM\n        value: "Grogoni <messages@grogoni.com>"');
  });

  it("runs inference through local Ollama defaults and provisions no hosted inference", async () => {
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

    // No hosted inference service of any kind: server-side generation goes to Ollama
    // (docs/local-first-cloud-audit.md), so none of the old inference private-service/Docker/disk
    // machinery may appear in the Blueprint at all.
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

    // The API never runs a model in-process and never reaches a hosted inference service: no
    // Vercel, Neon model storage, or hosted provider settings are provisioned.
    expect(api).not.toContain("llama.cpp");
    expect(api).not.toContain(".gguf");
    for (const retired of [
      "VERCEL_INFERENCE_URL",
      "GROGONI_INFERENCE_SERVICE_TOKEN",
      "NEON_MODEL_STORAGE_",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ZAI_API_KEY",
      "ZEROCLAW_",
      "INFERENCE_CREDENTIAL_KEYS",
      "gpt-6-luna"
    ]) {
      expect(api, retired).not.toContain(retired);
    }
    expect(api).toContain('INFERENCE_REQUIRED\n        value: "true"');
    // Same platform default as local mode: Shopkeeper on Grogoni's engine with SmolLM2 360M.
    expect(api).toContain("PLATFORM_DEFAULT_EXECUTION_TARGET\n        value: local");
    expect(api).toContain("PLATFORM_DEFAULT_MODEL_ID\n        value: smollm2-360m");
    expect(api).toContain("INFERENCE_DEFAULT_MODEL\n        value: smollm2-360m");
    expect(api).toContain("PLATFORM_DEFAULT_AGENT_ADAPTER_ID\n        value: grogoni");

    expect(blueprint).toContain('INFERENCE_OWNER_NODE_ENABLED\n        value: "true"');
    expect(blueprint).not.toContain("INFERENCE_CLOUD_FALLBACK_ENABLED");
    expect(blueprint).toContain("INFERENCE_JOB_SIGNING_SECRET\n        generateValue: true");
    expect(production).toContain('VITE_INFERENCE_OWNER_NODE_ENABLED\n        value: "true"');
    expect(production).toContain('VITE_INFERENCE_MAX_FALLBACKS\n        value: "3"');
  });

  it("provisions no retired ZeroClaw or OCR worker services", async () => {
    // Both were removed with the local-first runtime (docs/local-first-cloud-audit.md): the API
    // rejects ZEROCLAW_* and OCR_WORKER_URL at boot and no code talks to either service.
    const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
    for (const retired of [
      "grogoni-zeroclaw",
      "ghcr.io/zeroclaw-labs/zeroclaw",
      "grogoni-ocr-worker",
      "services/receipt-ocr-service",
      "OCR_WORKER_URL"
    ]) {
      expect(blueprint, retired).not.toContain(retired);
    }
  });
});
