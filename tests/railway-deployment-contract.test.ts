import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const config = async (name: string) =>
  JSON.parse(await readFile(`infra/railway/${name}.json`, "utf8"));

describe("Railway deployment boundaries", () => {
  it("stamps the actual Railway commit even when the build checkout has no git metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grogoni-railway-build-"));
    const commit = "a".repeat(40);
    try {
      execFileSync(process.execPath, [resolve("services/api/scripts/write-build-manifest.mjs")], {
        cwd: directory,
        env: { ...process.env, RENDER_GIT_COMMIT: "", RAILWAY_GIT_COMMIT_SHA: commit }
      });
      const manifest = JSON.parse(
        await readFile(join(directory, "dist/build-manifest.json"), "utf8")
      );
      expect(manifest.gitCommitSha).toBe(commit);
      expect(manifest.runtimeArchitecture).toBe("native");
      expect(await readFile("apps/web/vite.config.ts", "utf8")).toContain(
        "process.env.RAILWAY_GIT_COMMIT_SHA"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("runs guarded migrations before API startup, never in the image build", async () => {
    const api = await config("api");
    expect(api.buildCommand).toContain("build:production");
    expect(api.buildCommand).not.toContain("db:migrate");
    expect(api.preDeployCommand).toEqual([
      "COREPACK_HOME=/tmp/corepack corepack pnpm db:migrate",
      "REQUIRE_NEON_DATABASE=true COREPACK_HOME=/tmp/corepack corepack pnpm db:verify-schema"
    ]);
    expect(JSON.stringify(api)).not.toContain("grogoni.allow_108");
    expect(api.healthcheckPath).toBe("/health/ready");
    expect(api.railwayConfigFile).toBeUndefined();
  });

  it("builds staging as a static SPA without starting the root API script", async () => {
    const web = await config("web");
    expect(web.buildCommand).toContain("--filter @grogoni/web... build");
    expect(web.startCommand).toBeNull();
    expect(web.healthcheckPath).toBe("/health");
  });

  it("uses the existing browser-ready computer runtime image and its CMD", async () => {
    const computer = await config("computer-runtime");
    expect(computer.dockerfilePath).toBe("services/computer-runtime/Dockerfile");
    expect(computer.buildCommand).toBeNull();
    expect(computer.startCommand).toBeNull();
  });

  it("proxies only the API prefix without stripping Origin or changing cookies", async () => {
    const caddy = await readFile("Caddyfile", "utf8");
    expect(caddy).toContain("handle_path /api/*");
    expect(caddy).toContain("reverse_proxy {$API_UPSTREAM}");
    expect(caddy).toContain("header_up Host {upstream_hostport}");
    expect(caddy).not.toMatch(/header_(?:up|down)\s+-?(?:Origin|Set-Cookie|Cookie)\b/i);
    expect(caddy).not.toContain("SameSite=None");
  });

  it("keeps asset failures out of SPA fallback and does not cache shell responses", async () => {
    const caddy = await readFile("Caddyfile", "utf8");
    const assets = caddy.slice(caddy.indexOf("handle /assets/*"), caddy.lastIndexOf("handle {"));
    expect(assets).toContain("file_server");
    expect(assets).not.toContain("index.html");
    expect(caddy).toContain('Cache-Control "no-cache, must-revalidate"');
    expect(caddy).toContain("X-Content-Type-Options nosniff");
    expect(caddy).toContain("frame-ancestors 'none'");
  });
});
