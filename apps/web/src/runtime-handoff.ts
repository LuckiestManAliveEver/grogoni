import {
  executeProviderCall,
  installOfflineRuntime,
  LocalProvider,
  scopeKey,
  type LocalRuntimeMessage,
  type Scope
} from "@grogoni/offline-runtime";
import { readCachedAuthSession } from "./auth-bootstrap";
import { clearApiRequestCache } from "./api-request-cache";
import { apiCloudFetch } from "./lib/api";
import {
  createOfflineSyncClient,
  fetchOfflineSnapshot,
  offlineDatabase,
  offlineModeEvent,
  setOfflineMode,
  currentOfflineScope
} from "./offline-runtime";
import { prepareOfflineShell } from "./offline-shell";
import { RuntimeHandoffController, type LocalHandoffHost } from "./runtime-handoff-controller";
import type { ChatMessage } from "./app-shell";

const hosts = new Map<string, LocalHandoffHost>();
const transitions = new Map<string, "offline" | "online">();
const changed = () => window.dispatchEvent(new Event(offlineModeEvent));

/** Called by bundled browser/installed-host implementations, never by model output. There is
 * deliberately no fallback registration for the independent pinned WebLLM assistant. */
export function registerLocalHandoffHost(host: LocalHandoffHost): () => void {
  hosts.set(host.id, host);
  changed();
  return () => {
    if (hosts.get(host.id) === host) hosts.delete(host.id);
    changed();
  };
}

export function runtimeTransition(scope: Scope) {
  return transitions.get(scopeKey(scope)) ?? null;
}

export async function withRuntimeTransition(
  scope: Scope,
  direction: "offline" | "online",
  action: () => Promise<void>
) {
  const key = scopeKey(scope);
  if (transitions.has(key)) throw new Error("A runtime handoff is already in progress.");
  transitions.set(key, direction);
  changed();
  try {
    await action();
  } finally {
    transitions.delete(key);
    clearApiRequestCache();
    changed();
  }
}

export async function runtimeHandoffController(): Promise<RuntimeHandoffController> {
  const db = await offlineDatabase();
  return new RuntimeHandoffController({
    db,
    hosts: () => [...hosts.values()],
    cloud: (path, body, idempotencyKey) =>
      apiCloudFetch(path, {
        ...(body === undefined ? {} : { method: "POST", body }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey })
      }),
    prepareBusiness: async (scope) => {
      await installOfflineRuntime({
        db,
        scope,
        binding: null,
        businessDataOnly: true,
        activate: false,
        snapshot: () => fetchOfflineSnapshot(scope),
        estimate: () => navigator.storage.estimate(),
        prepareShell: prepareOfflineShell,
        progress: () => undefined
      });
    },
    syncBusiness: async (scope) => {
      await (await createOfflineSyncClient(scope)).sync();
    },
    activate: setOfflineMode,
    executeTool: async (scope, operation, args) => {
      const { runLocalOcr } = await import("./offline-ocr");
      return executeProviderCall(
        operation,
        args,
        [new LocalProvider(db, scope, undefined, runLocalOcr)],
        {
          online: false,
          offlineModeActive: true,
          localAuthorized: true
        }
      );
    },
    lock: async (scope, action) => {
      if (!navigator.locks)
        throw new Error("This browser cannot safely coordinate runtime handoffs across tabs.");
      return await navigator.locks.request(
        "grogoni-runtime-handoff",
        { ifAvailable: true },
        (lock) => {
          if (!lock)
            throw new Error(
              "Another tab is using this runtime. Wait for its turn or handoff to finish."
            );
          return action();
        }
      );
    },
    assertAuthorized: (scope) => {
      if (readCachedAuthSession()?.account.id !== scope.accountId)
        throw new Error("Sign in to the owning account to resume this runtime.");
      const active = currentOfflineScope();
      if (active && scopeKey(active) !== scopeKey(scope))
        throw new Error(
          "Return the other shop's offline runtime online before moving this conversation."
        );
    },
    changed
  });
}

export function localRuntimeMessages(messages: ChatMessage[]): LocalRuntimeMessage[] {
  return messages
    .filter((message) => message.author !== "contact")
    .map((message) => ({
      id: message.id,
      role: message.author === "merchant" ? "user" : "assistant",
      content: message.body,
      createdAt: message.createdAt ?? new Date().toISOString()
    }));
}

export function handoffChatMessages(messages: LocalRuntimeMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    author: message.role === "user" ? "merchant" : "grogoniclaw",
    body: message.content,
    createdAt: message.createdAt,
    status: "delivered"
  }));
}
