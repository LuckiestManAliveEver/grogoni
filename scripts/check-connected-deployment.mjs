import { JSDOM } from "jsdom";
import { URL } from "node:url";

const frontend = process.env.SMOKE_FRONTEND_URL ?? "https://grogoni.com";
const api = process.env.SMOKE_API_URL ?? `${frontend}/api`;
let failures = 0;
async function check(name, run) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
async function get(url, options = {}) {
  return fetch(url, { ...options, signal: globalThis.AbortSignal.timeout(20000) });
}
await check("Vercel frontend and emitted assets", async () => {
  const response = await get(frontend);
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const document = new JSDOM(await response.text()).window.document;
  const assets = [...document.querySelectorAll("script[src], link[rel=stylesheet]")];
  if (assets.length < 2) throw new Error("Missing frontend script or stylesheet.");
  for (const element of assets) {
    const url = new URL(element.getAttribute("src") ?? element.getAttribute("href"), frontend);
    const asset = await get(url);
    if (asset.status !== 200 || (asset.headers.get("content-type") ?? "").includes("text/html")) {
      throw new Error("A static asset is missing or masked by the SPA fallback.");
    }
  }
});
await check("Production build identifies its commit", async () => {
  const response = await get(`${frontend}/build-meta.json`);
  const meta = await response.json();
  if (!response.ok || !/^[a-f0-9]{40}$/.test(meta.buildId))
    throw new Error("Missing commit identity.");
  if (process.env.SMOKE_EXPECTED_COMMIT && meta.buildId !== process.env.SMOKE_EXPECTED_COMMIT)
    throw new Error("The expected commit is not deployed.");
});
await check("Public browsing returns JSON", async () => {
  for (const [path, field] of [
    ["/public/storefronts", "storefronts"],
    ["/auth/oauth/providers", "providers"]
  ]) {
    const response = await get(`${api}${path}`);
    const body = await response.json();
    if (response.status !== 200 || !Array.isArray(body[field]))
      throw new Error(`${path} HTTP ${response.status}`);
  }
});
await check("Guest bootstrap validates requests", async () => {
  const response = await get(`${api}/auth/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const body = await response.json();
  if (response.status !== 400 || !body.code)
    throw new Error(`Guest bootstrap HTTP ${response.status}`);
  const intro = await get(`${api}/v1/marketplace-intro`);
  const result = await intro.json();
  if (intro.status !== 401 || result.code !== "auth_required")
    throw new Error(`Marketplace intro HTTP ${intro.status}`);
});
await check("Supabase liveness", async () => {
  const response = await get(`${api}/health/live`);
  const body = await response.json();
  if (response.status !== 200 || body.runtime !== "supabase-edge")
    throw new Error(`HTTP ${response.status}`);
});
await check("Vercel origin can access Supabase and Neon", async () => {
  const response = await get(`${api}/health/db`, { headers: { Origin: frontend } });
  const body = await response.json();
  if (response.status !== 200 || body.database?.provider !== "neon" || body.database?.ok !== true) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (
    response.headers.get("access-control-allow-origin") !== frontend ||
    response.headers.get("access-control-allow-credentials") !== "true"
  )
    throw new Error("CORS is not configured.");
  const preflight = await get(`${api}/auth/logout`, {
    method: "OPTIONS",
    headers: {
      Origin: frontend,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type,x-request-id,x-grogoni-device-id,x-grogoni-device-name,x-grogoni-platform,x-grogoni-client,idempotency-key"
    }
  });
  if (
    preflight.status !== 204 ||
    !preflight.headers.get("access-control-allow-methods")?.includes("POST")
  ) {
    throw new Error("Browser POST preflight is not allowed.");
  }
  const permitted = (preflight.headers.get("access-control-allow-headers") ?? "")
    .toLowerCase()
    .split(",")
    .map((header) => header.trim());
  for (const header of [
    "content-type",
    "x-request-id",
    "x-grogoni-device-id",
    "x-grogoni-device-name",
    "x-grogoni-platform",
    "x-grogoni-client",
    "idempotency-key"
  ]) {
    if (!permitted.includes(header)) throw new Error(`Browser header ${header} is not allowed.`);
  }
});
await check("Unauthenticated session access is rejected", async () => {
  const response = await get(`${api}/session`, { headers: { Origin: frontend } });
  const body = await response.json();
  if (response.status !== 401 || body.code !== "auth_required")
    throw new Error(`HTTP ${response.status}`);
});
await check("Native login routes are available and validate requests", async () => {
  const discovery = await get(`${api}/auth/login/methods`, {
    method: "POST",
    headers: { Origin: frontend, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "email", identifier: "route-check@example.invalid" })
  });
  const methods = await discovery.json();
  if (discovery.status !== 200 || methods.preferred !== "pin")
    throw new Error(`Login methods HTTP ${discovery.status}`);
  for (const path of [
    "/auth/pin/login",
    "/auth/login/password",
    "/auth/signup/complete",
    "/auth/mfa/challenge",
    "/auth/mfa/verify"
  ]) {
    const response = await get(`${api}${path}`, {
      method: "POST",
      headers: { Origin: frontend, "Content-Type": "application/json" },
      body: "{}"
    });
    if (response.status !== 400) throw new Error(`${path} HTTP ${response.status}`);
  }
  const refresh = await get(`${api}/auth/session/refresh`, {
    method: "POST",
    headers: { Origin: frontend }
  });
  if (refresh.status !== 401) throw new Error(`Refresh HTTP ${refresh.status}`);
});
await check("Application API readiness", async () => {
  const response = await get(`${api}/health/ready`);
  const body = await response.json();
  if (response.status !== 200)
    throw new Error(`HTTP ${response.status}: ${body.code ?? body.status}`);
});
process.exitCode = failures ? 1 : 0;
