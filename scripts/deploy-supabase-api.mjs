import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { Blob } from "node:buffer";

const projectRef = "gnmndzsughifhboqvsgd";
const managementBase = `https://api.supabase.com/v1/projects/${projectRef}`;
const functionBase = `https://${projectRef}.supabase.co/functions/v1/api`;
const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required.");
const headers = { Authorization: `Bearer ${token}` };
async function management(path, options = {}) {
  const response = await fetch(`${managementBase}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
    signal: globalThis.AbortSignal.timeout(60000)
  });
  if (!response.ok)
    throw new Error(`Supabase ${path.split("?")[0]} returned HTTP ${response.status}.`);
  return response;
}

if (process.argv.includes("--deploy")) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const url = new URL(databaseUrl);
  if (!url.hostname.endsWith(".neon.tech") && !url.hostname.endsWith(".neon.database")) {
    throw new Error("The database must remain in Neon.");
  }
  const existing = await (await management("/functions")).json();
  const api = existing.find((fn) => fn.slug === "api");
  if (api && api.name !== "Grogoni API") {
    throw new Error("An unrelated function named api exists; refusing to overwrite it.");
  }
  await management("/secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { name: "DATABASE_URL", value: databaseUrl },
      {
        name: "WEB_ORIGINS",
        value: [
          ...new Set([
            ...(process.env.WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
              .split(",")
              .map((origin) => origin.trim())
              .filter(Boolean),
            "https://grogoni-frontend.vercel.app",
            "https://grogoni.com",
            "https://www.grogoni.com"
          ])
        ].join(",")
      }
    ])
  });
  const form = new globalThis.FormData();
  form.append(
    "metadata",
    JSON.stringify({
      name: "Grogoni API",
      entrypoint_path: "index.ts",
      verify_jwt: false
    })
  );
  for (const filename of [
    "index.ts",
    "handler.ts",
    "session-routes.ts",
    "auth-routes.ts",
    "application-routes.ts",
    "public-routes.ts",
    "credentials.ts"
  ]) {
    const source = await readFile(
      new URL(`../supabase/functions/api/${filename}`, import.meta.url)
    );
    form.append("file", new Blob([source], { type: "application/typescript" }), filename);
  }
  const deployed = await (
    await management("/functions/deploy?slug=api", {
      method: "POST",
      body: form
    })
  ).json();
  console.log(
    JSON.stringify({ deployed: deployed.slug, status: deployed.status, version: deployed.version })
  );
}

let failed = false;
for (const [path, expectedStatus] of [
  ["/health/live", 200],
  ["/health/db", 200],
  ["/health/ready", 200]
]) {
  const response = await fetch(`${functionBase}${path}`, {
    signal: globalThis.AbortSignal.timeout(20000)
  });
  const result = await response.json();
  console.log(
    JSON.stringify({ url: `${functionBase}${path}`, httpStatus: response.status, result })
  );
  if (
    response.status !== expectedStatus ||
    (path === "/health/db" && result.database?.ok !== true) ||
    (path === "/health/ready" && result.database?.ok !== true)
  )
    failed = true;
}
if (failed) process.exitCode = 1;
