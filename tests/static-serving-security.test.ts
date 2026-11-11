import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";

describe("patched static file serving", () => {
  it("serves HTML and hashed assets with their security and cache policies", async () => {
    const root = await mkdtemp(join(tmpdir(), "grogoni-static-test-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><title>Grogoni</title>");
    await writeFile(join(root, "assets", "app-hash.js"), "console.log('app')");
    const app = buildApi({ webRoot: root });
    try {
      const html = await app.inject({ url: "/", headers: { accept: "text/html" } });
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain("<title>Grogoni</title>");
      expect(html.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(html.headers["cache-control"]).toContain("no-cache");
      const asset = await app.inject({ url: "/assets/app-hash.js" });
      expect(asset.statusCode).toBe(200);
      expect(asset.body).toContain("console.log");
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
