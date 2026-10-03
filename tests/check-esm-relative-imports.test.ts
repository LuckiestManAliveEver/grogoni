import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkEsmRelativeImports,
  formatEsmRelativeImportViolations
} from "../scripts/check-esm-relative-imports.mjs";

/**
 * Regression coverage for the ERR_MODULE_NOT_FOUND bug this script exists to catch:
 * packages/business-core's freshly-split domain files used extensionless relative imports, which
 * tsc's "Bundler" resolution accepts but Node's real ESM resolver rejects at runtime once the
 * compiled dist/ is actually loaded - a failure mode invisible to tsc, vitest, and tsx alike.
 */
describe("check-esm-relative-imports script", () => {
  it("passes against the real repository (no regressions today)", () => {
    expect(checkEsmRelativeImports(process.cwd())).toEqual([]);
  });

  it('fails and names the offending file when a "type": "module" package has an extensionless relative import', () => {
    const workspace = mkdtempSync(join(tmpdir(), "esm-import-check-"));
    try {
      const packageDir = join(workspace, "packages", "fixture-pkg");
      mkdirSync(join(packageDir, "src"), { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@grogoni/fixture-pkg", type: "module" })
      );
      writeFileSync(
        join(packageDir, "src", "index.ts"),
        'import { helper } from "./helper";\nexport { helper };\n'
      );
      writeFileSync(join(packageDir, "src", "helper.ts"), "export function helper() {}\n");

      const violations = checkEsmRelativeImports(workspace);
      expect(violations).toHaveLength(1);
      expect(formatEsmRelativeImportViolations(violations)).toContain(
        'imports "./helper" without an extension'
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("passes once the extensionless import gains an explicit .js extension", () => {
    const workspace = mkdtempSync(join(tmpdir(), "esm-import-check-"));
    try {
      const packageDir = join(workspace, "packages", "fixture-pkg");
      mkdirSync(join(packageDir, "src"), { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@grogoni/fixture-pkg", type: "module" })
      );
      writeFileSync(
        join(packageDir, "src", "index.ts"),
        'import { helper } from "./helper.js";\nexport { helper };\n'
      );
      writeFileSync(join(packageDir, "src", "helper.ts"), "export function helper() {}\n");

      expect(checkEsmRelativeImports(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('ignores packages that aren\'t "type": "module"', () => {
    const workspace = mkdtempSync(join(tmpdir(), "esm-import-check-"));
    try {
      const packageDir = join(workspace, "packages", "fixture-pkg");
      mkdirSync(join(packageDir, "src"), { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "@grogoni/fixture-pkg" })
      );
      writeFileSync(join(packageDir, "src", "index.ts"), 'import { helper } from "./helper";\n');
      writeFileSync(join(packageDir, "src", "helper.ts"), "export function helper() {}\n");

      expect(checkEsmRelativeImports(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
