import { isSnapshotRequest, queueCloudRequest } from "./cloud-request-queue";
import { isExplicitOfflineMode, routeOfflineRequest } from "../offline-runtime";
import { getResponseErrorMessage } from "../user-facing-error";
import { recordApiRequest } from "../performance";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly recoverable: boolean;

  constructor(
    status: number,
    message: string,
    options: { code?: string | null; recoverable?: boolean } = {}
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = options.code ?? null;
    this.recoverable = options.recoverable ?? false;
  }
}

export type AuthenticationFailureCode =
  | "auth_refresh_required"
  | "auth_refresh_expired"
  | "auth_refresh_revoked"
  | "auth_refresh_reuse_detected"
  | "auth_session_expired"
  | "auth_reauthentication_required";

const refreshPath = "/auth/session/refresh";
const deviceIdStorageKey = "grogoni.device-id.v1";
const defaultRequestTimeoutMs = 20_000;
let refreshInFlight: Promise<boolean> | null = null;

// Every request (including login) must eventually settle so a caller's loading state can clear.
// Without this, a request whose response never arrives - a stalled backend, a dropped connection -
// leaves its awaiting promise pending forever and the UI stuck showing its busy state.
//
// Returns a cleanup function the caller MUST invoke once the fetch settles (success or failure),
// e.g. in a `finally` block - otherwise the timer keeps running and fires a pointless abort() on
// an already-finished request once timeoutMs elapses.
function withRequestTimeout(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException("The request took too long and was cancelled.", "TimeoutError")
    );
  }, timeoutMs);

  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), {
        once: true
      });
    }
  }

  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

export function isRetryableApiRequestError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ApiRequestError &&
      (error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500))
  );
}

export function readApiBaseUrl(): string {
  const configuredUrl = import.meta.env.VITE_API_BASE_URL ?? import.meta.env.VITE_API_URL;

  if (configuredUrl !== undefined && configuredUrl.trim() !== "") {
    return configuredUrl.trim().replace(/\/+$/, "");
  }

  if (import.meta.env.PROD) {
    throw new Error("The API address is missing from this build.");
  }

  return "http://127.0.0.1:4000";
}

export async function apiFetch<T>(
  pathOrUrl: string,
  options?: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    requestId?: string;
    idempotencyKey?: string;
    skipAuthRefresh?: boolean;
    timeoutMs?: number;
    priority?: boolean;
  }
) {
  if (isExplicitOfflineMode()) {
    options?.signal?.throwIfAborted();
    return routeOfflineRequest<T>(
      pathOrUrl,
      (options?.method ?? "GET").toUpperCase(),
      options?.body
    );
  }
  return apiCloudFetch<T>(pathOrUrl, options);
}

export async function apiCloudFetch<T>(
  pathOrUrl: string,
  options?: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    requestId?: string;
    idempotencyKey?: string;
    skipAuthRefresh?: boolean;
    timeoutMs?: number;
    priority?: boolean;
  }
) {
  const base = readApiBaseUrl();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
  const method = options?.method ?? "GET";
  const requestId = options?.requestId ?? createRequestId();
  const headers = {
    ...deviceSessionHeaders(),
    "x-request-id": requestId,
    ...(options?.idempotencyKey === undefined ? {} : { "idempotency-key": options.idempotencyKey }),
    ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
    ...options?.headers
  };

  const response = await performFetch(url, method, headers, options);
  if (
    response.status === 401 &&
    options?.skipAuthRefresh !== true &&
    !isAuthenticationEntryPoint(pathOrUrl)
  ) {
    const refreshed = await refreshAccountSession(base, options?.signal);
    if (refreshed) {
      const retried = await performFetch(url, method, headers, options);
      return parseApiResponse<T>(retried);
    }
  }
  return parseApiResponse<T>(response);
}

export async function refreshAccountSession(
  baseUrl = readApiBaseUrl(),
  signal?: AbortSignal
): Promise<boolean> {
  if (refreshInFlight !== null) return refreshInFlight;
  refreshInFlight = (async () => {
    const startedAt = performance.now();
    const { signal: timedSignal, cleanup } = withRequestTimeout(signal, defaultRequestTimeoutMs);
    try {
      const response = await fetch(`${baseUrl}${refreshPath}`, {
        method: "POST",
        credentials: "include",
        headers: { ...deviceSessionHeaders(), "x-request-id": createRequestId() },
        signal: timedSignal
      });
      recordApiRequest("POST", `${baseUrl}${refreshPath}`, startedAt, response.status);
      return response.ok;
    } catch {
      recordApiRequest("POST", `${baseUrl}${refreshPath}`, startedAt, "failed");
      return false;
    } finally {
      cleanup();
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export function isDefinitiveAuthenticationError(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.status === 401 &&
    (error.code === "auth_required" ||
      error.code === "auth_session_expired" ||
      error.code === "auth_refresh_expired" ||
      error.code === "auth_refresh_revoked" ||
      error.code === "auth_refresh_reuse_detected" ||
      error.code === "auth_reauthentication_required")
  );
}

async function performFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  options?: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; priority?: boolean }
): Promise<Response> {
  const run = () => performNetworkFetch(url, method, headers, options);
  return isSnapshotRequest(url)
    ? queueCloudRequest(
        run,
        options?.priority || (method !== "GET" && method !== "HEAD"),
        options?.signal
      )
    : run();
}

async function performNetworkFetch(
  url: string,
  method: string,
  headers: Record<string, string>,
  options?: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; priority?: boolean }
): Promise<Response> {
  const startedAt = performance.now();
  const { signal: timedSignal, cleanup } = withRequestTimeout(
    options?.signal,
    options?.timeoutMs ?? defaultRequestTimeoutMs
  );

  try {
    const response = await fetch(url, {
      method,
      credentials: "include",
      signal: timedSignal,
      headers,
      ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    recordApiRequest(method, url, startedAt, response.status);
    return response;
  } catch (error) {
    recordApiRequest(method, url, startedAt, "failed");
    throw error;
  } finally {
    cleanup();
  }
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = (await response
      .clone()
      .json()
      .catch(() => null)) as { code?: unknown; recoverable?: unknown } | null;
    throw new ApiRequestError(response.status, await getResponseErrorMessage(response), {
      code: typeof payload?.code === "string" ? payload.code : null,
      recoverable: payload?.recoverable === true
    });
  }
  return (await response.json()) as T;
}

function isAuthenticationEntryPoint(pathOrUrl: string): boolean {
  try {
    const pathname = pathOrUrl.startsWith("http") ? new URL(pathOrUrl).pathname : pathOrUrl;
    return (
      pathname === refreshPath ||
      pathname === "/auth/continue" ||
      pathname === "/auth/device/recover" ||
      pathname.startsWith("/auth/signup/") ||
      pathname.startsWith("/auth/login/") ||
      pathname.startsWith("/auth/recovery/") ||
      pathname === "/auth/mfa/challenge" ||
      pathname === "/auth/mfa/verify" ||
      pathname.startsWith("/auth/pin/") ||
      pathname.startsWith("/auth/otp/") ||
      pathname.startsWith("/auth/passkeys/login/") ||
      pathname.startsWith("/auth/oauth/")
    );
  } catch {
    return false;
  }
}

function deviceSessionHeaders(): Record<string, string> {
  const browserNavigator = typeof navigator === "undefined" ? undefined : navigator;
  const platform =
    (browserNavigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined)
      ?.userAgentData?.platform ||
    browserNavigator?.platform ||
    "unknown";
  return {
    "x-grogoni-device-id": readStableDeviceId(),
    "x-grogoni-device-name": `${platform} device`,
    "x-grogoni-platform": platform,
    "x-grogoni-client":
      typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches
        ? "pwa"
        : "web"
  };
}

export function readStableDeviceId(): string {
  try {
    const stored = localStorage.getItem(deviceIdStorageKey)?.trim();
    if (stored) return stored;
    const created = createRequestId();
    localStorage.setItem(deviceIdStorageKey, created);
    return created;
  } catch {
    return "ephemeral-device";
  }
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `request-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
