// Proves a real inference call works end-to-end: Render resolves the runtime binding, mints a
// signed Neon artifact URL, and calls Vercel, which downloads/verifies/loads the model and
// generates. There is no way to probe a specific model on Vercel directly (services/ai-runtime
// only executes whatever fully-resolved request Render sends it) - Render's own diagnostic route
// is the correct probe target.
import { randomUUID } from "node:crypto";

const apiUrl = required("GROGONI_API_URL").replace(/\/+$/u, "");
const response = await fetch(`${apiUrl}/health/ai`, {
  headers: {
    accept: "application/json",
    "x-request-id": randomUUID()
  }
});
const body = await response.json().catch(() => null);
if (!response.ok || body?.status !== "ready" || body?.model?.status !== "ready") {
  console.error(JSON.stringify(body ?? { error: "invalid probe response" }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));

function required(name) {
  const value = process.env[name]?.trim() ?? "";
  if (value === "") {
    console.error(`${name} is required.`);
    process.exit(64);
  }
  return value;
}
