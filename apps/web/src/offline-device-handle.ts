const dbName = "grogoni-offline-device-handle";
const storeName = "handles";
const handleKey = "removable-directory";

function openHandleStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** FileSystemDirectoryHandle is structured-cloneable, so it can round-trip through IndexedDB;
 *  the browser still requires the user's permission to be re-granted each session. */
export async function saveRemovableDeviceHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(handle, handleKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadRemovableDeviceHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleStore();
  try {
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get(handleKey);
      request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle) ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function clearRemovableDeviceHandle(): Promise<void> {
  const db = await openHandleStore();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(handleKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
