import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
const authStateHook = readFileSync("apps/web/src/hooks/useAuthState.ts", "utf8");
const navigationStateHook = readFileSync("apps/web/src/hooks/useNavigationState.ts", "utf8");
const syncStateHook = readFileSync("apps/web/src/hooks/useSyncState.ts", "utf8");

describe("persistent authenticated app shell", () => {
  it("restores cached shell data but gates server-backed work on authentication validation", () => {
    expect(application).toContain("const initialCachedSession = readCachedAuthSession()");
    expect(application).toContain("useState<SessionResponse | null>(initialCachedSession)");
    expect(authStateHook).toContain(
      'initialCachedSession === null ? "initializing" : "offline-authenticated"'
    );
    expect(authStateHook).toContain('setAuthBootstrapState("restoring-session")');
    expect(application).toContain(
      "navigator.onLine && hasServerAuthenticatedSession(authBootstrapState)"
    );
    expect(application).not.toContain(
      'current === "offline-authenticated" ? current : "restoring-session"'
    );
  });

  it("uses history state for ordinary routes and keeps one stable shell instance", () => {
    const navigationStart = navigationStateHook.indexOf("function navigateToView");
    const navigationEnd = navigationStateHook.indexOf("function returnToChat", navigationStart);
    const navigation = navigationStateHook.slice(navigationStart, navigationEnd);

    expect(navigation).toContain("navigateToOwnerRoute");
    expect(navigation).not.toContain("window.history.pushState");
    expect(navigation).not.toContain("window.location.assign");
    expect(navigation).not.toContain("window.location.reload");
    expect(application).toContain("data-shell-instance={shellInstanceIdRef.current}");
  });

  it("does not recreate IndexedDB or realtime when online state changes", () => {
    const repositoryEffectStart = syncStateHook.indexOf("void openIndexedDbSyncRepository()");
    const repositoryEffectEnd = syncStateHook.indexOf(
      "async function loadSyncQueue",
      repositoryEffectStart
    );
    const repositoryEffect = syncStateHook.slice(repositoryEffectStart, repositoryEffectEnd);

    expect(repositoryEffect).toContain("subscribeToAccountRealtime");
    expect(repositoryEffect).toContain("}, [deps.session?.account.id]);");
    expect(repositoryEffect).not.toContain("}, [deps.session?.account.id, isOnline]);");
  });
});
