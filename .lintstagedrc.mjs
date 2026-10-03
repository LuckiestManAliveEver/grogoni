import path from "node:path";

// Maps a staged file's path prefix to the pnpm workspace package that owns it, so the pre-commit
// hook can typecheck only the affected package(s) instead of the whole monorepo graph - full
// cross-package correctness still runs in CI (`pnpm typecheck`), this is a fast local gate, not a
// CI replica.
const workspacesByPrefix = [
  ["apps/web/", "@grogoni/web"],
  ["services/api/", "@grogoni/api"],
  ["services/ai-runtime/", "@grogoni/ai-runtime"],
  ["services/sync/", "@grogoni/sync"],
  ["packages/shared-types/", "@grogoni/shared-types"],
  ["packages/sync-core/", "@grogoni/sync-core"],
  ["packages/tool-core/", "@grogoni/tool-core"],
  ["packages/business-core/", "@grogoni/business-core"],
  ["packages/event-core/", "@grogoni/event-core"],
  ["packages/ui/", "@grogoni/ui"]
];

function workspaceForFile(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const match = workspacesByPrefix.find(([prefix]) => normalized.startsWith(prefix));
  return match?.[1] ?? null;
}

export default {
  "*.{ts,tsx}": (files) => {
    const relativeFiles = files.map((file) => path.relative(process.cwd(), file));
    const workspaces = new Set();
    let touchesPackages = false;
    for (const file of relativeFiles) {
      const workspace = workspaceForFile(file);
      if (workspace !== null) workspaces.add(workspace);
      if (file.startsWith("packages/")) touchesPackages = true;
    }

    const commands = [`eslint --max-warnings=0 ${files.map((file) => `"${file}"`).join(" ")}`];

    // Packages are consumed as built libs by services/apps, so rebuild them before typechecking
    // anything downstream - mirrors the root `typecheck` script's own build-then-typecheck order.
    if (touchesPackages) {
      // tsc's default "Bundler" resolution accepts extensionless relative imports and copies them
      // through to compiled output unchanged; Node's real ESM resolver then throws
      // ERR_MODULE_NOT_FOUND on them at runtime, a failure the build/typecheck steps below never
      // see. Catch it here before it reaches a package's dist/.
      commands.push("node scripts/check-esm-relative-imports.mjs");
      commands.push('pnpm -r --filter "./packages/**" --if-present build');
    }
    for (const workspace of workspaces) {
      commands.push(`pnpm --filter ${workspace} typecheck`);
    }

    return commands;
  }
};
