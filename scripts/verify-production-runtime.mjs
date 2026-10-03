const apiUrl = required("GROGONI_API_URL").replace(/\/+$/u, "");
const inferenceUrl = required("VERCEL_INFERENCE_URL").replace(/\/+$/u, "");
const sessionToken = required("GROGONI_TEST_TOKEN");
const shopId = required("GROGONI_TEST_SHOP_ID");
const modelId = process.env.GROGONI_MODEL_ID?.trim() || "smollm2-360m";
const cookie = sessionToken.includes("=") ? sessionToken : `grogoni_session=${sessionToken}`;

const apiReadiness = await getJson(`${apiUrl}/health/ready`);
assert(apiReadiness.response.ok, "API readiness failed.", apiReadiness.body);
assert(
  apiReadiness.body?.database?.ok === true,
  "Neon database readiness failed.",
  apiReadiness.body
);

// Vercel's own /health only proves the deployment is live - it has no artifact/model context of
// its own, so it never requires the service token. Real model readiness is proven end-to-end
// below via Render's /health/ai and a real chat turn.
const inferenceLiveness = await getJson(`${inferenceUrl}/health`);
assert(
  inferenceLiveness.response.ok && inferenceLiveness.body?.ok === true,
  "Vercel inference liveness failed.",
  inferenceLiveness.body
);

const probe = await getJson(`${apiUrl}/health/ai`);
assert(
  probe.response.ok &&
    probe.body?.status === "ready" &&
    probe.body?.model?.status === "ready" &&
    probe.body?.model?.model === modelId,
  "Real end-to-end model probe (Render -> Vercel) failed.",
  probe.body
);

const effectiveRuntime = await getJson(
  `${apiUrl}/businesses/${encodeURIComponent(shopId)}/runtime/effective`,
  { cookie }
);
assert(
  effectiveRuntime.response.ok &&
    effectiveRuntime.body?.agent?.runtimeAdapterId === "pi" &&
    effectiveRuntime.body?.model?.id === modelId &&
    effectiveRuntime.body?.execution?.type === "vercel" &&
    typeof effectiveRuntime.body?.execution?.hostId === "string" &&
    effectiveRuntime.body?.execution?.ready === true &&
    effectiveRuntime.body?.source === "default" &&
    effectiveRuntime.body?.ready === true,
  "DEFAULT_RUNTIME_UNAVAILABLE",
  effectiveRuntime.body
);

const chat = await getJson(
  `${apiUrl}/businesses/${encodeURIComponent(shopId)}/runtime/turns`,
  { cookie, "content-type": "application/json" },
  "POST",
  { message: "Reply briefly with the name of the model currently serving this agent." }
);
assert(chat.response.ok, "Real chat request failed.", chat.body);
assert(
  chat.body?.turn?.model?.modelId === modelId &&
    chat.body?.turn?.model?.executionTarget === "vercel" &&
    typeof chat.body?.turn?.model?.inferenceRequestId === "string",
  "Chat metadata did not identify the selected Vercel-executed model.",
  chat.body
);

console.log(
  JSON.stringify(
    {
      ok: true,
      api: apiReadiness.body,
      inferenceLiveness: inferenceLiveness.body,
      probe: probe.body,
      effectiveRuntime: effectiveRuntime.body,
      chatModel: chat.body.turn.model
    },
    null,
    2
  )
);

async function getJson(url, headers = {}, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      "x-request-id": randomUUID(),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { response, body: await response.json().catch(() => null) };
}

function required(name) {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") {
    console.error(`${name} is required.`);
    process.exit(64);
  }
  return value;
}

function assert(condition, message, detail) {
  if (condition) return;
  console.error(message);
  console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}
import { randomUUID } from "node:crypto";
