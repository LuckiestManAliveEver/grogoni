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
  fsyncSync
} from "node:fs";
import { join } from "node:path";
import { LinkedDataCipher } from "./cipher.js";

/** Dedicated private volume. No plaintext temporary files; tenant ID is authenticated as AAD. */
export class LinkedSessionVault {
  private readonly cipher: LinkedDataCipher;
  constructor(
    private readonly root: string,
    key: Buffer,
    previousKeys: Buffer[] = []
  ) {
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
    if (opened.usedPreviousKey) this.write(id, plaintext);
    return plaintext;
  }
  write(id: string, plaintext: string): void {
    const encrypted = this.cipher.seal(id, Buffer.from(plaintext, "utf8"));
    const path = this.path(id);
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
  delete(id: string): void {
    rmSync(this.path(id), { force: true });
    this.syncDirectory();
  }
  /** Startup IDs are in a separately encrypted index, never inferred from WhatsApp contacts. */
  count(): number {
    return readdirSync(this.root).filter((name) => name.endsWith(".session")).length;
  }
}
