import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The production checker is an executable JavaScript module without declarations.
const { checkProductionImports, formatProductionImportViolations } =
  await import("../scripts/check-production-imports.mjs");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("production import checker", () => {
  it("accepts compiled JavaScript and declaration package entries", async () => {
    const fixture = await createPackageFixture();
    expect(checkProductionImports(fixture)).toEqual([]);
  });

  it("reports an actionable package build command when an entry file is missing", async () => {
    const fixture = await createPackageFixture();
    await rm(join(fixture.rootDirectory, "service/dist/index.js"));

    const output = formatProductionImportViolations(checkProductionImports(fixture)).join("\n");
    expect(output).toContain("Missing production build output:");
    expect(output).toContain("Package: @grogoni/fixture");
    expect(output).toContain("Expected: service/dist/index.js");
    expect(output).toContain("Run: pnpm --filter @grogoni/fixture build");
  });

  it("rejects compiled imports that reach into TypeScript source", async () => {
    const fixture = await createPackageFixture();
    await writeFile(
      join(fixture.rootDirectory, "service/dist/index.js"),
      'export { value } from "../src/value.ts";\n'
    );

    const output = formatProductionImportViolations(checkProductionImports(fixture)).join("\n");
    expect(output).toContain("Invalid production runtime import:");
    expect(output).toContain("Import: ../src/value.ts");
  });
});

async function createPackageFixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "grogoni-production-imports-"));
  temporaryDirectories.push(rootDirectory);
  await mkdir(join(rootDirectory, "service/dist"), { recursive: true });
  await writeFile(
    join(rootDirectory, "service/package.json"),
    JSON.stringify({
      name: "@grogoni/fixture",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }
    })
  );
  await writeFile(join(rootDirectory, "service/dist/index.js"), "export const value = true;\n");
  await writeFile(
    join(rootDirectory, "service/dist/index.d.ts"),
    "export declare const value = true;\n"
  );

  return {
    rootDirectory,
    packages: [
      {
        packageName: "@grogoni/fixture",
        manifestPath: "service/package.json",
        additionalOutputs: [],
        command: "pnpm --filter @grogoni/fixture build"
      }
    ]
  };
}
