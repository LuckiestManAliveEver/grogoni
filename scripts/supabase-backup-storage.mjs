import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("GROGONI1");
const headerBytes = 20;
const tagBytes = 16;
const objectPattern = /^neon\/grogoni-[0-9TZ-]+\.dump\.enc$/;

export function backupEncryptionKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error("BACKUP_ENCRYPTION_KEY must be a separate 32-byte hex key.");
  return Buffer.from(value, "hex");
}

export function readBackupStorageConfig(environment = process.env) {
  const project = environment.BACKUP_SUPABASE_PROJECT_REF ?? "gnmndzsughifhboqvsgd";
  if (!/^[a-z0-9]{20}$/.test(project)) throw new Error("Invalid backup project reference.");
  const origin = environment.BACKUP_SUPABASE_URL ?? `https://${project}.supabase.co`;
  if (origin !== `https://${project}.supabase.co`)
    throw new Error("Backup storage must use the explicitly configured Supabase project origin.");
  const bucket = environment.BACKUP_SUPABASE_BUCKET ?? "grogoni-neon-backups";
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bucket)) throw new Error("Invalid backup bucket name.");
  const credential = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!credential || credential.length < 32 || /\s/.test(credential))
    throw new Error("A server-held SUPABASE_SERVICE_ROLE_KEY is required for private backups.");
  const maxBytes = Number(environment.BACKUP_MAX_BYTES ?? 50 * 1024 * 1024);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 5 * 1024 ** 3)
    throw new Error("BACKUP_MAX_BYTES must be between 1 KiB and 5 GiB.");
  return {
    origin,
    bucket,
    credential,
    maxBytes,
    key: backupEncryptionKey(environment.BACKUP_ENCRYPTION_KEY)
  };
}

export async function encryptBackup(source, destination, key) {
  const nonce = randomBytes(12);
  const header = Buffer.concat([magic, nonce]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const output = await open(destination, "wx", 0o600);
  try {
    await pipeline(
      Readable.from(
        (async function* () {
          yield header;
          for await (const chunk of createReadStream(source)) yield cipher.update(chunk);
          yield cipher.final();
          yield cipher.getAuthTag();
        })()
      ),
      output.createWriteStream()
    );
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    await output.close();
  }
}

/** Never leave partially decrypted plaintext behind when authentication fails. */
export async function decryptBackup(source, destination, key) {
  const input = await open(source, "r");
  let output;
  try {
    const size = (await input.stat()).size;
    if (size < headerBytes + tagBytes) throw new Error("Encrypted backup is truncated.");
    const header = Buffer.alloc(headerBytes);
    const tag = Buffer.alloc(tagBytes);
    await input.read(header, 0, headerBytes, 0);
    await input.read(tag, 0, tagBytes, size - tagBytes);
    if (!header.subarray(0, magic.length).equals(magic))
      throw new Error("Unknown encrypted backup format.");
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    output = await open(destination, "wx", 0o600);
    const encrypted =
      size === headerBytes + tagBytes
        ? Readable.from([])
        : createReadStream(source, { start: headerBytes, end: size - tagBytes - 1 });
    await pipeline(encrypted, decipher, output.createWriteStream());
  } catch (error) {
    if (output) await rm(destination, { force: true });
    throw error;
  } finally {
    await output?.close();
    await input.close();
  }
}

async function digest(source) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  return hash.digest("hex");
}

export function createBackupStorage(config, request = fetch) {
  const headers = { apikey: config.credential, authorization: `Bearer ${config.credential}` };
  async function invoke(path, init = {}) {
    const response = await request(`${config.origin}/storage/v1${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(300000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Private backup storage request failed (HTTP ${response.status}).`);
    }
    return response;
  }
  async function requirePrivateBucket() {
    const bucket = await (await invoke(`/bucket/${config.bucket}`)).json();
    if (bucket.id !== config.bucket || bucket.public !== false)
      throw new Error("Backup bucket must already exist and be private.");
    return bucket;
  }
  function objectPath(key) {
    if (!objectPattern.test(key)) throw new Error("Invalid encrypted backup object key.");
    return `${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  return {
    async upload(source) {
      const file = basename(source);
      if (!/^grogoni-[0-9TZ-]+\.dump$/.test(file))
        throw new Error("Expected a timestamped pg_dump backup.");
      const bucket = await requirePrivateBucket();
      const size = (await stat(source)).size + headerBytes + tagBytes;
      if (size > config.maxBytes || (bucket.file_size_limit && size > bucket.file_size_limit))
        throw new Error("Encrypted backup exceeds the configured storage size limit.");
      const encrypted = `${source}.enc`;
      const key = `neon/${file}.enc`;
      await encryptBackup(source, encrypted, config.key);
      try {
        const bytes = (await stat(encrypted)).size;
        const sha256 = await digest(encrypted);
        const uploaded = await invoke(`/object/${objectPath(key)}`, {
          method: "POST",
          duplex: "half",
          body: createReadStream(encrypted),
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(bytes),
            "x-upsert": "false"
          }
        });
        await uploaded.body?.cancel();
        const downloaded = await invoke(`/object/authenticated/${objectPath(key)}`);
        const hash = createHash("sha256");
        let received = 0;
        if (!downloaded.body) throw new Error("Uploaded backup could not be read back.");
        for await (const chunk of downloaded.body) {
          received += chunk.length;
          if (received > bytes) throw new Error("Uploaded backup exceeds its expected length.");
          hash.update(chunk);
        }
        if (received !== bytes || hash.digest("hex") !== sha256)
          throw new Error("Uploaded backup failed read-back checksum verification.");
        return {
          bucket: config.bucket,
          objectKey: key,
          bytes,
          sha256,
          encrypted: true,
          verified: true
        };
      } finally {
        await rm(encrypted, { force: true });
      }
    },
    async download(key, destination) {
      const path = objectPath(key);
      await requirePrivateBucket();
      const encrypted = `${destination}.enc`;
      const output = await open(encrypted, "wx", 0o600);
      try {
        const response = await invoke(`/object/authenticated/${path}`);
        if (!response.body) throw new Error("Backup download returned no data.");
        let bytes = 0;
        await pipeline(
          Readable.from(
            (async function* () {
              for await (const chunk of response.body) {
                bytes += chunk.length;
                if (bytes > config.maxBytes)
                  throw new Error("Backup download exceeds its size limit.");
                yield chunk;
              }
            })()
          ),
          output.createWriteStream()
        );
        await decryptBackup(encrypted, destination, config.key);
        return { objectKey: key, authenticated: true };
      } finally {
        await output.close();
        await rm(encrypted, { force: true });
      }
    }
  };
}
