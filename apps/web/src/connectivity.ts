import { readApiBaseUrl } from "./lib/api";

export type ConnectivityState =
  | "unknown"
  | "browser_offline"
  | "api_reachable"
  | "api_unreachable"
  | "authenticated"
  | "session_expired"
  | "degraded";

type Listener = () => void;

let state: ConnectivityState =
  typeof navigator !== "undefined" && !navigator.onLine ? "browser_offline" : "unknown";
let authenticated: boolean | null = null;
let failureCount = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let abortController: AbortController | null = null;
let subscriberCount = 0;
const listeners = new Set<Listener>();

export function getConnectivitySnapshot(): ConnectivityState {
  return state;
}

export function subscribeConnectivity(listener: Listener): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) start();
  return () => {
    listeners.delete(listener);
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) stop();
  };
}

export function setConnectivityAuthentication(value: boolean | null): void {
  authenticated = value;
  if (value === false && state === "authenticated") setState("session_expired");
  if (value === true && state === "api_reachable") setState("authenticated");
}

export function connectivityCanUseLocalData(value: ConnectivityState): boolean {
  return value !== "session_expired";
}

export function connectivityRequiresServer(value: ConnectivityState): boolean {
  return (
    value === "unknown" ||
    value === "browser_offline" ||
    value === "api_unreachable" ||
    value === "degraded"
  );
}

function start(): void {
  window.addEventListener("online", handleBrowserConnection);
  window.addEventListener("offline", handleBrowserConnection);
  document.addEventListener("visibilitychange", handleVisibility);
  handleBrowserConnection();
}

function stop(): void {
  window.removeEventListener("online", handleBrowserConnection);
  window.removeEventListener("offline", handleBrowserConnection);
  document.removeEventListener("visibilitychange", handleVisibility);
  if (timer !== null) clearTimeout(timer);
  timer = null;
  abortController?.abort();
  abortController = null;
}

function handleBrowserConnection(): void {
  if (!navigator.onLine) {
    abortController?.abort();
    setState("browser_offline");
    scheduleProbe(15_000);
    return;
  }
  void probeApi();
}

function handleVisibility(): void {
  if (document.visibilityState === "visible" && navigator.onLine) void probeApi();
}

async function probeApi(): Promise<void> {
  abortController?.abort();
  abortController = new AbortController();
  const timeout = setTimeout(() => abortController?.abort(), 5_000);
  try {
    const response = await fetch(`${readApiBaseUrl()}/health`, {
      cache: "no-store",
      credentials: "omit",
      signal: abortController.signal
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
      throw new Error(`Reachability check returned ${response.status}.`);
    const health = await response.json();
    if (health.service !== "api" || health.status !== "ok")
      throw new Error("Invalid API health response.");
    failureCount = 0;
    setState(authenticated ? "authenticated" : "api_reachable");
    scheduleProbe(60_000);
  } catch {
    failureCount += 1;
    setState(failureCount >= 3 ? "degraded" : "api_unreachable");
    scheduleProbe(Math.min(120_000, 5_000 * 2 ** Math.min(failureCount, 4)));
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleProbe(delayMs: number): void {
  if (timer !== null) clearTimeout(timer);
  if (subscriberCount === 0) return;
  timer = setTimeout(() => {
    timer = null;
    if (navigator.onLine) void probeApi();
  }, delayMs);
}

function setState(next: ConnectivityState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}
