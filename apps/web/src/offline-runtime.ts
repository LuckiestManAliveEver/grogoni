import {
  openLocalDatabase,
  openRemovableDatabase,
  supportsRemovableDevice,
  pickRemovableDevice,
  LocalProvider,
  executeProviderCall,
  SyncClient,
  OfflineError,
  type LocalDatabase,
  type Scope,
  type LocalState,
  type InstallSnapshot,
  type InstalledRuntimeAdapter,
  type RuntimeBinding
} from "@grogoni/offline-runtime";
import { readCachedAuthSession } from "./auth-bootstrap";
import { activateOfflineShell } from "./offline-shell";
import { loadRemovableDeviceHandle, saveRemovableDeviceHandle } from "./offline-device-handle";
import { createWebLLMRuntimeAdapter, resolveWebLLMRuntimeBinding } from "./webllm-runtime";

const modeKey = "grogoni.offline-runtime.active.v1";
const storageTargetKey = "grogoni.offline-runtime.storage-target.v1";
let database: Promise<LocalDatabase> | null = null;
let adapter: InstalledRuntimeAdapter | undefined;
let binding: RuntimeBinding | null = null;
let installedRuntimeReady: Promise<void> | null = null;

/**
 * Resolves and registers the on-device WebLLM runtime adapter, lazily and only once. Callers
 * trigger this only from an explicit user action (opting into AI install, or asking the offline
 * assistant something) - never on page load - so it never turns "go offline with business data
 * only" into a surprise network call for a feature the merchant didn't ask for.
 */
export function ensureInstalledOfflineRuntime(): Promise<void> {
  return (installedRuntimeReady ??= resolveWebLLMRuntimeBinding()
    .then((resolvedBinding) => {
      registerInstalledOfflineRuntime(createWebLLMRuntimeAdapter(), resolvedBinding);
    })
    .catch((error) => {
      installedRuntimeReady = null;
      throw error;
    }));
}
export const offlineRuntimeEnabled = import.meta.env.VITE_OFFLINE_RUNTIME_ENABLED === "true";
export const offlineModeEvent = "grogoni:offline-mode-changed";
export type StorageTarget = "local" | "removable";
export { supportsRemovableDevice, pickRemovableDevice };

export function currentStorageTarget(): StorageTarget {
  return localStorage.getItem(storageTargetKey) === "removable" ? "removable" : "local";
}

/** Switches which backend offlineDatabase() opens next. Called before installing (or when
 *  reconnecting a removable device); closes whatever is currently open first so the two
 *  backends are never touched concurrently. */
export async function useStorageTarget(
  target: StorageTarget,
  handle?: FileSystemDirectoryHandle
): Promise<void> {
  if (database) (await database).close();
  database = null;
  if (target === "removable" && handle) await saveRemovableDeviceHandle(handle);
  localStorage.setItem(storageTargetKey, target);
}

async function openDatabaseForCurrentTarget(): Promise<LocalDatabase> {
  if (currentStorageTarget() === "removable") {
    const handle = await loadRemovableDeviceHandle();
    if (!handle)
      throw new OfflineError(
        "DEVICE_NOT_FOUND",
        "Reconnect your removable device in Offline runtime settings to continue."
      );
    return openRemovableDatabase(handle);
  }
  return openLocalDatabase();
}

export function offlineDatabase(): Promise<LocalDatabase> {
  return (database ??= openDatabaseForCurrentTarget().catch((error) => {
    database = null;
    throw error;
  }));
}
export function currentOfflineScope(): Scope | null {
  try {
    const value = JSON.parse(localStorage.getItem(modeKey) ?? "null") as Scope | null;
    const account = readCachedAuthSession()?.account.id;
    return value &&
      value.accountId === account &&
      typeof value.storeId === "string" &&
      typeof value.deviceId === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
export function isExplicitOfflineMode(): boolean {
  return currentOfflineScope() !== null;
}
export async function setOfflineMode(scope: Scope, active: boolean): Promise<void> {
  const db = await offlineDatabase();
  await db.transaction(scope, (state) => {
    if (active && !state.installed) throw new Error("Install offline business data first.");
    const session = state.runtimeHandoffSession;
    if (
      !active &&
      session &&
      session.status !== "hosted" &&
      (session.status !== "returning" ||
        session.handoff.runtime.executionHostId !== session.hostedExecutionHostId)
    )
      throw new Error(
        "Use Runtime Handoff to resume the hosted agent before changing offline routing."
      );
    if (
      !active &&
      (state.conflicts.length ||
        state.operations.some((operation) => operation.syncStatus !== "ACKED") ||
        state.runtimeHandoffSession?.pendingMessages.length ||
        state.runtimeHandoffSession?.checkpoints.length)
    )
      throw new Error("Sync or resolve all pending changes before going online.");
    state.offlineModeActive = active;
  });
  if (active) localStorage.setItem(modeKey, JSON.stringify(scope));
  else localStorage.removeItem(modeKey);
  await activateOfflineShell(active);
  window.dispatchEvent(new Event(offlineModeEvent));
}
export function clearOfflineSession(): void {
  localStorage.removeItem(modeKey);
  window.dispatchEvent(new Event(offlineModeEvent));
}
export async function routeOfflineRequest<T>(
  path: string,
  method: string,
  body: unknown
): Promise<T> {
  const scope = currentOfflineScope();
  if (!scope) throw new Error("The offline account is no longer signed in.");
  const match =
    /^\/businesses\/([^/]+)\/(products|customers|invoices|storefront\/orders|receipt-ocr\/jobs|product-captures)(?:\/([^/]+))?(?:\/(stock-adjustments|confirm))?$/.exec(
      path
    );
  const resource = match?.[2];
  const id = match?.[3];
  const subAction = match?.[4];
  let op = "unsupported";
  if (match && decodeURIComponent(match[1]!) === scope.storeId) {
    if (method === "GET" && !id)
      op = (
        {
          products: "catalogue.list",
          customers: "customers.list",
          invoices: "invoices.list",
          "storefront/orders": "orders.list",
          "receipt-ocr/jobs": "receipts.ocr.list",
          "product-captures": "productCaptures.ocr.list"
        } as Record<string, string>
      )[resource!]!;
    if (method === "GET" && resource === "products" && id === "fields") op = "catalogue.fields";
    if (method === "POST" && resource === "products" && !id) op = "catalogue.create";
    if (method === "PATCH" && resource === "products" && id) op = "catalogue.update";
    if (method === "POST" && resource === "products" && id && subAction === "stock-adjustments")
      op = "inventory.adjust";
    if (method === "POST" && resource === "customers" && !id) op = "customers.create";
    if (method === "POST" && resource === "receipt-ocr/jobs" && !id) op = "receipts.ocr.create";
    if (method === "POST" && resource === "product-captures" && !id)
      op = "productCaptures.ocr.create";
    if (method === "POST" && resource === "invoices" && !id) op = "orders.createInvoice";
    if (method === "PATCH" && resource === "invoices" && id && !subAction)
      op = "orders.updateInvoice";
    if (method === "POST" && resource === "invoices" && id && subAction === "confirm")
      op = "orders.confirmInvoice";
  }
  const db = await offlineDatabase();
  const { runLocalOcr } = await import("./offline-ocr");
  const local = new LocalProvider(
    db,
    scope,
    adapter ? (pin, args) => adapter!.infer(pin, args) : undefined,
    runLocalOcr
  );
  const result = await executeProviderCall<T>(
    op,
    { ...(id ? { id: decodeURIComponent(id) } : {}), body },
    [local],
    {
      online: navigator.onLine,
      offlineModeActive: true,
      localAuthorized: true
    }
  );
  if (method !== "GET") window.dispatchEvent(new Event(offlineModeEvent));
  return result;
}
/** A compatible installed shell registers its executable runtime and immutable artifact manifest. */
export function registerInstalledOfflineRuntime(
  value: InstalledRuntimeAdapter,
  manifest: RuntimeBinding
): void {
  adapter = value;
  binding = manifest;
}
export function installedOfflineRuntime(): {
  adapter: InstalledRuntimeAdapter | undefined;
  binding: RuntimeBinding | null;
} {
  return { adapter, binding };
}
export async function getOfflineState(scope: Scope): Promise<LocalState> {
  return (await offlineDatabase()).read(scope);
}
export async function createOfflineSyncClient(scope: Scope): Promise<SyncClient> {
  const { apiCloudFetch } = await import("./lib/api");
  return new SyncClient(await offlineDatabase(), scope, {
    push: (ops) => apiCloudFetch("/sync/push", { method: "POST", body: { ops } }),
    pull: (cursor) =>
      apiCloudFetch(
        `/sync/pull?storeId=${encodeURIComponent(scope.storeId)}${cursor === null ? "" : `&since=${encodeURIComponent(cursor)}`}`
      )
  });
}
export async function fetchOfflineSnapshot(scope: Scope): Promise<InstallSnapshot> {
  const { apiCloudFetch } = await import("./lib/api");
  return apiCloudFetch(`/businesses/${encodeURIComponent(scope.storeId)}/offline-runtime/snapshot`);
}
/** Re-requests permission on the previously picked removable device (browsers drop write
 *  permission on a stored FileSystemDirectoryHandle between sessions) and reopens it. Must be
 *  called from a user gesture, since requestPermission requires one. */
export async function reconnectRemovableDevice(): Promise<void> {
  const handle = await loadRemovableDeviceHandle();
  if (!handle) throw new Error("No removable device is on record. Choose one again to reconnect.");
  if (database) (await database).close();
  database = null;
  await openRemovableDatabase(handle);
  database = null;
}
/**
 * Calls the pinned on-device model through the same LocalProvider/resolver path business-data
 * mutations use, rather than a bespoke call site - so agent.infer gets the same "unavailable
 * offline" and pin-mismatch handling as every other offline-relevant operation.
 */
export async function askOfflineAssistant(
  scope: Scope,
  request: { prompt: string; history?: Array<{ role: "user" | "assistant"; content: string }> }
): Promise<unknown> {
  await ensureInstalledOfflineRuntime();
  const db = await offlineDatabase();
  const runtime = installedOfflineRuntime();
  const local = new LocalProvider(
    db,
    scope,
    runtime.adapter ? (pin, args) => runtime.adapter!.infer(pin, args) : undefined
  );
  return executeProviderCall("agent.infer", request, [local], {
    online: navigator.onLine,
    offlineModeActive: true,
    localAuthorized: true
  });
}
