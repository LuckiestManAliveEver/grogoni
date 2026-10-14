import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const config = async (name: string) =>
  JSON.parse(await readFile(`infra/railway/${name}.json`, "utf8"));

describe("Railway deployment boundaries", () => {
  it("runs guarded migrations before API startup, never in the image build", async () => {
    const api = await config("api");
    expect(api.build.buildCommand).toContain("build:production");
    expect(api.build.buildCommand).not.toContain("db:migrate");
    expect(api.deploy.preDeployCommand).toEqual([
      "COREPACK_HOME=/tmp/corepack corepack pnpm db:migrate",
      "REQUIRE_NEON_DATABASE=true COREPACK_HOME=/tmp/corepack corepack pnpm db:verify-schema"
    ]);
    expect(JSON.stringify(api)).not.toContain("grogoni.allow_108");
    expect(api.deploy.healthcheckPath).toBe("/health/ready");
  });

  it("builds staging as a static SPA without starting the root API script", async () => {
    const web = await config("web");
    expect(web.build.buildCommand).toContain("--filter @grogoni/web... build");
    expect(web.deploy.startCommand).toBeUndefined();
    expect(web.deploy.healthcheckPath).toBe("/health");
  });

  it("uses the existing browser-ready computer runtime image and its CMD", async () => {
    const computer = await config("computer-runtime");
    expect(computer.build.dockerfilePath).toBe("services/computer-runtime/Dockerfile");
    expect(computer.build.buildCommand).toBeUndefined();
    expect(computer.deploy.startCommand).toBeUndefined();
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
