import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
  openSync,
  closeSync,
  existsSync,
  fsyncSync
} from "node:fs";
import { join } from "node:path";
import { LinkedDataCipher } from "./cipher.js";

export interface LinkedVaultOptions {
  /**
   * Rewrite a record read under a previous key with the current key (default true). A shared
   * volume turns this off: a reader that does not hold the business's lease must never write,
   * and the holder rewraps on its next ordinary write anyway.
   */
  rewrapOnRead?: boolean;
}

/** Index entries on a shared volume: one encrypted file per business, bound to its file name. */
const indexEntryAad = (fileHash: string) => `$index-entry:${fileHash}`;

/** Dedicated private volume. No plaintext temporary files; tenant ID is authenticated as AAD. */
export class LinkedSessionVault {
  private readonly cipher: LinkedDataCipher;
  private readonly rewrapOnRead: boolean;
  constructor(
    private readonly root: string,
    key: Buffer,
    previousKeys: Buffer[] = [],
    options: LinkedVaultOptions = {}
  ) {
    this.rewrapOnRead = options.rewrapOnRead ?? true;
    this.cipher = new LinkedDataCipher(key, previousKeys);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!statSync(root).isDirectory() || (statSync(root).mode & 0o077) !== 0)
      throw new Error("WhatsApp session directory must be private (mode 0700).");
  }
  private path(id: string) {
    return join(this.root, `${createHash("sha256").update(id).digest("hex")}.session`);
  }
  read(id: string): string | null {
    let bytes: Buffer;
    try {
      if (statSync(this.path(id)).size > 16 * 1024 * 1024 + 29)
        throw new Error("Encrypted session exceeds its storage limit.");
      bytes = readFileSync(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const opened = this.cipher.open(id, bytes);
    const plaintext = opened.bytes.toString("utf8");
    if (opened.usedPreviousKey && this.rewrapOnRead) this.write(id, plaintext);
    return plaintext;
  }
  write(id: string, plaintext: string): void {
    this.writeFile(this.path(id), this.cipher.seal(id, Buffer.from(plaintext, "utf8")));
  }
  private writeFile(path: string, encrypted: Buffer): void {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, encrypted);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      this.syncDirectory();
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  private syncDirectory(): void {
    const fd = openSync(this.root, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  /** Whether a record exists, without reading or decrypting it. */
  has(id: string): boolean {
    return existsSync(this.path(id));
  }
  delete(id: string): void {
    rmSync(this.path(id), { force: true });
    this.syncDirectory();
  }
  private entryHash(businessId: string) {
    return createHash("sha256").update(`$index-entry:${businessId}`).digest("hex");
  }
  /**
   * Shared-volume index: each business's entry is its own file, written only by the worker that
   * holds that business's lease, so two workers never rewrite one shared index concurrently.
   */
  writeIndexEntry(businessId: string, ownerId: string): void {
    const hash = this.entryHash(businessId);
    this.writeFile(
      join(this.root, `${hash}.index`),
      this.cipher.seal(indexEntryAad(hash), Buffer.from(JSON.stringify({ businessId, ownerId })))
    );
  }
  deleteIndexEntry(businessId: string): void {
    rmSync(join(this.root, `${this.entryHash(businessId)}.index`), { force: true });
    this.syncDirectory();
  }
  /** Every readable entry. A file whose name does not match its own business id is ignored. */
  indexEntries(): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const name of readdirSync(this.root)) {
      const hash = /^([a-f0-9]{64})\.index$/.exec(name)?.[1];
      if (!hash) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(this.root, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted meanwhile
        throw error;
      }
      if (bytes.length > 4096) continue;
      const opened = this.cipher.open(indexEntryAad(hash), bytes).bytes.toString("utf8");
      const entry = JSON.parse(opened) as {
        businessId?: unknown;
        ownerId?: unknown;
      };
      if (
        typeof entry.businessId === "string" &&
        typeof entry.ownerId === "string" &&
        this.entryHash(entry.businessId) === hash
      )
        entries[entry.businessId] = entry.ownerId;
    }
    return entries;
  }
  /** Startup IDs are in a separately encrypted index, never inferred from WhatsApp contacts. */
  count(): number {
    return readdirSync(this.root).filter((name) => name.endsWith(".session")).length;
  }
}
