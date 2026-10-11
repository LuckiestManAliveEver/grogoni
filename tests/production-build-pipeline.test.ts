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
    // Loads a local .env when present (Render production has none - --env-file-if-exists is a
    // no-op there, same pattern as pnpm verify:production-runtime) so `pnpm dev`/`pnpm start`
    // pick up OLLAMA_BASE_URL and DATABASE_URL locally without a separate env-loading step. The
    // ignored .env.openrouter holds OPENROUTER_API_KEY locally.
    expect(apiManifest.scripts.start).toBe(
      "node --env-file-if-exists=../../.env --env-file-if-exists=../../.env.openrouter dist/index.js"
    );
  });

  it("uses the same production command in the Render API service", async () => {
    const blueprint = await readFile("render.yaml", "utf8");
    const apiStart = blueprint.indexOf("name: grogoni");
    const apiEnd = blueprint.indexOf("\n  - type:", apiStart);
    const apiService = blueprint.slice(apiStart, apiEnd);

    expect(apiService).toContain("corepack pnpm install --frozen-lockfile");
    expect(apiService).toContain("corepack pnpm db:migrate");
    expect(apiService).toContain("corepack pnpm build:production");
    expect(apiService).not.toContain("services/ai-runtime/**");
    expect(apiService).not.toContain("preDeployCommand:");
    expect(apiService).toContain("corepack pnpm --filter @grogoni/api start");
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
