import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupEncryptionKey,
  createBackupStorage,
  decryptBackup,
  encryptBackup,
  readBackupStorageConfig
} from "../scripts/supabase-backup-storage.mjs";

let directory: string;
const key = backupEncryptionKey("ab".repeat(32));
const environment = {
  SUPABASE_SERVICE_ROLE_KEY: "private-service-key-".repeat(3),
  BACKUP_ENCRYPTION_KEY: "ab".repeat(32)
};
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "grogoni-backup-test-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("private encrypted Supabase backups", () => {
  it("bounds transfers and rejects object-path traversal before requesting data", async () => {
    const config = readBackupStorageConfig({ ...environment, BACKUP_MAX_BYTES: "1024" });
    const source = join(directory, "grogoni-2026-10-16T00-00-00-000Z.dump");
    await writeFile(source, Buffer.alloc(2048));
    const request = vi.fn(async (url: string) =>
      url.includes("/bucket/")
        ? Response.json({ id: config.bucket, public: false })
        : new Response(new Uint8Array(2048))
    );
    const storage = createBackupStorage(config, request);
    await expect(storage.upload(source)).rejects.toThrow("size limit");
    expect(request).toHaveBeenCalledTimes(1);
    await expect(storage.download("../unrelated", join(directory, "bad.dump"))).rejects.toThrow(
      "object key"
    );
    expect(request).toHaveBeenCalledTimes(1);
    const destination = join(directory, "download.dump");
    await expect(
      storage.download(`neon/${basename(source)}.enc`, destination)
    ).rejects.toThrow("size limit");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${destination}.enc`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips authenticated encryption with fresh nonces and private files", async () => {
    const source = join(directory, "source.dump");
    await writeFile(source, "PGDMP fixture: private customer records");
    for (const name of ["first", "second"]) {
      await encryptBackup(source, join(directory, name), key);
      expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);
    }
    const first = await readFile(join(directory, "first"));
    expect(first).not.toEqual(await readFile(join(directory, "second")));
    expect(first.includes(Buffer.from("private customer records"))).toBe(false);
    await decryptBackup(join(directory, "first"), join(directory, "restored.dump"), key);
    expect(await readFile(join(directory, "restored.dump"))).toEqual(await readFile(source));
  });

  it.each(["wrong-key", "ciphertext", "header", "tag"])(
    "rejects %s without leaving plaintext",
    async (fault) => {
      const source = join(directory, "source.dump");
      const encrypted = join(directory, "encrypted");
      const restored = join(directory, "restored.dump");
      await writeFile(source, "PGDMP private fixture".repeat(50));
      await encryptBackup(source, encrypted, key);
      const data = await readFile(encrypted);
      if (fault !== "wrong-key") {
        const offset = fault === "header" ? 10 : fault === "tag" ? data.length - 1 : 30;
        data[offset] = data[offset]! ^ 1;
        await writeFile(encrypted, data);
      }
      await expect(
        decryptBackup(
          encrypted,
          restored,
          fault === "wrong-key" ? backupEncryptionKey("cd".repeat(32)) : key
        )
      ).rejects.toThrow();
      await expect(stat(restored)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("never overwrites an existing restore or encryption destination", async () => {
    const source = join(directory, "source");
    const existing = join(directory, "existing");
    await writeFile(source, "PGDMP");
    await writeFile(existing, "keep");
    await expect(encryptBackup(source, existing, key)).rejects.toMatchObject({ code: "EEXIST" });
    await encryptBackup(source, join(directory, "encrypted"), key);
    await expect(decryptBackup(join(directory, "encrypted"), existing, key)).rejects.toMatchObject({
      code: "EEXIST"
    });
    expect(await readFile(existing, "utf8")).toBe("keep");
  });

  it("rejects unrelated origins, malformed keys and unsafe bucket names", () => {
    for (const patch of [
      { BACKUP_SUPABASE_URL: "https://unrelated.example" },
      { BACKUP_SUPABASE_URL: "https://gnmndzsughifhboqvsgd.supabase.co/" },
      { BACKUP_SUPABASE_BUCKET: "../public" },
      { BACKUP_ENCRYPTION_KEY: "short" },
      { BACKUP_MAX_BYTES: "Infinity" }
    ])
      expect(() => readBackupStorageConfig({ ...environment, ...patch })).toThrow();
  });

  it.each([false, true])(
    "requires a private bucket and exact read-back checksum (corrupt=%s)",
    async (corrupt) => {
      const config = readBackupStorageConfig(environment);
      const source = join(directory, "grogoni-2026-10-16T00-00-00-000Z.dump");
      await writeFile(source, "PGDMP fixture".repeat(100));
      let stored = Buffer.alloc(0);
      const request = vi.fn(async (url: string, options: RequestInit & { duplex?: string }) => {
        expect(url.startsWith(`${config.origin}/storage/v1/`)).toBe(true);
        expect(options.redirect).toBe("error");
        if (url.includes("/bucket/")) return Response.json({ id: config.bucket, public: false });
        if (options.method === "POST") {
          expect(options.headers).toMatchObject({
            "x-upsert": "false",
            authorization: `Bearer ${config.credential}`
          });
          const chunks = [];
          for await (const chunk of options.body as unknown as AsyncIterable<Buffer>)
            chunks.push(chunk);
          stored = Buffer.concat(chunks);
          return Response.json({ Key: "stored" });
        }
        return new Response(new Uint8Array(corrupt ? stored.subarray(1) : stored));
      });
      const storage = createBackupStorage(config, request);
      if (corrupt) await expect(storage.upload(source)).rejects.toThrow("checksum");
      else {
        const result = await storage.upload(source);
        expect(result).toMatchObject({ encrypted: true, verified: true, bytes: stored.length });
        await storage.download(result.objectKey, join(directory, "restored.dump"));
        expect(await readFile(join(directory, "restored.dump"))).toEqual(await readFile(source));
      }
      await expect(stat(`${source}.enc`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("does not send data to a public bucket or expose storage error responses", async () => {
    const source = join(directory, "grogoni-2026-10-16T00-00-00-000Z.dump");
    await writeFile(source, "private");
    const config = readBackupStorageConfig(environment);
    const publicBucket = vi.fn(async () => Response.json({ id: config.bucket, public: true }));
    await expect(createBackupStorage(config, publicBucket).upload(source)).rejects.toThrow(
      "private"
    );
    expect(publicBucket).toHaveBeenCalledTimes(1);
    await expect(
      createBackupStorage(
        config,
        async () => new Response("credential-do-not-log", { status: 403 })
      ).upload(source)
    ).rejects.toThrow("HTTP 403");
    await expect(stat(`${source}.enc`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
