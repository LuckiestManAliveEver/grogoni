#!/usr/bin/env node
// Opt-in, real-inference probe for services/ai-runtime. Unlike tests/vercel-inference-service.test.ts
// (which mocks the node-llama-cpp/download boundary for fast, deterministic unit coverage), this
// script exercises the actual production request handler - createVercelInferenceHandler from the
// compiled dist build - against a real GGUF file and the real node-llama-cpp native binding. It
// proves the full local pipeline (auth -> validation -> SSRF-guarded download -> sha256/size
// verification -> node-llama-cpp model load -> generation -> NDJSON streaming) actually works, not
// just that TypeScript compiles. It does not deploy anything or touch Vercel/Render/Neon; the
// artifact is served from a throwaway local HTTP server standing in for Neon object storage.
//
// Usage:
//   pnpm --filter @grogoni/ai-runtime build
//   GROGONI_LIVE_GGUF_PATH=/path/to/SmolLM2-360M-Instruct-Q4_0.gguf node scripts/ai-runtime-live-inference-probe.mjs
//
// GROGONI_LIVE_GGUF_PATH must point at a real local GGUF file. This script computes its own sha256/size
// from that file and uses them as the "expected" artifact metadata, so it is intentionally decoupled
// from the production checksum in infra/db/migrations - it verifies the mechanism, not one specific
// upstream file.
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import {
  createVercelHealthHandler,
  createVercelInferenceHandler,
  createVercelReadyHandler,
  readVercelInferenceConfig
} from "../services/ai-runtime/dist/index.js";

const ggufPath = required("GROGONI_LIVE_GGUF_PATH");
const stats = statSync(ggufPath);
const sha256 = await hashFile(ggufPath);
console.log(`Probing against ${ggufPath}`);
console.log(`  size:   ${stats.size} bytes`);
console.log(`  sha256: ${sha256}`);

const token = "live-probe-service-token-at-least-32-characters-long";
const server = createServer((request, response) => {
  if (request.url !== "/model.gguf") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(stats.size)
  });
  createReadStream(ggufPath).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const artifactHostname = "127.0.0.1";
const artifactAuthority = `${artifactHostname}:${address.port}`;
console.log(
  `  serving from http://${artifactAuthority}/model.gguf (local stand-in for Neon storage)`
);

const config = readVercelInferenceConfig({
  GROGONI_INFERENCE_SERVICE_TOKEN: token,
  MODEL_ARTIFACT_ALLOWED_HOSTS: artifactHostname,
  INFERENCE_RUNTIME_CACHE_ENTRIES: "1"
});

let failures = 0;

try {
  // 1. /health - bare liveness.
  const healthResponse = createVercelHealthHandler()();
  assert(healthResponse.status === 200, "/health did not return 200");
  const healthBody = await healthResponse.json();
  assert(healthBody.ok === true, "/health body missing ok:true");
  console.log("PASS /health:", JSON.stringify(healthBody));

  // 2. /ready - configuration-level readiness, no download triggered.
  const readyResponse = createVercelReadyHandler({
    GROGONI_INFERENCE_SERVICE_TOKEN: token,
    MODEL_ARTIFACT_ALLOWED_HOSTS: artifactHostname
  })();
  assert(readyResponse.status === 200, "/ready did not return 200");
  const readyBody = await readyResponse.json();
  assert(readyBody.ready === true, "/ready body missing ready:true");
  console.log("PASS /ready:", JSON.stringify(readyBody));

  // 3. /v1/inference - the real thing: real download, real sha256/size verification, real
  //    node-llama-cpp model load, real generation.
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const buildBody = (requestId) => ({
    requestId,
    conversationId: "live-probe-conversation",
    runtimeBindingId: "live-probe-binding",
    executionHostId: "live-probe-host",
    agent: { id: "live-probe-agent", adapterId: "pi" },
    model: { id: "smollm2-360m-live-probe", runtimeContractVersion: "1" },
    artifact: {
      id: `live-probe:${sha256}`,
      modelId: "smollm2-360m-live-probe",
      storageProvider: "local-http-probe",
      bucket: "live-probe",
      objectKey: "model.gguf",
      format: "gguf",
      quantization: "Q4_0",
      sizeBytes: stats.size,
      sha256,
      contentType: "application/octet-stream",
      status: "available",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      downloadUrl: `https://${artifactAuthority}/model.gguf`,
      expiresAt
    },
    prompt: "Reply with exactly: GROGONI_OK",
    generation: { maxTokens: 16, temperature: 0, jsonOutput: false }
  });
  // The local probe server is plain HTTP; downloadVerifiedArtifact requires https in production,
  // so this probe injects a fetch that rewrites the scheme to reach 127.0.0.1 while still routing
  // through the real handler's real download/verify/load/generate code. The handler is built once
  // and called twice below to prove warm-instance model-cache reuse with the real runtime, not a
  // mock (tests/vercel-inference-service.test.ts already proves this with a mocked runtime).
  const handler = createVercelInferenceHandler(config, {
    request: (url, init) => fetch(String(url).replace("https://", "http://"), init)
  });

  async function callOnce(label) {
    const request = new Request("http://live-probe/v1/inference", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(buildBody(randomUUID()))
    });
    const startedAt = Date.now();
    const response = await handler(request);
    assert(response.status === 200, `${label}: /v1/inference returned HTTP ${response.status}`);
    const events = (await response.text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const errorEvent = events.find((event) => event.type === "error");
    assert(
      errorEvent === undefined,
      `${label}: inference emitted an error event: ${JSON.stringify(errorEvent)}`
    );
    const resultEvent = events.find((event) => event.type === "result");
    assert(resultEvent !== undefined, `${label}: no result event in the NDJSON stream`);
    assert(
      typeof resultEvent.text === "string" && resultEvent.text.length > 0,
      `${label}: result event has no generated text`
    );
    const elapsedMs = Date.now() - startedAt;
    console.log(`PASS ${label} /v1/inference (${elapsedMs}ms):`);
    console.log(`  generated text: ${JSON.stringify(resultEvent.text)}`);
    console.log(`  finishReason:   ${resultEvent.finishReason}`);
    console.log(`  usage:          ${JSON.stringify(resultEvent.usage)}`);
    console.log(`  metrics:        ${JSON.stringify(resultEvent.metrics)}`);
    return resultEvent;
  }

  const first = await callOnce("cold");
  assert(first.metrics.cacheHit === false, "cold call unexpectedly reported cacheHit:true");
  console.log(
    "This proves node-llama-cpp loaded the real GGUF and generated real text - no mock path was used."
  );

  const second = await callOnce("warm");
  assert(second.metrics.cacheHit === true, "second call did not reuse the warm model cache");
  console.log(
    "Second call reused the already-loaded model (cacheHit:true) without re-downloading or " +
      "reloading - proves warm-invocation caching works with the real runtime."
  );
} catch (error) {
  failures += 1;
  console.error("FAIL", error);
} finally {
  server.close();
}

process.exit(failures > 0 ? 1 : 0);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function required(name) {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") {
    console.error(`${name} is required.`);
    process.exit(64);
  }
  return value;
}
