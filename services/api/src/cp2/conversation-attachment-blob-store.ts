export interface ConversationAttachmentBlob {
  storageKey: string;
  bytes: Buffer;
  checksum: string;
  mimeType: string;
}

export interface ConversationAttachmentBlobStore {
  put(blob: ConversationAttachmentBlob): Promise<void>;
  get(storageKey: string): Promise<Buffer | null>;
  delete(storageKey: string): Promise<void>;
}

/** Preserve the existing blob store and authorization path; encrypted namespaces fail closed
 * when their key is unavailable. Other channels retain their existing storage behavior.
 */
export function createCipherAwareAttachmentBlobStore(base: ConversationAttachmentBlobStore) {
  const ciphers = new Map<string, AttachmentBlobCipher>();
  const cipherFor = (key: string) => {
    const cipher = [...ciphers].find(([prefix]) => key.startsWith(prefix))?.[1];
    if (key.startsWith("encrypted/") && !cipher)
      throw new Error("Encrypted attachment key is unavailable.");
    return cipher;
  };
  const put = async (blob: ConversationAttachmentBlob) => {
    const cipher = cipherFor(blob.storageKey);
    const bytes = cipher ? cipher.seal(blob.storageKey, blob.bytes) : blob.bytes;
    await base.put(
      cipher
        ? {
            ...blob,
            bytes,
            checksum: createHash("sha256").update(bytes).digest("hex"),
            mimeType: "application/octet-stream"
          }
        : blob
    );
  };
  return {
    put,
    async get(storageKey: string) {
      const cipher = cipherFor(storageKey);
      const stored = await base.get(storageKey);
      if (!stored || !cipher) return stored;
      const opened = cipher.open(storageKey, stored);
      if (opened.usedPreviousKey)
        await put({
          storageKey,
          bytes: opened.bytes,
          checksum: "",
          mimeType: "application/octet-stream"
        });
      return opened.bytes;
    },
    delete: (storageKey: string) => base.delete(storageKey),
    registerCipher(prefix: string, cipher: AttachmentBlobCipher): () => void {
      if (!prefix.startsWith("encrypted/") || !prefix.endsWith("/") || ciphers.has(prefix))
        throw new Error("Invalid or duplicate attachment encryption namespace.");
      ciphers.set(prefix, cipher);
      return () => {
        if (ciphers.get(prefix) === cipher) ciphers.delete(prefix);
      };
    }
  };
}

/**
 * Process-local implementation used by the explicit memory store and tests. Production Postgres
 * stores inject the bytea-backed implementation from postgres-store.ts instead.
 */
export function createMemoryConversationAttachmentBlobStore(): ConversationAttachmentBlobStore {
  const blobs = new Map<string, Buffer>();
  return {
    async put(blob) {
      blobs.set(blob.storageKey, Buffer.from(blob.bytes));
    },
    async get(storageKey) {
      const bytes = blobs.get(storageKey);
      return bytes === undefined ? null : Buffer.from(bytes);
    },
    async delete(storageKey) {
      blobs.delete(storageKey);
    }
  };
}
import { createHash } from "node:crypto";

export interface AttachmentBlobCipher {
  seal(id: string, plaintext: Buffer): Buffer;
  open(id: string, encrypted: Buffer): { bytes: Buffer; usedPreviousKey: boolean };
}
