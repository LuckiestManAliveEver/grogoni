import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const productionPackages = [
  packageDefinition("@grogoni/shared-types", "packages/shared-types/package.json"),
  packageDefinition("@grogoni/event-core", "packages/event-core/package.json"),
  packageDefinition("@grogoni/tool-core", "packages/tool-core/package.json"),
  packageDefinition("@grogoni/sync-core", "packages/sync-core/package.json"),
  packageDefinition("@grogoni/business-core", "packages/business-core/package.json"),
  packageDefinition("@grogoni/api", "services/api/package.json")
];

const importPatterns = [
  /\bimport\s+(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
];
const blockedSpecifiers = [
  /(?<!\.d)\.tsx?(?:$|[?#])/u,
  /(?:^|\/)src(?:\/|$)/u,
  /(?:^|\/)services\/[^/]+\/src(?:\/|$)/u
];

export function checkProductionImports({
  rootDirectory = process.cwd(),
  packages = productionPackages
} = {}) {
  const violations = [];

  for (const definition of packages) {
    const manifestPath = resolve(rootDirectory, definition.manifestPath);
    if (!existsSync(manifestPath)) {
      violations.push(missingOutput(definition, definition.manifestPath));
      continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const packageRoot = dirname(manifestPath);
    const entrySpecifiers = new Set([
      ...collectManifestSpecifiers(manifest.exports),
      ...[manifest.main, manifest.module, manifest.types].filter(
        (specifier) => typeof specifier === "string"
      ),
      ...definition.additionalOutputs
    ]);

    for (const specifier of entrySpecifiers) {
      if (blockedSpecifiers.some((blockedSpecifier) => blockedSpecifier.test(specifier))) {
        violations.push({
          type: "invalid-manifest-entry",
          packageName: definition.packageName,
          location: definition.manifestPath,
          specifier
        });
      }
      const expectedPath = resolve(packageRoot, specifier);
      if (!existsSync(expectedPath)) {
        violations.push(
          missingOutput(definition, relative(rootDirectory, expectedPath).replaceAll("\\", "/"))
        );
      }
    }

    const distDirectory = resolve(packageRoot, "dist");
    if (!existsSync(distDirectory)) continue;

    for (const filePath of listJavaScriptFiles(distDirectory)) {
      const source = readFileSync(filePath, "utf8");
      for (const pattern of importPatterns) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1] ?? "";
          if (blockedSpecifiers.some((blockedSpecifier) => blockedSpecifier.test(specifier))) {
            violations.push({
              type: "invalid-runtime-import",
              location: relative(rootDirectory, filePath).replaceAll("\\", "/"),
              specifier
            });
          }
        }
      }
    }
  }

  return violations;
}

export function formatProductionImportViolations(violations) {
  return violations.map((violation) => {
    if (violation.type === "missing-output") {
      return [
        "Missing production build output:",
        `Package: ${violation.packageName}`,
        `Expected: ${violation.expected}`,
        `Run: ${violation.command}`
      ].join("\n");
    }
    if (violation.type === "invalid-manifest-entry") {
      return [
        "Invalid production package entry:",
        `Package: ${violation.packageName}`,
        `Manifest: ${violation.location}`,
        `Entry: ${violation.specifier}`
      ].join("\n");
    }
    return [
      "Invalid production runtime import:",
      `File: ${violation.location}`,
      `Import: ${violation.specifier}`
    ].join("\n");
  });
}

function packageDefinition(packageName, manifestPath, additionalOutputs = []) {
  return {
    packageName,
    manifestPath,
    additionalOutputs,
    command: `pnpm --filter ${packageName} build`
  };
}

function missingOutput(definition, expected) {
  return {
    type: "missing-output",
    packageName: definition.packageName,
    expected,
    command: definition.command
  };
}

function listJavaScriptFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && [".js", ".mjs", ".cjs"].includes(extname(entry.name))
      ? [entryPath]
      : [];
  });
}

function collectManifestSpecifiers(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectManifestSpecifiers(item));
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectManifestSpecifiers(item));
  }
  return [];
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const violations = checkProductionImports();
  if (violations.length > 0) {
    console.error(formatProductionImportViolations(violations).join("\n\n"));
    process.exit(1);
  }
  console.log("Production build imports are clean.");
}
