/**
 * Shared jsdom shims for the web tests.
 *
 * jsdom implements neither `window.matchMedia` nor `ResizeObserver`, but several live web hooks
 * (`useChatInboxState`, `useCompactViewport`) call them unconditionally. In a real browser these
 * exist, so the app code is correct; the test environment just needs the browser globals.
 *
 * This file runs for every test project (the root vitest config is `environment: "node"` and the
 * `.tsx` files opt into jsdom via `// @vitest-environment jsdom`), so every shim is guarded to only
 * install when a `window` exists and the API is missing.
 */

type MediaQueryListener = (event: MediaQueryListEvent) => void;

interface MinimalMediaQueryList {
  readonly matches: boolean;
  readonly media: string;
  addEventListener(type: "change", listener: MediaQueryListener): void;
  removeEventListener(type: "change", listener: MediaQueryListener): void;
  // jsdom/happy-dom and older browsers expose the legacy API too; some callers may use it.
  addListener(listener: MediaQueryListener): void;
  removeListener(listener: MediaQueryListener): void;
  dispatchEvent(event: Event): boolean;
}

function evaluateMediaQuery(query: string, viewportWidth: number): boolean {
  // Supports the `(min-width: Npx)` / `(max-width: Npx)` forms the app uses, plus unknown queries
  // (falls back to false, matching a no-match media query).
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  let matches = true;
  if (min) matches = matches && viewportWidth >= Number(min[1]);
  if (max) matches = matches && viewportWidth <= Number(max[1]);
  if (!min && !max) return false;
  return matches;
}

function createMediaQueryList(query: string): MinimalMediaQueryList {
  const listeners = new Set<MediaQueryListener>();
  const width = (globalThis as { innerWidth?: number }).innerWidth ?? 1024;
  return {
    media: query,
    matches: evaluateMediaQuery(query, width),
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    dispatchEvent(event: Event) {
      const mqlEvent = event as MediaQueryListEvent;
      for (const listener of listeners) listener(mqlEvent);
      return true;
    }
  };
}

const view = globalThis as {
  window?: Window & typeof globalThis;
  matchMedia?: (query: string) => MediaQueryList;
  ResizeObserver?: unknown;
};

if (typeof view.window !== "undefined") {
  if (typeof view.window.matchMedia !== "function") {
    view.window.matchMedia = (query: string) =>
      createMediaQueryList(query) as unknown as MediaQueryList;
  }

  if (typeof view.ResizeObserver === "undefined") {
    view.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
}
