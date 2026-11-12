import { describe, expect, it } from "vitest";
import {
  createCipherAwareAttachmentBlobStore,
  createMemoryConversationAttachmentBlobStore
} from "../../cp2/conversation-attachment-blob-store.js";
import { LinkedDataCipher } from "./cipher.js";

const prefix = "encrypted/whatsapp-linked/";
const storageKey = `${prefix}business/attachment`;
const bytes = Buffer.from("PRIVATE_MEDIA_CANARY");
const blob = { storageKey, bytes, checksum: "unused", mimeType: "image/png" };
describe("encrypted managed WhatsApp media", () => {
  it("encrypts bytes in the existing store and authenticates their full tenant/object key", async () => {
    const base = createMemoryConversationAttachmentBlobStore();
    const store = createCipherAwareAttachmentBlobStore(base);
    store.registerCipher(prefix, new LinkedDataCipher(Buffer.alloc(32, 7)));
    await store.put(blob);
    const encrypted = (await base.get(storageKey))!;
    expect(encrypted.includes(bytes)).toBe(false);
    expect(await store.get(storageKey)).toEqual(bytes);
    const otherKey = `${prefix}other-business/attachment`;
    await base.put({ ...blob, storageKey: otherKey, bytes: encrypted });
    await expect(store.get(otherKey)).rejects.toThrow();
    await expect(createCipherAwareAttachmentBlobStore(base).get(storageKey)).rejects.toThrow(
      "key is unavailable"
    );
  });
  it("rewraps stored media on read and preserves ordinary channel storage", async () => {
    const base = createMemoryConversationAttachmentBlobStore();
    const store = createCipherAwareAttachmentBlobStore(base);
    const oldKey = Buffer.alloc(32, 7),
      nextKey = Buffer.alloc(32, 8);
    const remove = store.registerCipher(prefix, new LinkedDataCipher(oldKey));
    await store.put(blob);
    const previous = await base.get(storageKey);
    remove();
    const removeRotated = store.registerCipher(prefix, new LinkedDataCipher(nextKey, [oldKey]));
    expect(await store.get(storageKey)).toEqual(bytes);
    expect(await base.get(storageKey)).not.toEqual(previous);
    removeRotated();
    store.registerCipher(prefix, new LinkedDataCipher(nextKey));
    expect(await store.get(storageKey)).toEqual(bytes);
    await store.put({ ...blob, storageKey: "conversation-attachments/ordinary" });
    expect(await base.get("conversation-attachments/ordinary")).toEqual(bytes);
  });
});
