// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { matchStorefrontRoute, shouldWarmOwnerRoute } from "../apps/web/src/app-route-matching";
import {
  agentProfileModuleKeys,
  appRouteModuleKeys,
  ownerModuleKeys,
  workspaceModuleKeys
} from "../apps/web/src/lazy-module-recovery";
import {
  WorkspaceScreenBoundary,
  lazyWorkspaceScreens,
  workspaceScreenModuleKey
} from "../apps/web/src/owner-workspace-screens";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// apps/web/src/lazy-module-recovery.ts requires every lazily loaded piece of UI to go through
// loadLazyModuleWithRecovery, so a tab left open across a deployment recovers instead of breaking
// on a chunk that no longer exists. These tests make that rule a gate, on the syntax tree.

const webSource = "apps/web/src";

/**
 * Dynamic imports that are not UI: engines, OCR, API helpers and fire-and-forget prefetch hints.
 * Their callers handle a failed import (or, for prefetch, ignore it), and none of them is a screen
 * a user would be left staring at. file (relative to apps/web/src) -> allowed specifiers.
 */
const nonUiDynamicImports: Record<string, string[]> = {
  "device-model-engine.ts": ["@mlc-ai/web-llm"],
  "webllm-runtime.ts": ["@mlc-ai/web-llm"],
  "offline-runtime.ts": ["./offline-ocr", "./lib/api"],
  "runtime-handoff.ts": ["./offline-ocr"],
  // A failed import rejects that attachment's extraction, which the turn reports as unreadable.
  "chat-message-plumbing.ts": ["./offline-ocr"],
  "QuickRuntimeSwitcher.tsx": ["./device-model-engine"],
  "prefetch.ts": ["./ProductCapturePanel", "./AccountBackendControls"],
  "inference/agent-turn-preview.ts": ["./agent-turn-companion"],
  "inference/agent-turn-companion.ts": ["../device-model-engine"]
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : /\.(ts|tsx)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")
        ? [join(directory, entry.name)]
        : []
  );
}

function isCallTo(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
  );
}

interface Finding {
  file: string;
  line: number;
  what: string;
}

function scan(file: string): { unwrapped: Finding[]; nonInlineLazy: Finding[] } {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const name = relative(webSource, file);
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const unwrapped: Finding[] = [];
  const nonInlineLazy: Finding[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      const specifier = first !== undefined && ts.isStringLiteral(first) ? first.text : "?";
      let wrapped = false;
      for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
        if (isCallTo(parent, "loadLazyModuleWithRecovery")) wrapped = true;
      }
      if (!wrapped) unwrapped.push({ file: name, line: line(node), what: specifier });
    }
    if (isCallTo(node, "lazy")) {
      const loader = node.arguments[0];
      if (
        loader === undefined ||
        !(ts.isArrowFunction(loader) || ts.isFunctionExpression(loader))
      ) {
        nonInlineLazy.push({ file: name, line: line(node), what: loader?.getText() ?? "(none)" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { unwrapped, nonInlineLazy };
}

describe("lazy module recovery coverage", () => {
  const scans = sourceFiles(webSource).map(scan);
  const unwrapped = scans.flatMap((result) => result.unwrapped);

  it("loads every dynamically imported UI module through loadLazyModuleWithRecovery", () => {
    const offenders = unwrapped.filter(
      (finding) => !(nonUiDynamicImports[finding.file] ?? []).includes(finding.what)
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the non-UI allow-list accurate", () => {
    const stale = Object.entries(nonUiDynamicImports).flatMap(([file, specifiers]) =>
      specifiers
        .filter((specifier) => !unwrapped.some((f) => f.file === file && f.what === specifier))
        .map((specifier) => `${file}: ${specifier}`)
    );
    expect(stale).toEqual([]);
  });

  it("passes every lazy() an inline loader the gate can see into", () => {
    expect(scans.flatMap((result) => result.nonInlineLazy)).toEqual([]);
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

  it("loads each lazy workspace screen under the key its boundary uses", () => {
    for (const [view, key] of Object.entries(lazyWorkspaceScreens)) {
      expect(key).toBe(workspaceScreenModuleKey(view));
    }
  });

  it("shows the in-panel fallback while a workspace screen loads", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const Never = lazy(() => new Promise<{ default: () => null }>(() => undefined));
    await act(async () => {
      root.render(
        <WorkspaceScreenBoundary view="pos">
          <Never />
        </WorkspaceScreenBoundary>
      );
    });
    expect(host.textContent).toBe("Opening…");
    act(() => root.unmount());
  });

  it("never warms the owner app for a public storefront, but still for owner paths", () => {
    for (const storefront of [
      "/agent/demo-shop",
      "/agent/x/products/p1",
      "/shop/x",
      "/grogoni/x/"
    ]) {
      expect(matchStorefrontRoute(storefront)).not.toBeNull();
      expect(shouldWarmOwnerRoute(storefront)).toBe(false);
    }
    // Under a storefront prefix but not a storefront: falls through to the owner app.
    expect(shouldWarmOwnerRoute("/shop/x/settings")).toBe(true);
    expect(shouldWarmOwnerRoute("/login")).toBe(true);
  });

  it("loads the public storefront without the owner app", () => {
    const router = readFileSync("apps/web/src/AppRouter.tsx", "utf8");
    const storefront = router.slice(router.indexOf("const PublicStorefront"));
    expect(storefront.slice(0, storefront.indexOf(");\n") + 3)).toContain(
      'import("./PublicStorefrontChat")'
    );
    expect(readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8")).not.toContain(
      "PublicStorefrontChat"
    );
  });
});
