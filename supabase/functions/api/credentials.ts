import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { Buffer } from "node:buffer";

export interface AuthSecrets {
  pin: string;
  password: string;
  audit: string;
  encryption: string;
}

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function correlation(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function credentialHash(accountId: string, value: string, secret: string, pin: boolean) {
  const salt = randomBytes(16);
  const cost = pin ? 16384 : 32768;
  const key = scryptSync(`${accountId}:${value}:${secret}`, salt, 32, {
    N: cost,
    r: 8,
    p: 1,
    maxmem: 96 * 1024 * 1024
  });
  return [
    "scrypt",
    pin ? "v2" : "password-v1",
    cost,
    8,
    1,
    salt.toString("base64url"),
    key.toString("base64url")
  ].join("$");
}

export function verifyCredential(
  accountId: string,
  value: string,
  stored: string,
  secret: string,
  pin: boolean
): "current" | "legacy" | "invalid" {
  if (pin && /^[a-f0-9]{64}$/.test(stored)) {
    return timingSafeEqual(
      Buffer.from(hash(`${accountId}:${value}`), "hex"),
      Buffer.from(stored, "hex")
    )
      ? "legacy"
      : "invalid";
  }
  const parts = stored.split("$");
  const cost = pin ? 16384 : 32768;
  if (
    parts.length !== 7 ||
    parts[0] !== "scrypt" ||
    parts[1] !== (pin ? "v2" : "password-v1") ||
    parts[2] !== String(cost) ||
    parts[3] !== "8" ||
    parts[4] !== "1"
  )
    return "invalid";
  try {
    const salt = Buffer.from(parts[5], "base64url");
    const expected = Buffer.from(parts[6], "base64url");
    if (salt.length !== 16 || expected.length !== 32) return "invalid";
    const candidate = scryptSync(`${accountId}:${value}:${secret}`, salt, 32, {
      N: cost,
      r: 8,
      p: 1,
      maxmem: 96 * 1024 * 1024
    });
    return timingSafeEqual(candidate, expected) ? "current" : "invalid";
  } catch {
    return "invalid";
  }
}

export function seal(value: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hash(secret), "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function unseal(value: string, secret: string): string {
  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid envelope.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(hash(secret), "hex"),
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

// Matches the existing API's SHA-1, six-digit, 30-second TOTP policy.
export function totpCode(secret: string, step: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of secret.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret.");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bytes.length < 10 || step < 0 || !Number.isSafeInteger(step))
    throw new Error("Invalid TOTP input.");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}

export function verifyTotp(
  secret: string,
  code: string,
  now: number,
  lastUsedStep: number | null
): number | null {
  if (!/^\d{6}$/.test(code.trim())) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0 || (lastUsedStep !== null && step <= lastUsedStep)) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code.trim()))) return step;
  }
  return null;
}
