import { emptyState, scopeKey, type LocalState, type Scope } from "../types.js";
import type { LocalDatabase } from "./client.js";

/** Chrome/Edge ship these on FileSystemHandle and Window; TypeScript's DOM lib does not
 *  declare them yet because the permissions part of the File System Access API is still
 *  outside the stable spec that lib.dom.d.ts tracks. */
declare global {
  interface FileSystemHandle {
    queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  }
  interface Window {
    showDirectoryPicker?(options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
}

const rootFolderName = "grogoni-offline-runtime";

export function supportsRemovableDevice(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickRemovableDevice(): Promise<FileSystemDirectoryHandle> {
  if (!supportsRemovableDevice())
    throw new Error("This browser cannot write to a removable device. Use local storage instead.");
  return window.showDirectoryPicker!({ id: rootFolderName, mode: "readwrite" });
}

async function ensureWritePermission(handle: FileSystemDirectoryHandle): Promise<void> {
  const granted = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (granted === "granted") return;
  const requested = await handle.requestPermission?.({ mode: "readwrite" });
  if (requested !== "granted")
    throw new Error("Permission to write to the removable device was not granted.");
}

function stateFileName(scope: Scope): string {
  return `${scopeKey(scope).replace(/[^a-zA-Z0-9]+/g, "_")}.json`;
}

/** Mirrors openLocalDatabase's shape (one JSON blob per scope) but persists it as a file on a
 *  user-picked removable device instead of IndexedDB. Reads/writes for a given scope are
 *  serialized through an in-memory queue since the File System Access API has no notion of a
 *  transaction of its own. */
export async function openRemovableDatabase(
  root: FileSystemDirectoryHandle
): Promise<LocalDatabase> {
  await ensureWritePermission(root);
  const folder = await root.getDirectoryHandle(rootFolderName, { create: true });
  const queue = new Map<string, Promise<unknown>>();
  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (queue.get(key) ?? Promise.resolve()).then(task, task);
    queue.set(
      key,
      next.catch(() => {})
    );
    return next;
  }
  async function readState(scope: Scope): Promise<LocalState> {
    try {
      const handle = await folder.getFileHandle(stateFileName(scope));
      const text = await (await handle.getFile()).text();
      return JSON.parse(text) as LocalState;
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return emptyState(scope);
      throw error;
    }
  }
  async function writeState(scope: Scope, state: LocalState): Promise<void> {
    const handle = await folder.getFileHandle(stateFileName(scope), { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(JSON.stringify(state));
    } finally {
      await writable.close();
    }
  }
  return {
    read: (scope) => serialize(stateFileName(scope), () => readState(scope)),
    transaction: (scope, change) =>
      serialize(stateFileName(scope), async () => {
        const state = await readState(scope);
        const result = change(state);
        if (result instanceof Promise)
          throw new Error("Local transactions cannot await external work.");
        await writeState(scope, state);
        return result;
      }),
    close: () => {}
  };
}
