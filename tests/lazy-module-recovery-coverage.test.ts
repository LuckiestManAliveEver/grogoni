import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentProfileModuleKeys,
  appRouteModuleKeys,
  ownerModuleKeys,
  workspaceModuleKeys
} from "../apps/web/src/lazy-module-recovery";

// apps/web/src/lazy-module-recovery.ts requires every lazy import to go through
// loadLazyModuleWithRecovery, so a tab left open across a deployment recovers instead of breaking
// on a chunk that no longer exists. This makes that rule a gate instead of a convention.

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : /\.(ts|tsx)$/u.test(entry.name)
        ? [join(directory, entry.name)]
        : []
  );
}

/** The argument text of every `lazy(...)` call in a source file. */
function lazyCalls(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/\blazy\(/gu)) {
    let depth = 0;
    const start = match.index + "lazy".length;
    for (let index = start; index < source.length; index += 1) {
      if (source[index] === "(") depth += 1;
      if (source[index] === ")" && --depth === 0) {
        calls.push(source.slice(start, index + 1));
        break;
      }
    }
  }
  return calls;
}

describe("lazy module recovery coverage", () => {
  it("routes every lazy import in the web app through loadLazyModuleWithRecovery", () => {
    const offenders = sourceFiles("apps/web/src").flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return lazyCalls(source)
        .filter((call) => call.includes("import(") && !call.includes("loadLazyModuleWithRecovery"))
        .map((call) => `${file}: lazy${call.replace(/\s+/gu, " ").slice(0, 100)}`);
    });

    expect(offenders).toEqual([]);
  });

  it("gives every recoverable module its own key", () => {
    const keys = [
      ...Object.values(agentProfileModuleKeys),
      ...Object.values(appRouteModuleKeys),
      ...Object.values(ownerModuleKeys),
      ...Object.values(workspaceModuleKeys)
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("loads the public storefront without the owner app", () => {
    const router = readFileSync("apps/web/src/AppRouter.tsx", "utf8");
    const storefront = router.slice(router.indexOf("const PublicStorefront"));
    expect(storefront.slice(0, storefront.indexOf(");\n") + 3)).toContain(
      'import("./PublicStorefrontChat")'
    );
    expect(readFileSync("apps/web/src/SokoApplication.tsx", "utf8")).not.toContain(
      "PublicStorefrontChat"
    );
  });
});
