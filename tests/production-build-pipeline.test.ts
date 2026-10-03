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
    const runtimeManifest = JSON.parse(
      await readFile("services/ai-runtime/package.json", "utf8")
    ) as {
      main: string;
      types: string;
      exports: Record<string, unknown>;
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
    expect(rootManifest.scripts["build:production:workspace"]).toContain(
      "pnpm --filter @grogoni/ai-runtime build:package"
    );
    expect(rootManifest.scripts["build:production:workspace"]).toContain(
      "pnpm --filter @grogoni/api build"
    );
    expect(rootManifest.scripts["build:production:workspace"]).toContain(
      "pnpm --filter @grogoni/web build"
    );
    expect(rootManifest.scripts["build:production:workspace"]).toContain("--if-present build");
    expect(rootManifest.scripts["inference:build"]).toBe("pnpm --filter @grogoni/ai-runtime build");
    expect(runtimeManifest.main).toBe("./dist/index.js");
    expect(runtimeManifest.types).toBe("./dist/index.d.ts");
    expect(runtimeManifest.exports).toHaveProperty(".");
    expect(runtimeManifest.scripts.build).toContain("pnpm --filter @grogoni/shared-types build");
    expect(runtimeManifest.scripts.build).toContain("pnpm build:package");
    expect(runtimeManifest.scripts["build:package"]).toContain("tsc -p tsconfig.build.json");
    // Loads a local .env when present (Render production has none - --env-file-if-exists is a
    // no-op there, same pattern as pnpm verify:production-runtime) so `pnpm dev`/`pnpm start`
    // pick up VERCEL_INFERENCE_URL and the Neon model-storage credentials locally without a
    // separate env-loading step.
    expect(apiManifest.scripts.start).toBe("node --env-file-if-exists=../../.env dist/index.js");
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

  it("emits the AI runtime from src into dist with declarations", async () => {
    const buildConfig = JSON.parse(
      await readFile("services/ai-runtime/tsconfig.build.json", "utf8")
    ) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
      exclude: string[];
    };
    const entryPoint = await readFile("services/ai-runtime/src/index.ts", "utf8");

    expect(buildConfig.compilerOptions.rootDir).toBe("./src");
    expect(buildConfig.compilerOptions.outDir).toBe("./dist");
    expect(buildConfig.compilerOptions.declaration).toBe(true);
    expect(buildConfig.compilerOptions.noEmit).toBe(false);
    expect(buildConfig.include).toContain("src/**/*.ts");
    expect(buildConfig.exclude).toContain("**/*.test.ts");
    // The Vercel handler - not a standalone app/server - is the deployable surface (docs/
    // architecture/inference-runtime.md); services/ai-runtime/api/*.ts wire it to Vercel's
    // fetch-handler convention.
    expect(entryPoint).toContain('from "./vercel-handler.js"');
    expect(entryPoint).toContain("createVercelInferenceHandler");
    expect(entryPoint).toContain("createVercelHealthHandler");
    expect(entryPoint).toContain("createVercelReadyHandler");
  });

  it("declares an explicit Node engine and the pnpm build-script allowlist node-llama-cpp needs", async () => {
    const runtimeManifest = JSON.parse(
      await readFile("services/ai-runtime/package.json", "utf8")
    ) as { engines?: Record<string, string> };
    const rootManifest = JSON.parse(await readFile("package.json", "utf8")) as {
      engines?: Record<string, string>;
    };
    const workspace = await readFile("pnpm-workspace.yaml", "utf8");

    expect(runtimeManifest.engines?.node).toBe(rootManifest.engines?.node);
    expect(workspace).toMatch(/onlyBuiltDependencies:\s*\n\s*-\s*node-llama-cpp/u);
  });

  it("rewrites /health and /ready to separate functions with distinct honesty guarantees", async () => {
    const vercelConfig = JSON.parse(await readFile("services/ai-runtime/vercel.json", "utf8")) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    const health = vercelConfig.rewrites.find((rewrite) => rewrite.source === "/health");
    const ready = vercelConfig.rewrites.find((rewrite) => rewrite.source === "/ready");

    expect(health?.destination).toBe("/api/health");
    expect(ready?.destination).toBe("/api/ready");
    expect(ready?.destination).not.toBe(health?.destination);
  });
});
