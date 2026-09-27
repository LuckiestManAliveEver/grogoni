/**
 * Centralized recovery for lazy/dynamic-imported UI after a frontend deployment replaces the
 * assets an already-open tab is still running against (see docs/architecture/
 * frontend-deployment-recovery.md). Every `lazy()` import in the app - Account and Agent
 * Settings included - is expected to route through `loadLazyModuleWithRecovery` instead of
 * calling `import()` directly, and every lazy `<Suspense>` boundary is wrapped in
 * `LazyModuleErrorBoundary`, so recovery logic lives in exactly one place.
 */

const recoveryKeyPrefix = "soko.lazy-module-recovery.v1";
const deploymentRecoveryMarkerKey = "soko.deployment-recovery.v1";
const deploymentRecoveryMarkerTtlMs = 5 * 60 * 1000;

export const agentProfileModuleKeys = {
  surface: "agent-profile",
  modelPanel: "agent-model-panel",
  identitySecurityPanel: "identity-security-panel",
  aiProvidersPanel: "ai-providers-panel"
} as const;

/** Lazy panels and cards of the owner app (apps/web/src/soko-application-shared.ts). */
export const ownerModuleKeys = {
  productCaptureItemsCard: "product-capture-items-card",
  productManagementCard: "product-management-card",
  supplierManagementCard: "supplier-management-card",
  customerManagementCard: "customer-management-card",
  invoiceManagementCard: "invoice-management-card",
  paymentManagementCard: "payment-management-card",
  importManagementCard: "import-management-card",
  logisticsManagementCard: "logistics-management-card",
  statusBroadcastCard: "status-broadcast-card",
  unifiedCartSummary: "unified-cart-summary",
  fulfilmentSplitCard: "fulfilment-split-card",
  accountRestorationPanel: "account-restoration-panel",
  smsHandoffDialog: "sms-handoff-dialog",
  phoneFirstAuthentication: "phone-first-authentication",
  phoneSignup: "phone-signup",
  productCapturePanel: "product-capture-panel",
  accountBackendControls: "account-backend-controls"
} as const;

/** Lazy panels inside the owner app's workspace drawer. */
export const workspaceModuleKeys = {
  shopHub: "shop-hub",
  phoneContacts: "phone-contacts",
  connectionRequests: "connection-requests",
  supplierSurface: "workspace-suppliers",
  posTerminal: "workspace-pos",
  importSurface: "workspace-imports",
  logisticsSurface: "workspace-logistics",
  complianceSurface: "workspace-compliance",
  betaSurface: "workspace-beta",
  launchSurface: "workspace-launch"
} as const;

/** Other top-level lazy routes (apps/web/src/AppRouter.tsx) that share this same mechanism. */
export const appRouteModuleKeys = {
  ownerApp: "owner-app",
  publicStorefront: "public-storefront",
  termsOfService: "terms-of-service",
  privacyPolicy: "privacy-policy",
  accountDeletion: "account-deletion"
} as const;

export interface BuildMeta {
  buildId: string;
}

export interface LazyModuleRecoveryEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  reload: () => void;
  /** Defaults to the client's compiled-in build id (`__GIT_COMMIT_SHA__`). Overridable for tests. */
  buildId?: string;
  /** Defaults to `navigator.onLine`. A chunk fetch failing while offline is not a stale build. */
  isOnline?: () => boolean;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a console.info structured JSON line. Never receives auth/session data. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Defaults to fetching /build-meta.json with `cache: "no-store"`. */
  fetchBuildMeta?: () => Promise<BuildMeta | null>;
}

interface ResolvedEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  reload: () => void;
  buildId: string;
  isOnline: () => boolean;
  now: () => number;
  log: (event: string, fields: Record<string, unknown>) => void;
  fetchBuildMeta: () => Promise<BuildMeta | null>;
}

interface DeploymentRecoveryMarker {
  buildId: string;
  attempts: number;
  firstAttemptAt: number;
}

function browserRecoveryEnvironment(): LazyModuleRecoveryEnvironment {
  return {
    storage: window.sessionStorage,
    reload: () => window.location.reload()
  };
}

function resolveEnvironment(environment: LazyModuleRecoveryEnvironment): ResolvedEnvironment {
  return {
    storage: environment.storage,
    reload: environment.reload,
    buildId: environment.buildId ?? __GIT_COMMIT_SHA__,
    isOnline: environment.isOnline ?? defaultIsOnline,
    now: environment.now ?? (() => Date.now()),
    log: environment.log ?? defaultLog,
    fetchBuildMeta: environment.fetchBuildMeta ?? defaultFetchBuildMeta
  };
}

function defaultIsOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function defaultLog(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...fields }));
}

async function defaultFetchBuildMeta(): Promise<BuildMeta | null> {
  const response = await fetch("/build-meta.json", { cache: "no-store" });
  if (!response.ok) return null;
  const data: unknown = await response.json();
  const buildId =
    typeof data === "object" && data !== null && "buildId" in data
      ? (data as { buildId: unknown }).buildId
      : undefined;
  return typeof buildId === "string" ? { buildId } : null;
}

function safeRoute(): string {
  try {
    return typeof window === "undefined" ? "unknown" : window.location.pathname;
  } catch {
    return "unknown";
  }
}

function recoveryKey(moduleKey: string): string {
  return `${recoveryKeyPrefix}.${moduleKey}`;
}

/**
 * Recognizes the chunk-load failure signatures thrown by supported browsers/bundlers when a
 * dynamically-imported module (or its own CSS) 404s - the signature a stale, already-open tab
 * hits after a new deployment has replaced its hashed asset filenames.
 */
export function isLazyModuleLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "ChunkLoadError" ||
    /(?:failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading chunk [\w.-]+ failed|loading css chunk [\w.-]+ failed|networkerror when attempting to fetch resource)/iu.test(
      error.message
    )
  );
}

export function hasPendingLazyModuleRecovery(
  moduleKey: string,
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): boolean {
  return environment.storage.getItem(recoveryKey(moduleKey)) !== null;
}

function readMarker(environment: ResolvedEnvironment): DeploymentRecoveryMarker | null {
  const raw = environment.storage.getItem(deploymentRecoveryMarkerKey);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeploymentRecoveryMarker>;
    if (
      typeof parsed.buildId !== "string" ||
      typeof parsed.attempts !== "number" ||
      typeof parsed.firstAttemptAt !== "number"
    ) {
      return null;
    }
    return {
      buildId: parsed.buildId,
      attempts: parsed.attempts,
      firstAttemptAt: parsed.firstAttemptAt
    };
  } catch {
    return null;
  }
}

function writeMarker(environment: ResolvedEnvironment, marker: DeploymentRecoveryMarker): void {
  environment.storage.setItem(deploymentRecoveryMarkerKey, JSON.stringify(marker));
}

function clearMarker(environment: ResolvedEnvironment): void {
  environment.storage.removeItem(deploymentRecoveryMarkerKey);
}

type RecoveryDecision =
  | { action: "reload" }
  | { action: "give_up"; category: "offline" | "loop_guard" | "component_exception" };

function decideRecovery(error: unknown, environment: ResolvedEnvironment): RecoveryDecision {
  if (!isLazyModuleLoadError(error)) return { action: "give_up", category: "component_exception" };
  if (!environment.isOnline()) return { action: "give_up", category: "offline" };

  const marker = readMarker(environment);
  const expired =
    marker !== null && environment.now() - marker.firstAttemptAt > deploymentRecoveryMarkerTtlMs;
  const sameBuildAlreadyAttempted =
    marker !== null && marker.buildId === environment.buildId && marker.attempts >= 1 && !expired;

  return sameBuildAlreadyAttempted
    ? { action: "give_up", category: "loop_guard" }
    : { action: "reload" };
}

/** Registered by whichever part of the app owns recoverable client state (draft text, active
 * conversation, navigation target) so it can flush that state to durable storage the instant
 * before a deployment-recovery reload fires - never blocking recovery on a flush failure. */
const preReloadFlushHooks = new Set<() => void>();

export function registerPreReloadFlush(hook: () => void): () => void {
  preReloadFlushHooks.add(hook);
  return () => {
    preReloadFlushHooks.delete(hook);
  };
}

function runPreReloadFlushes(): void {
  for (const hook of preReloadFlushHooks) {
    try {
      hook();
    } catch (error) {
      console.warn("[Soko.market] A pre-reload state flush failed; continuing recovery.", error);
    }
  }
}

export function logDeploymentRecoveryEvent(
  event: string,
  fields: Record<string, unknown>,
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): void {
  resolveEnvironment(environment).log(event, fields);
}

export function currentDeploymentBuildId(
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): string {
  return resolveEnvironment(environment).buildId;
}

/**
 * Wraps a lazy `import()` (or a module-warming promise, e.g. `initialAgentModelPanelModule`) with
 * deployment-safe recovery. On a confirmed stale-build chunk failure, while online, and only once
 * per build transition, this flushes recoverable state, marks the panel to reopen after reload,
 * and performs exactly one `reload()` - see docs/architecture/frontend-deployment-recovery.md.
 */
export async function loadLazyModuleWithRecovery<T>(
  moduleKey: string,
  load: () => Promise<T>,
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): Promise<T> {
  const env = resolveEnvironment(environment);
  try {
    const module = await load();
    env.storage.removeItem(recoveryKey(moduleKey));
    return module;
  } catch (error) {
    const route = safeRoute();
    const decision = decideRecovery(error, env);

    if (decision.action === "reload") {
      const marker = readMarker(env);
      const attempts = marker !== null && marker.buildId === env.buildId ? marker.attempts + 1 : 1;
      const firstAttemptAt =
        marker !== null && marker.buildId === env.buildId ? marker.firstAttemptAt : env.now();

      env.log("frontend.chunk_load_failed", {
        component: moduleKey,
        route,
        buildId: env.buildId,
        category: "stale_build_suspected"
      });
      env.log("frontend.stale_build_detected", {
        component: moduleKey,
        route,
        buildId: env.buildId
      });
      writeMarker(env, { buildId: env.buildId, attempts, firstAttemptAt });
      env.storage.setItem(recoveryKey(moduleKey), "pending");
      env.log("frontend.recovery_started", {
        component: moduleKey,
        route,
        buildId: env.buildId,
        attempt: attempts
      });
      runPreReloadFlushes();
      env.reload();
    } else {
      env.log("frontend.chunk_load_failed", {
        component: moduleKey,
        route,
        buildId: env.buildId,
        category: decision.category
      });
      if (decision.category === "loop_guard") {
        env.log("frontend.recovery_failed", {
          component: moduleKey,
          route,
          buildId: env.buildId,
          reason: "loop_guard"
        });
      }
    }

    throw error;
  }
}

/** A user-initiated retry (the boundary's "Reload and try again" button). Always performs one
 * more reload, resetting the automatic loop guard, since an explicit click is not a loop. */
export function retryLazyModuleLoad(
  moduleKey: string,
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): void {
  const env = resolveEnvironment(environment);
  env.storage.removeItem(recoveryKey(moduleKey));
  clearMarker(env);
  env.log("frontend.recovery_started", {
    component: moduleKey,
    route: safeRoute(),
    buildId: env.buildId,
    attempt: 1,
    trigger: "manual"
  });
  runPreReloadFlushes();
  env.reload();
}

/** Call once at app boot (see apps/web/src/main.tsx). If a prior automatic recovery reload landed
 * on a different build than the one that failed, recovery worked - log it and clear the marker.
 * If it's still the same build, leave the marker so a repeat failure trips the loop guard. */
export function consumeDeploymentRecoveryOutcome(
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): void {
  const env = resolveEnvironment(environment);
  const marker = readMarker(env);
  if (marker === null) return;
  if (marker.buildId !== env.buildId) {
    env.log("frontend.recovery_completed", {
      buildId: env.buildId,
      previousBuildId: marker.buildId,
      attempts: marker.attempts
    });
    clearMarker(env);
  }
}

/** Call once at app boot. Best-effort, no polling: compares the compiled-in build id against the
 * server's current build-meta.json (fetched with `cache: "no-store"` to bypass HTTP/SW caching).
 * Only used for observability - it never forces a reload on its own. */
export async function checkForStaleBuildAtStartup(
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): Promise<void> {
  const env = resolveEnvironment(environment);
  if (!env.isOnline()) return;
  try {
    const meta = await env.fetchBuildMeta();
    if (meta !== null && meta.buildId !== env.buildId) {
      env.log("frontend.stale_build_detected", {
        buildId: env.buildId,
        serverBuildId: meta.buildId,
        route: safeRoute(),
        trigger: "startup"
      });
    }
  } catch {
    // Best-effort only; a startup connectivity hiccup must never block app boot.
  }
}

/** Convenience for apps/web/src/main.tsx: runs the outcome check then the startup staleness check. */
export function runDeploymentRecoveryStartupChecks(
  environment: LazyModuleRecoveryEnvironment = browserRecoveryEnvironment()
): void {
  consumeDeploymentRecoveryOutcome(environment);
  void checkForStaleBuildAtStartup(environment);
}
