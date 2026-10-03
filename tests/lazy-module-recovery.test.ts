import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForStaleBuildAtStartup,
  consumeDeploymentRecoveryOutcome,
  hasPendingLazyModuleRecovery,
  isLazyModuleLoadError,
  loadLazyModuleWithRecovery,
  logDeploymentRecoveryEvent,
  registerPreReloadFlush,
  retryLazyModuleLoad,
  type LazyModuleRecoveryEnvironment
} from "../apps/web/src/lazy-module-recovery";

const staleChunkError = new TypeError(
  "Failed to fetch dynamically imported module: /assets/profile-old.js"
);

function createEnvironment(
  overrides: Partial<LazyModuleRecoveryEnvironment> & { buildId?: string } = {}
): LazyModuleRecoveryEnvironment & {
  reload: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  const log = vi.fn();
  return {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    },
    reload: vi.fn(),
    isOnline: () => true,
    now: () => 1_000,
    log,
    fetchBuildMeta: async () => null,
    buildId: "build-a",
    values,
    ...overrides
  };
}

/** Simulates the browser reloading: same sessionStorage (sessionStorage survives a same-tab
 * reload), a fresh environment object, and - when a deployment actually shipped - a new buildId
 * baked into the freshly-fetched bundle. */
function reloadedEnvironment(
  previous: ReturnType<typeof createEnvironment>,
  overrides: Partial<LazyModuleRecoveryEnvironment> = {}
) {
  // A real reload gets a fresh JS context (fresh reload()/log() function references) but the same
  // sessionStorage, since sessionStorage survives a same-tab reload.
  return createEnvironment({ storage: previous.storage, ...overrides });
}

describe("isLazyModuleLoadError", () => {
  it("recognizes the chunk-load failures emitted by supported browsers and bundlers", () => {
    expect(
      isLazyModuleLoadError(
        new TypeError("Failed to fetch dynamically imported module: /assets/a.js")
      )
    ).toBe(true);
    expect(isLazyModuleLoadError(new Error("Importing a module script failed."))).toBe(true);
    expect(
      isLazyModuleLoadError(
        Object.assign(new Error("Loading chunk 42 failed"), { name: "ChunkLoadError" })
      )
    ).toBe(true);
    expect(isLazyModuleLoadError(new Error("Loading CSS chunk 7 failed"))).toBe(true);
    expect(isLazyModuleLoadError(new Error("Agent profile data is invalid"))).toBe(false);
    expect(isLazyModuleLoadError("not an error")).toBe(false);
  });
});

describe("loadLazyModuleWithRecovery", () => {
  it("reloads once on a stale chunk failure and marks the panel to reopen after reload", async () => {
    const environment = createEnvironment();

    await expect(
      loadLazyModuleWithRecovery(
        "agent-profile",
        async () => Promise.reject(staleChunkError),
        environment
      )
    ).rejects.toBe(staleChunkError);

    expect(environment.reload).toHaveBeenCalledTimes(1);
    expect(hasPendingLazyModuleRecovery("agent-profile", environment)).toBe(true);
    const events = environment.log.mock.calls.map(([event]) => event);
    expect(events).toEqual([
      "frontend.chunk_load_failed",
      "frontend.stale_build_detected",
      "frontend.recovery_started"
    ]);
  });

  it("clears the pending-reopen marker once the module loads successfully", async () => {
    const environment = createEnvironment();
    await loadLazyModuleWithRecovery(
      "agent-profile",
      async () => Promise.reject(staleChunkError),
      environment
    ).catch(() => undefined);
    expect(hasPendingLazyModuleRecovery("agent-profile", environment)).toBe(true);

    const loaded = await loadLazyModuleWithRecovery(
      "agent-profile",
      async () => ({ profile: true }),
      environment
    );

    expect(loaded).toEqual({ profile: true });
    expect(hasPendingLazyModuleRecovery("agent-profile", environment)).toBe(false);
  });

  // F + I: a second failure while still running the SAME build (the reload did not actually pick
  // up a new deployment - e.g. an edge cache still serving the old index.html) must not reload
  // again. Without this guard the app would loop: reload -> stale error -> reload -> ...
  it("does not reload a second time for the same build transition (no infinite refresh loop)", async () => {
    const environment = createEnvironment();
    await loadLazyModuleWithRecovery(
      "agent-profile",
      async () => Promise.reject(staleChunkError),
      environment
    ).catch(() => undefined);
    expect(environment.reload).toHaveBeenCalledTimes(1);

    // Same tab, same build id: the "reload" did not really happen in this unit test, so this call
    // models a second chunk failure still on build-a.
    await expect(
      loadLazyModuleWithRecovery(
        "agent-profile",
        async () => Promise.reject(staleChunkError),
        environment
      )
    ).rejects.toBe(staleChunkError);

    expect(environment.reload).toHaveBeenCalledTimes(1);
    const events = environment.log.mock.calls.map(([event]) => event);
    expect(events).toContain("frontend.recovery_failed");
  });

  // B: after a genuine deployment, the reload lands on a new build id - a later, unrelated
  // failure (e.g. a different panel's chunk) is free to attempt its own single automatic reload.
  it("allows a fresh automatic recovery after the build id actually changed", async () => {
    const first = createEnvironment({ buildId: "build-a" });
    await loadLazyModuleWithRecovery(
      "agent-profile",
      async () => Promise.reject(staleChunkError),
      first
    ).catch(() => undefined);
    expect(first.reload).toHaveBeenCalledTimes(1);

    const afterDeploy = reloadedEnvironment(first, { buildId: "build-b" });
    await expect(
      loadLazyModuleWithRecovery(
        "agent-model-panel",
        async () => Promise.reject(staleChunkError),
        afterDeploy
      )
    ).rejects.toBe(staleChunkError);

    expect(afterDeploy.reload).toHaveBeenCalledTimes(1);
  });

  // H: offline must never be treated as a stale deployment.
  it("does not reload when the browser is offline, even for a chunk-load-shaped error", async () => {
    const environment = createEnvironment({ isOnline: () => false });

    await expect(
      loadLazyModuleWithRecovery(
        "agent-profile",
        async () => Promise.reject(staleChunkError),
        environment
      )
    ).rejects.toBe(staleChunkError);

    expect(environment.reload).not.toHaveBeenCalled();
    expect(hasPendingLazyModuleRecovery("agent-profile", environment)).toBe(false);
    const logged = environment.log.mock.calls.map(([event, fields]) => ({ event, fields }));
    expect(logged).toEqual([
      {
        event: "frontend.chunk_load_failed",
        fields: expect.objectContaining({ category: "offline" })
      }
    ]);
  });

  // G: a genuine programming exception in the loader must never be mistaken for a stale build.
  it("never reloads for an error that is not a recognized chunk-load failure", async () => {
    const environment = createEnvironment();
    const bug = new Error("Agent profile data is invalid");

    await expect(
      loadLazyModuleWithRecovery("agent-profile", async () => Promise.reject(bug), environment)
    ).rejects.toBe(bug);

    expect(environment.reload).not.toHaveBeenCalled();
    expect(hasPendingLazyModuleRecovery("agent-profile", environment)).toBe(false);
    expect(environment.log).toHaveBeenCalledWith(
      "frontend.chunk_load_failed",
      expect.objectContaining({ category: "component_exception" })
    );
  });

  it("flushes registered pre-reload state before reloading", async () => {
    const environment = createEnvironment();
    const flush = vi.fn();
    const unregister = registerPreReloadFlush(flush);
    try {
      await loadLazyModuleWithRecovery(
        "agent-profile",
        async () => Promise.reject(staleChunkError),
        environment
      ).catch(() => undefined);
      expect(flush).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("never touches storage keys outside its own namespace", async () => {
    const environment = createEnvironment();
    environment.values.set("grogoni.chatFirst.ownerAuth", "do-not-touch");
    environment.values.set("grogoni.owner-navigation.v1:acct-1", "do-not-touch");

    await loadLazyModuleWithRecovery(
      "agent-profile",
      async () => Promise.reject(staleChunkError),
      environment
    ).catch(() => undefined);

    expect(environment.values.get("grogoni.chatFirst.ownerAuth")).toBe("do-not-touch");
    expect(environment.values.get("grogoni.owner-navigation.v1:acct-1")).toBe("do-not-touch");
  });
});

describe("retryLazyModuleLoad", () => {
  it("clears both markers and always reloads, resetting the automatic loop guard", () => {
    const environment = createEnvironment();
    environment.values.set("grogoni.lazy-module-recovery.v1.agent-profile", "pending");
    environment.values.set(
      "grogoni.deployment-recovery.v1",
      JSON.stringify({ buildId: "build-a", attempts: 1, firstAttemptAt: 0 })
    );

    retryLazyModuleLoad("agent-profile", environment);

    expect(environment.reload).toHaveBeenCalledTimes(1);
    expect(hasPendingLazyModuleRecovery("agent-profile", environment)).toBe(false);
    expect(environment.values.get("grogoni.deployment-recovery.v1")).toBeUndefined();
  });
});

describe("consumeDeploymentRecoveryOutcome", () => {
  it("logs frontend.recovery_completed and clears the marker once the build actually changed", () => {
    const environment = createEnvironment({ buildId: "build-b" });
    environment.values.set(
      "grogoni.deployment-recovery.v1",
      JSON.stringify({ buildId: "build-a", attempts: 1, firstAttemptAt: 0 })
    );

    consumeDeploymentRecoveryOutcome(environment);

    expect(environment.log).toHaveBeenCalledWith(
      "frontend.recovery_completed",
      expect.objectContaining({ buildId: "build-b", previousBuildId: "build-a" })
    );
    expect(environment.values.get("grogoni.deployment-recovery.v1")).toBeUndefined();
  });

  it("does nothing when still on the same build (leaves the loop guard armed)", () => {
    const environment = createEnvironment({ buildId: "build-a" });
    environment.values.set(
      "grogoni.deployment-recovery.v1",
      JSON.stringify({ buildId: "build-a", attempts: 1, firstAttemptAt: 0 })
    );

    consumeDeploymentRecoveryOutcome(environment);

    expect(environment.log).not.toHaveBeenCalled();
    expect(environment.values.get("grogoni.deployment-recovery.v1")).toBeDefined();
  });

  it("does nothing when no recovery was ever attempted", () => {
    const environment = createEnvironment();
    consumeDeploymentRecoveryOutcome(environment);
    expect(environment.log).not.toHaveBeenCalled();
  });
});

describe("checkForStaleBuildAtStartup", () => {
  it("logs a startup staleness signal without reloading when the server build id differs", async () => {
    const environment = createEnvironment({
      buildId: "build-a",
      fetchBuildMeta: async () => ({ buildId: "build-b" })
    });

    await checkForStaleBuildAtStartup(environment);

    expect(environment.reload).not.toHaveBeenCalled();
    expect(environment.log).toHaveBeenCalledWith(
      "frontend.stale_build_detected",
      expect.objectContaining({ buildId: "build-a", serverBuildId: "build-b", trigger: "startup" })
    );
  });

  it("stays silent when the client already matches the deployed build", async () => {
    const environment = createEnvironment({
      buildId: "build-a",
      fetchBuildMeta: async () => ({ buildId: "build-a" })
    });

    await checkForStaleBuildAtStartup(environment);

    expect(environment.log).not.toHaveBeenCalled();
  });

  it("never fetches (and never throws) while offline", async () => {
    const fetchBuildMeta = vi.fn(async () => ({ buildId: "build-b" }));
    const environment = createEnvironment({ isOnline: () => false, fetchBuildMeta });

    await expect(checkForStaleBuildAtStartup(environment)).resolves.toBeUndefined();
    expect(fetchBuildMeta).not.toHaveBeenCalled();
  });

  it("swallows a network failure instead of throwing", async () => {
    const environment = createEnvironment({
      fetchBuildMeta: async () => {
        throw new Error("network down");
      }
    });

    await expect(checkForStaleBuildAtStartup(environment)).resolves.toBeUndefined();
  });
});

describe("logDeploymentRecoveryEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only the fields it is given - never secrets - as a single structured JSON line", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const values = new Map<string, string>();

    logDeploymentRecoveryEvent(
      "frontend.chunk_load_failed",
      {
        component: "agent-profile",
        route: "/",
        buildId: "build-a",
        category: "stale_build_suspected"
      },
      {
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
          removeItem: (key) => values.delete(key)
        },
        reload: () => undefined
      }
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(infoSpy.mock.calls[0]?.[0]))).toEqual({
      event: "frontend.chunk_load_failed",
      component: "agent-profile",
      route: "/",
      buildId: "build-a",
      category: "stale_build_suspected"
    });
  });
});
