/** Publish an already-built static frontend; never upload source credentials. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { join, relative } from "node:path";
if (!process.argv.includes("--deploy"))
  throw new Error("Pass --deploy to publish the built frontend.");
const token = process.env.VERCEL_TOKEN?.trim();
if (!token) throw new Error("VERCEL_TOKEN is required.");
const projectName = "grogoni-frontend";
const target = process.argv.includes("--production") ? "production" : "preview";
const root = "apps/web/dist";
const metadata = JSON.parse(await readFile(join(root, "build-meta.json"), "utf8"));
if (!metadata.buildId || metadata.buildId === "local")
  throw new Error("A labelled production build is required.");
async function request(path, options = {}) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
    signal: globalThis.AbortSignal.timeout(90000)
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      `Vercel HTTP ${response.status}: ${body.error?.code ?? "request_failed"}; ${body.error?.message ?? ""}`
    );
  }
  return response;
}
const project = await (await request(`/v9/projects/${projectName}`)).json();
const scope = `teamId=${encodeURIComponent(project.accountId)}`;
async function walk(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Refusing symlink in frontend artifact.");
    if (entry.isDirectory()) result.push(...(await walk(file)));
    else result.push({ file: relative(root, file), data: await readFile(file) });
  }
  return result;
}
const files = await walk(root);
if (files.some(({ file }) => file.split("/").some((part) => part.startsWith(".env"))))
  throw new Error("Refusing environment file in frontend artifact.");
// Apply only to this static artifact deployment. Source builds keep the repository configuration.
const config = JSON.parse(await readFile("vercel.json", "utf8"));
Object.assign(config, {
  framework: null,
  buildCommand: "",
  installCommand: "",
  outputDirectory: "."
});
files.push({ file: "vercel.json", data: Buffer.from(JSON.stringify(config)) });
const uploaded = [];
let next = 0;
const results = await Promise.allSettled(
  Array.from({ length: 4 }, async () => {
    while (next < files.length) {
      const { file, data } = files[next++];
      const sha = createHash("sha1").update(data).digest("hex");
      await request(`/v2/files?${scope}`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-vercel-digest": sha,
          "x-vercel-size": String(data.length)
        },
        body: data
      });
      uploaded.push({ file, sha, size: data.length });
    }
  })
);
for (const result of results) if (result.status === "rejected") throw result.reason;
console.log(JSON.stringify({ uploadedFiles: uploaded.length, buildId: metadata.buildId, target }));
const deployment = await (
  await request(`/v13/deployments?${scope}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: projectName,
      project: project.id,
      target,
      files: uploaded,
      projectSettings: {
        framework: null,
        buildCommand: "",
        installCommand: "",
        outputDirectory: "."
      },
      meta: { buildId: metadata.buildId, artifact: "locally-validated-static-frontend" }
    })
  })
).json();
const result = {
  id: deployment.id,
  url: deployment.url,
  state: deployment.readyState,
  projectId: project.id,
  teamId: project.accountId,
  buildId: metadata.buildId,
  target
};
await writeFile("/tmp/grogoni-vercel-deployment.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
