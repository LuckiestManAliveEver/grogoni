import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Shared authenticated envelope for private session records and managed media blobs. */
export class LinkedDataCipher {
  constructor(
    private readonly key: Buffer,
    private readonly previousKeys: Buffer[] = []
  ) {
    if (
      key.length !== 32 ||
      previousKeys.length > 3 ||
      previousKeys.some((entry) => entry.length !== 32)
    )
      throw new Error(
        "Linked data requires a 32-byte current key and at most three previous keys."
      );
  }
  seal(id: string, plaintext: Buffer): Buffer {
    if (plaintext.length > 16 * 1024 * 1024)
      throw new Error("Linked data exceeds its storage limit.");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  }
  open(id: string, encrypted: Buffer): { bytes: Buffer; usedPreviousKey: boolean } {
    if (encrypted.length < 29 || encrypted.length > 16 * 1024 * 1024 + 29 || encrypted[0] !== 1)
      throw new Error("Invalid encrypted linked data.");
    for (const [index, key] of [this.key, ...this.previousKeys].entries()) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(1, 13));
        decipher.setAAD(Buffer.from(id));
        decipher.setAuthTag(encrypted.subarray(13, 29));
        return {
          bytes: Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]),
          usedPreviousKey: index > 0
        };
      } catch (error) {
        if (index === this.previousKeys.length) throw error;
      }
    }
    throw new Error("Cannot decrypt linked data.");
  }
}
