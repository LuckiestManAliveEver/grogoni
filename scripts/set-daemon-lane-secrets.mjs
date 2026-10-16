// Sets the Edge function secrets the daemon lanes need (docs/deployment/daemon-lanes.md):
// OPENROUTER_API_KEY and PLATFORM_DEFAULT_MODEL_ID for the server lane's model calls, and
// DAEMON_SERVICE_TOKEN for the operator API. Reuses DAEMON_SERVICE_TOKEN from the environment
// when present; otherwise generates one and appends it to .env.local (git-ignored). Prints
// secret names only, never values.
//
//   node --env-file=.env.local --env-file=.env.openrouter scripts/set-daemon-lane-secrets.mjs
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { appendFile, chmod } from "node:fs/promises";

const projectRef = "gnmndzsughifhboqvsgd";
const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const modelId = process.env.PLATFORM_DEFAULT_MODEL_ID?.trim();
if (!accessToken) throw new Error("SUPABASE_ACCESS_TOKEN is required.");
if (!apiKey || !modelId)
  throw new Error("OPENROUTER_API_KEY and PLATFORM_DEFAULT_MODEL_ID are required.");

let serviceToken = process.env.DAEMON_SERVICE_TOKEN?.trim() ?? "";
if (serviceToken.length < 32 || /\s/u.test(serviceToken)) {
  serviceToken = randomBytes(32).toString("base64url");
  const file = new URL("../.env.local", import.meta.url);
  await appendFile(file, `\nDAEMON_SERVICE_TOKEN=${serviceToken}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  console.log("Generated DAEMON_SERVICE_TOKEN and saved it to .env.local.");
}

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
  method: "POST",
  headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  body: JSON.stringify([
    { name: "OPENROUTER_API_KEY", value: apiKey },
    { name: "PLATFORM_DEFAULT_MODEL_ID", value: modelId },
    { name: "DAEMON_SERVICE_TOKEN", value: serviceToken }
  ]),
  signal: globalThis.AbortSignal.timeout(60_000)
});
if (!response.ok) throw new Error(`Supabase /secrets returned HTTP ${response.status}.`);
console.log(
  "Set OPENROUTER_API_KEY, PLATFORM_DEFAULT_MODEL_ID and DAEMON_SERVICE_TOKEN. Running isolates pick them up as they recycle (minutes); a deploy picks them up at once."
);
