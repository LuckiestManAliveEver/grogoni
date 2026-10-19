import { isExplicitOfflineMode } from "./offline-runtime";
import { apiFetch } from "./lib/api";
import { getCachedJson, invalidateApiCacheForMutation } from "./api-request-cache";

export async function postJson<TResponse>(
  path: string,
  body: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    idempotencyKey?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<TResponse> {
  const response = await apiFetch<TResponse>(path, { method: "POST", body, ...options });
  await invalidateApiCacheForMutation(path);
  const businessId = executedRuntimeBusinessId(response);
  if (businessId !== null) {
    await invalidateApiCacheForMutation(`/businesses/${encodeURIComponent(businessId)}`);
  }
  return response;
}

export async function patchJson<TResponse>(
  path: string,
  body: Record<string, unknown>
): Promise<TResponse> {
  const response = await apiFetch<TResponse>(path, { method: "PATCH", body });
  await invalidateApiCacheForMutation(path);
  return response;
}

export async function putJson<TResponse>(
  path: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal } = {}
): Promise<TResponse> {
  const response = await apiFetch<TResponse>(path, { method: "PUT", body, ...options });
  await invalidateApiCacheForMutation(path);
  return response;
}

export async function deleteJson<TResponse>(
  path: string,
  body?: Record<string, unknown>
): Promise<TResponse> {
  const response = await apiFetch<TResponse>(path, { method: "DELETE", body });
  await invalidateApiCacheForMutation(path);
  return response;
}

export async function getJson<TResponse>(
  path: string,
  onBackgroundUpdate?: (value: TResponse) => void
): Promise<TResponse> {
  if (isExplicitOfflineMode()) return apiFetch<TResponse>(path);
  return getCachedJson<TResponse>(
    path,
    onBackgroundUpdate === undefined ? {} : { onBackgroundUpdate }
  );
}

/**
 * An uncached GET for data a person is about to edit in place (a settings form). The shared cache
 * may serve a copy up to its stale time old - or a persisted local copy - and a form that loads
 * stale values would save them back over a newer change. This always asks the server.
 */
export async function fetchFreshJson<TResponse>(path: string): Promise<TResponse> {
  return apiFetch<TResponse>(path, { priority: true });
}

/** Runtime endpoints can change several resources even when called through /v1/messages. */
function executedRuntimeBusinessId(response: unknown): string | null {
  if (response === null || typeof response !== "object") return null;
  const record = response as Record<string, unknown>;
  const runtime = record.runtime ?? record;
  if (runtime === null || typeof runtime !== "object") return null;
  const { session, turn } = runtime as Record<string, unknown>;
  if (session === null || typeof session !== "object" || turn === null || typeof turn !== "object")
    return null;
  const businessId = (session as Record<string, unknown>).businessId;
  const result = turn as Record<string, unknown>;
  const plan = result.plan;
  if (plan === null || typeof plan !== "object") return null;
  const action = plan as Record<string, unknown>;
  return result.status === "completed" &&
    typeof action.executedAt === "string" &&
    action.toolName !== "unknown.clarify" &&
    typeof businessId === "string" &&
    businessId.length > 0
    ? businessId
    : null;
}
