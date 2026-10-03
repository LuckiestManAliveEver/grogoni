import type { AuthSessionView } from "@grogoni/shared-types";
import { ApiRequestError, apiFetch } from "./lib/api";

const databaseName = "grogoni-device-recovery-v1";
const storeName = "credentials";
const primaryRecordKey = "primary";

interface StoredDeviceCredential {
  credentialId: string | null;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  createdAt: number;
}

export interface PreparedDeviceCredential {
  publicKeyJwk: JsonWebKey;
}

export async function prepareDeviceRecoveryCredential(): Promise<PreparedDeviceCredential> {
  const existing = await readCredential();
  if (existing !== null) return { publicKeyJwk: existing.publicKeyJwk };

  const generated = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify"
  ])) as CryptoKeyPair;
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", generated.publicKey),
    crypto.subtle.exportKey("jwk", generated.privateKey)
  ]);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  await writeCredential({ credentialId: null, publicKeyJwk, privateKey, createdAt: Date.now() });
  return { publicKeyJwk };
}

export async function commitDeviceRecoveryCredential(credentialId: string): Promise<void> {
  const credential = await readCredential();
  if (credential === null) throw new Error("The device recovery key is unavailable.");
  await writeCredential({ ...credential, credentialId });
}

export async function recoverDeviceAccount(): Promise<AuthSessionView | null> {
  const credential = await readCredential();
  if (credential?.credentialId === null || credential === null) return null;

  const issuedAt = Date.now();
  const nonce = createRandomValue(24);
  const payload = `grogoni-device-recovery:v1:${credential.credentialId}:${issuedAt}:${nonce}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    credential.privateKey,
    new TextEncoder().encode(payload)
  );
  try {
    return await apiFetch<AuthSessionView>("/auth/device/recover", {
      method: "POST",
      body: {
        credentialId: credential.credentialId,
        nonce,
        issuedAt,
        signature: toBase64Url(new Uint8Array(signature))
      },
      skipAuthRefresh: true
    });
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) {
      await clearDeviceRecoveryCredential();
      return null;
    }
    throw error;
  }
}

export async function clearDeviceRecoveryCredential(): Promise<void> {
  if (globalThis.indexedDB === undefined) return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(primaryRecordKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not clear device recovery storage."));
    });
  } finally {
    database.close();
  }
}

async function readCredential(): Promise<StoredDeviceCredential | null> {
  if (globalThis.indexedDB === undefined || globalThis.crypto?.subtle === undefined) return null;
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(primaryRecordKey);
      request.onsuccess = () =>
        resolve((request.result as StoredDeviceCredential | undefined) ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read device recovery storage."));
    });
  } finally {
    database.close();
  }
}

async function writeCredential(credential: StoredDeviceCredential): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(credential, primaryRecordKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not store the device recovery key."));
    });
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (globalThis.indexedDB === undefined) {
    return Promise.reject(new Error("Secure device storage is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open device recovery storage."));
  });
}

function createRandomValue(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
