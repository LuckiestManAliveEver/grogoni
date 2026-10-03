import type { AuthBootstrapState, AuthSessionView } from "@grogoni/shared-types";

const cachedSessionKey = "grogoni.auth-bootstrap.v1";

export interface CachedAuthSession {
  account: AuthSessionView["account"];
  user: AuthSessionView["user"];
  session: AuthSessionView["session"];
  cachedAt: string;
}

export function isAuthBootstrapPending(state: AuthBootstrapState): boolean {
  return (
    state === "initializing" || state === "restoring-session" || state === "refreshing-session"
  );
}

/**
 * Cached account data is useful for the offline shell, but it is not proof that the API will
 * accept the browser's HTTP-only access/refresh cookies. Server-backed work must wait for the
 * canonical bootstrap request to validate (or refresh) those credentials.
 */
export function hasServerAuthenticatedSession(state: AuthBootstrapState): boolean {
  return state === "authenticated";
}

export function saveCachedAuthSession(session: AuthSessionView): CachedAuthSession {
  const cached = { ...session, cachedAt: new Date().toISOString() };
  localStorage.setItem(cachedSessionKey, JSON.stringify(cached));
  return cached;
}

export function readCachedAuthSession(): CachedAuthSession | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(cachedSessionKey) ?? "null");
    if (!isCachedAuthSession(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function clearCachedAuthSession(): void {
  localStorage.removeItem(cachedSessionKey);
  // Retain unsynced data under its account key; remove the active routing grant on sign-out.
  localStorage.removeItem("grogoni.offline-runtime.active.v1");
}

export function bootstrapProgressMessage(
  state: AuthBootstrapState,
  hasBusiness: boolean,
  hasAgent: boolean
): string {
  if (state === "initializing") return "Opening your shop…";
  if (state === "restoring-session") return "Restoring your session…";
  if (state === "refreshing-session") return "Refreshing your secure session…";
  if (hasBusiness && !hasAgent) return "Starting your agent…";
  if (hasBusiness) return "Loading local model…";
  return "Opening Grogoni…";
}

function isCachedAuthSession(value: unknown): value is CachedAuthSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CachedAuthSession>;
  return (
    typeof candidate.account?.id === "string" &&
    typeof candidate.user?.id === "string" &&
    typeof candidate.session?.id === "string" &&
    typeof candidate.session?.expiresAt === "string" &&
    typeof candidate.cachedAt === "string"
  );
}
