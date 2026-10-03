const performanceLoggingEnabled = import.meta.env.DEV && typeof window !== "undefined";
const performanceEventName = "grogoni:performance";

let navigationSequence = 0;
let monitoringStarted = false;
const componentRenderCounts = new Map<string, number>();

export interface GrogoniPerformanceEvent {
  event: string;
  timestamp: number;
  details: Record<string, unknown>;
}

export interface NavigationMeasurement {
  id: string;
  route: string;
}

export interface PerformanceMeasurement {
  id: string;
  startedAt: number;
}

export function startPerformanceMonitoring(): void {
  if (!performanceLoggingEnabled || monitoringStarted) return;
  monitoringStarted = true;

  if ("PerformanceObserver" in globalThis) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          logPerformance("long-task", {
            durationMs: round(entry.duration),
            startTimeMs: round(entry.startTime)
          });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long-task entries are not available in every development browser.
    }
    observePerformanceEntries("largest-contentful-paint", (entry) => {
      logPerformance("largest-contentful-paint", {
        startTimeMs: round(entry.startTime),
        durationMs: round(entry.duration)
      });
    });
    observePerformanceEntries("layout-shift", (entry) => {
      const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
      if (!shift.hadRecentInput) {
        logPerformance("layout-shift", { value: round(shift.value ?? 0) });
      }
    });
    observePerformanceEntries("event", (entry) => {
      if (entry.duration >= 40) {
        logPerformance("interaction", {
          durationMs: round(entry.duration),
          interactionId: (entry as PerformanceEntry & { interactionId?: number }).interactionId
        });
      }
    });
  }
}

export function startNavigationMeasurement(route: string): NavigationMeasurement | null {
  if (!performanceLoggingEnabled) return null;
  const id = `grogoni-navigation-${++navigationSequence}`;
  performance.mark(`${id}:click`);
  logPerformance("navigation-click", { route });
  return { id, route };
}

export function markNavigationCommitted(measurement: NavigationMeasurement | null): void {
  if (measurement === null) return;
  performance.mark(`${measurement.id}:route-update`);
  measureAndLog(measurement, "route-update", "click", "route-update");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      performance.mark(`${measurement.id}:visible`);
      measureAndLog(measurement, "first-visible-render", "click", "visible");
      markNavigationInteractive(measurement);
    });
  });
}

export function recordRouteRender(route: string): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("route-render", { route });
}

export function recordOnboardingEvent(
  event:
    | "first_launch_viewed"
    | "continue_clicked"
    | "device_account_created"
    | "first_chat_loaded"
    | "identity_upgrade_started"
    | "continue_failed"
): void {
  if (!performanceLoggingEnabled) return;
  logPerformance(event, {});
}

export function recordComponentRender(
  component: string,
  phase: "mount" | "update" | "nested-update",
  actualDurationMs: number,
  baseDurationMs: number
): void {
  if (!performanceLoggingEnabled) return;
  const renderCount = (componentRenderCounts.get(component) ?? 0) + 1;
  componentRenderCounts.set(component, renderCount);
  logPerformance("react-render", {
    component,
    phase,
    renderCount,
    actualDurationMs: round(actualDurationMs),
    baseDurationMs: round(baseDurationMs)
  });
}

export function recordApiRequest(
  method: string,
  pathOrUrl: string,
  startedAt: number,
  status: number | "failed"
): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("api-request", {
    method,
    path: safePath(pathOrUrl),
    status,
    durationMs: round(performance.now() - startedAt)
  });
}

export function recordApiCache(path: string, result: "fresh" | "stale" | "deduplicated"): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("api-cache", { path: safePath(path), result });
}

export function recordRuntimeInitialization(
  state: "initializing" | "ready" | "failed" | "reused",
  durationMs?: number
): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("runtime-initialization", {
    state,
    ...(durationMs === undefined ? {} : { durationMs: round(durationMs) })
  });
}

export function markIndexedDbReadStart(domain: string): PerformanceMeasurement | null {
  if (!performanceLoggingEnabled) return null;
  const id = `grogoni-idb-${domain}-${++navigationSequence}`;
  performance.mark(`${id}:start`);
  return { id, startedAt: performance.now() };
}

export function markIndexedDbReadEnd(measurement: PerformanceMeasurement | null): void {
  if (measurement === null) return;
  performance.mark(`${measurement.id}:end`);
  try {
    performance.measure(measurement.id, `${measurement.id}:start`, `${measurement.id}:end`);
    const entry = performance.getEntriesByName(measurement.id, "measure").at(-1);
    logPerformance("indexeddb-read", { durationMs: round(entry?.duration ?? 0) });
  } finally {
    performance.clearMarks(`${measurement.id}:start`);
    performance.clearMarks(`${measurement.id}:end`);
    performance.clearMeasures(measurement.id);
  }
}

export function recordCacheHydration(domain: string, state: "hydrated" | "empty"): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("cache-hydration", { domain, state });
}

export function recordWorkerStartup(
  worker: string,
  state: "starting" | "ready" | "failed",
  durationMs?: number
): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("worker-startup", {
    worker,
    state,
    ...(durationMs === undefined ? {} : { durationMs: round(durationMs) })
  });
}

export function recordRealtimeConnection(
  state: "connecting" | "ready" | "closed" | "failed"
): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("websocket", { state });
}

export function recordReadiness(mark: "app-shell" | "composer" | "chat-first-message"): void {
  if (!performanceLoggingEnabled) return;
  logPerformance("readiness", { mark, atMs: round(performance.now()) });
}

export function isPerformanceDebugEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    new URLSearchParams(window.location.search).get("debug") === "performance" ||
    localStorage.getItem("grogoni.performance-debug.v1") === "true"
  );
}

export function subscribeToPerformanceEvents(
  listener: (event: GrogoniPerformanceEvent) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    listener((event as CustomEvent<GrogoniPerformanceEvent>).detail);
  };
  window.addEventListener(performanceEventName, handler);
  return () => window.removeEventListener(performanceEventName, handler);
}

function measureAndLog(
  measurement: NavigationMeasurement,
  event: string,
  start: string,
  end: string
): void {
  const name = `${measurement.id}:${event}`;
  try {
    performance.measure(name, `${measurement.id}:${start}`, `${measurement.id}:${end}`);
    const entry = performance.getEntriesByName(name, "measure").at(-1);
    logPerformance(event, {
      route: measurement.route,
      durationMs: round(entry?.duration ?? 0)
    });
    performance.clearMeasures(name);
  } catch {
    // A development browser can clear marks during hot reload.
  }
}

function clearNavigationMarks(id: string): void {
  performance.clearMarks(`${id}:click`);
  performance.clearMarks(`${id}:route-update`);
  performance.clearMarks(`${id}:visible`);
}

function markNavigationInteractive(measurement: NavigationMeasurement): void {
  const complete = () => {
    performance.mark(`${measurement.id}:interactive`);
    measureAndLog(measurement, "navigation-interactive", "click", "interactive");
    performance.clearMarks(`${measurement.id}:interactive`);
    clearNavigationMarks(measurement.id);
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(complete, { timeout: 250 });
  } else {
    globalThis.setTimeout(complete, 0);
  }
}

function safePath(pathOrUrl: string): string {
  try {
    const origin =
      typeof globalThis.location === "undefined" ? "http://localhost" : globalThis.location.origin;
    return new URL(pathOrUrl, origin).pathname;
  } catch {
    return pathOrUrl.split("?")[0] ?? pathOrUrl;
  }
}

function logPerformance(event: string, details: Record<string, unknown>): void {
  console.info("[GROGONI_PERF]", { event, ...details });
  window.dispatchEvent(
    new CustomEvent<GrogoniPerformanceEvent>(performanceEventName, {
      detail: { event, timestamp: Date.now(), details }
    })
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function observePerformanceEntries(
  type: string,
  listener: (entry: PerformanceEntry) => void
): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) listener(entry);
    });
    observer.observe({ type, buffered: true });
  } catch {
    // The metric is optional on older and embedded Android browsers.
  }
}
