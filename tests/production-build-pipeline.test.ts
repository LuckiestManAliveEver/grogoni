import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("production workspace build pipeline", () => {
  it("builds API dependencies before validating compiled entry points", async () => {
    const rootManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const apiManifest = JSON.parse(await readFile("services/api/package.json", "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(apiManifest.dependencies).not.toHaveProperty("@grogoni/ai-runtime");
    expect(rootManifest.scripts["build:production"]).toContain("pnpm build:production:workspace");
    expect(rootManifest.scripts["build:production"]).toContain("pnpm check:production-imports");
    expect(rootManifest.scripts["build:production"]).not.toContain("@grogoni/api^...");
    expect(rootManifest.scripts["build:production:workspace"]).toContain("pnpm -r");
    expect(rootManifest.scripts["build:production:workspace"]).toContain(
      '--filter "./packages/**"'
    );
    expect(rootManifest.scripts["build:production:workspace"]).not.toContain("ai-runtime");
    expect(rootManifest.scripts["build:production:workspace"]).toContain(
      "pnpm --filter @grogoni/api build"
    );
    expect(rootManifest.scripts["build:production:workspace"]).toContain(
      "pnpm --filter @grogoni/web build"
    );
    expect(rootManifest.scripts["build:production:workspace"]).toContain("--if-present build");
    expect(rootManifest.scripts).not.toHaveProperty("inference:build");
    // Loads a local .env when present (a production host has none - --env-file-if-exists is a
    // no-op there, same pattern as pnpm verify:production-runtime) so `pnpm dev`/`pnpm start`
    // pick up OLLAMA_BASE_URL and DATABASE_URL locally without a separate env-loading step. The
    // ignored .env.openrouter holds OPENROUTER_API_KEY locally; the daemon ships from the same build
    // but reads its own .env.daemon, never the app's .env (its DATABASE_URL and GROGONI_API_URL).
    expect(apiManifest.scripts.start).toBe(
      "node --env-file-if-exists=../../.env --env-file-if-exists=../../.env.openrouter dist/index.js"
    );
    expect(apiManifest.scripts["daemon:start"]).toBe(
      "node --env-file-if-exists=../../.env.openrouter --env-file-if-exists=../../.env.daemon dist/daemon/index.js"
    );
  });

  it("builds the web app that grogoni.com serves from vercel.json", async () => {
    // grogoni.com is a Vercel deploy of apps/web; the API runs as a Supabase Edge Function behind
    // its /api rewrite. Render (render.yaml) was retired and must not come back as a second path.
    const vercel = JSON.parse(await readFile("vercel.json", "utf8")) as {
      buildCommand: string;
      outputDirectory: string;
      rewrites: { source: string; destination: string }[];
    };

    expect(vercel.buildCommand).toContain("--filter @grogoni/web...");
    expect(vercel.outputDirectory).toBe("apps/web/dist");
    expect(
      vercel.rewrites.find((rewrite) => rewrite.source === "/api/:path*")?.destination
    ).toMatch(/^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/api\//u);
    expect(existsSync("render.yaml")).toBe(false);
  });

  it("ships no retired hosted inference runtime in the workspace", async () => {
    // services/ai-runtime (the Vercel inference deployment) was removed with the local-first
    // runtime (docs/local-first-cloud-audit.md); the API talks to local Ollama instead.
    const workspace = await readFile("pnpm-workspace.yaml", "utf8");
    const rootManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      engines?: Record<string, string>;
    };

    expect(existsSync("services/ai-runtime")).toBe(false);
    expect(existsSync("services/receipt-ocr-service")).toBe(false);
    expect(workspace).not.toContain("ai-runtime");
    expect(workspace).not.toContain("node-llama-cpp");
    expect(rootManifest.engines?.node).toBe(">=22.19.0 <23.0.0");
  });
});
