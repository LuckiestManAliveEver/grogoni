import { createHash, createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { androidAttestationRoots } from "./android-attestation-roots.js";

/**
 * Proves a device recovery key lives in Android's secure hardware and belongs to this app and
 * account, using Android Key Attestation. Without it, any script holding a recent session could
 * call a software key a screen-lock key. A captured chain is useless to someone else, because
 * using the key later needs its private half, so the challenge only binds the key to the account.
 */
const keyDescriptionOid = "1.3.6.1.4.1.11129.2.1.17";
const provisioningInfoOid = "1.3.6.1.4.1.11129.2.1.30";
const tagOrigin = 702;
const tagRootOfTrust = 704;
const tagNoAuthRequired = 503;
const tagApplicationId = 709;

export interface AndroidAttestationInput {
  /** DER certificates, base64, leaf first. */
  chain: unknown;
  publicKeyJwk: Record<string, unknown>;
  accountId: string;
  packageName: string;
  /** SHA-256 of each accepted app signing certificate, uppercase hex with or without colons. */
  signerDigests: readonly string[];
  /** Test seam: a chain ending anywhere else is rejected. */
  roots?: readonly string[];
  /** Test seam: emulators can only produce software attestation. */
  allowSoftware?: boolean;
  /** Serial numbers from Google's attestation status list, lowercase hex. */
  revokedSerials?: ReadonlySet<string>;
  now?: Date;
}

export function androidAttestationChallenge(accountId: string): Buffer {
  return createHash("sha256")
    .update(`grogoni-device-recovery-attestation:v1:${accountId}`)
    .digest();
}

interface Element {
  tag: number;
  constructed: boolean;
  tagClass: number;
  value: Buffer;
  /** The whole element with its header: the bytes a certificate's signature covers. */
  raw: Buffer;
}

function readElements(input: Buffer): Element[] {
  const elements: Element[] = [];
  let at = 0;
  const byte = () => {
    if (at >= input.length) throw new Error("truncated DER");
    return input[at++]!;
  };
  while (at < input.length) {
    const start = at;
    const first = byte();
    let tag = first & 0x1f;
    if (tag === 0x1f) {
      tag = 0;
      let next: number;
      do {
        next = byte();
        tag = tag * 128 + (next & 0x7f);
        if (tag > 0xffff) throw new Error("DER tag too large");
      } while (next & 0x80);
    }
    let length = byte();
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count === 0 || count > 4) throw new Error("unsupported DER length");
      length = 0;
      for (let index = 0; index < count; index += 1) length = length * 256 + byte();
    }
    if (at + length > input.length) throw new Error("truncated DER value");
    elements.push({
      tag,
      constructed: (first & 0x20) !== 0,
      tagClass: first >> 6,
      value: input.subarray(at, at + length),
      raw: input.subarray(start, at + length)
    });
    at += length;
  }
  return elements;
}

function single(input: Buffer): Element {
  const [element] = readElements(input);
  if (element === undefined) throw new Error("empty DER");
  return element;
}

function integer(element: Element): number {
  let value = 0;
  for (const part of element.value) value = value * 256 + part;
  return value;
}

function oid(value: Buffer): string {
  const parts = [Math.floor(value[0]! / 40), value[0]! % 40];
  let current = 0;
  for (const part of value.subarray(1)) {
    current = current * 128 + (part & 0x7f);
    if (!(part & 0x80)) {
      parts.push(current);
      current = 0;
    }
  }
  return parts.join(".");
}

const signatureDigests: Record<string, string> = {
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512"
};

/**
 * Parsed by hand, because Deno's X509Certificate lacks verify() and raw, and Edge runs on Deno.
 * Only the fields this check needs.
 */
interface Certificate {
  der: Buffer;
  tbs: Buffer;
  digest: string;
  signature: Buffer;
  publicKey: ReturnType<typeof createPublicKey>;
  spki: Buffer;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  remotelyProvisioned: boolean;
  keyDescription: Buffer | null;
}

function derTime(element: Element): Date {
  const text = element.value.toString("ascii");
  const full = element.tag === 23 ? `${Number(text.slice(0, 2)) < 50 ? "20" : "19"}${text}` : text;
  const date = new Date(
    `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}T${full.slice(8, 10)}:${full.slice(10, 12)}:${full.slice(12, 14)}Z`
  );
  if (Number.isNaN(date.getTime())) throw new Error("invalid certificate time");
  return date;
}

function parseCertificate(der: Buffer): Certificate {
  const [tbs, algorithm, signature] = readElements(single(der).value);
  const digest = signatureDigests[oid(readElements(algorithm!.value)[0]!.value)];
  if (digest === undefined) throw new Error("unsupported signature algorithm");
  const fields = readElements(tbs!.value);
  const body = fields[0]?.tagClass === 2 && fields[0].tag === 0 ? fields.slice(1) : fields;
  let description: Buffer | null = null;
  let remotelyProvisioned = false;
  const [notBefore, notAfter] = readElements(body[3]!.value);
  const extensions = fields.find((item) => item.tagClass === 2 && item.tag === 3);
  for (const extension of extensions ? readElements(single(extensions.value).value) : []) {
    const parts = readElements(extension.value);
    const id = oid(parts[0]!.value);
    const value = parts.at(-1)!.value;
    if (id === keyDescriptionOid) description = value;
    if (id === provisioningInfoOid) remotelyProvisioned = true;
  }
  return {
    der,
    tbs: tbs!.raw,
    digest,
    // A BIT STRING's first byte counts unused bits.
    signature: signature!.value.subarray(1),
    publicKey: createPublicKey({ key: body[5]!.raw, format: "der", type: "spki" }),
    spki: body[5]!.raw,
    serial: body[0]!.value.toString("hex").replace(/^0+/u, ""),
    notBefore: derTime(notBefore!),
    notAfter: derTime(notAfter!),
    remotelyProvisioned,
    keyDescription: description
  };
}

function pemBytes(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/gu, ""), "base64");
}

function authorization(list: Element, tag: number): Element | undefined {
  const entry = readElements(list.value).find((item) => item.tagClass === 2 && item.tag === tag);
  return entry === undefined ? undefined : single(entry.value);
}

function sameKey(certificate: Certificate, jwk: Record<string, unknown>): boolean {
  const attested = certificate.publicKey.export({ format: "jwk" });
  const claimed = createPublicKey({ key: jwk as never, format: "jwk" }).export({ format: "jwk" });
  return attested.x === claimed.x && attested.y === claimed.y;
}

function normalizeDigest(value: string): string {
  return value.replaceAll(":", "").toLowerCase();
}

/** Returns the reason the chain is refused, or null when it proves the key. */
export function androidAttestationProblem(input: AndroidAttestationInput): string | null {
  try {
    if (!Array.isArray(input.chain) || input.chain.length < 2 || input.chain.length > 10) {
      return "chain_missing";
    }
    const certificates = input.chain.map((item: unknown) => {
      if (typeof item !== "string") throw new Error("certificate is not text");
      return parseCertificate(Buffer.from(item, "base64"));
    });
    // Based on Google's KeyAttestationCertPathValidator, whose rules real chains need:
    // - The leaf's validity is ignored, and an issuer not yet valid is refused. An expired issuer
    //   is refused on remotely provisioned chains, whose short life limits a leaked key. It is
    //   forgiven on factory chains, because factory keys cannot be rotated.
    // - Batch certificates can be CA:FALSE, so CA flags prove nothing. A forged leaf would be
    //   signed by a device's attested key, so only the leaf may carry an attestation.
    // - Google reissues its root with the same key, so the anchor is the key, not the certificate.
    // - A leaked factory key is stopped only by Google's revocation list, which the caller passes.
    // Unlike Google, this does not check names between certificates or fix the chain's shape.
    const now = input.now ?? new Date();
    const remote = certificates.some((certificate) => certificate.remotelyProvisioned);
    for (const [index, certificate] of certificates.entries()) {
      // Google's list holds some serials as hex and some as decimal.
      if (
        input.revokedSerials?.has(certificate.serial) ||
        input.revokedSerials?.has(BigInt(`0x${certificate.serial || "0"}`).toString())
      ) {
        return "certificate_revoked";
      }
      if (index > 0) {
        if (certificate.keyDescription !== null) return "attestation_in_issuer";
        if (now < certificate.notBefore) return "certificate_not_yet_valid";
        if (remote && now > certificate.notAfter) return "certificate_expired";
      }
      const issuer = certificates[index + 1] ?? certificate;
      if (!verify(certificate.digest, certificate.tbs, issuer.publicKey, certificate.signature)) {
        return "chain_signature_invalid";
      }
    }
    const root = certificates.at(-1)!;
    const trusted = (input.roots ?? androidAttestationRoots).some((pem) =>
      parseCertificate(pemBytes(pem)).spki.equals(root.spki)
    );
    if (!trusted) return "root_untrusted";

    const leaf = certificates[0]!;
    if (!sameKey(leaf, input.publicKeyJwk)) return "key_mismatch";
    const extension = leaf.keyDescription;
    if (extension === null) return "attestation_missing";
    const fields = readElements(single(extension).value);
    const [, securityLevel, , , challenge, , softwareEnforced, hardwareEnforced] = fields;
    if (hardwareEnforced === undefined) return "attestation_malformed";
    if (integer(securityLevel!) === 0 && input.allowSoftware !== true) return "not_hardware";
    if (!challenge!.value.equals(androidAttestationChallenge(input.accountId))) {
      return "challenge_mismatch";
    }
    const enforced = input.allowSoftware === true ? softwareEnforced! : hardwareEnforced;
    if (authorization(enforced, tagNoAuthRequired) !== undefined) return "no_user_authentication";
    const origin = authorization(enforced, tagOrigin);
    if (origin === undefined || integer(origin) !== 0) return "key_imported";
    const rootOfTrust = authorization(hardwareEnforced, tagRootOfTrust);
    if (input.allowSoftware !== true) {
      const bootState = rootOfTrust && readElements(rootOfTrust.value)[2];
      if (bootState === undefined || integer(bootState) > 1) return "device_unverified";
    }

    const application =
      authorization(softwareEnforced!, tagApplicationId) ??
      authorization(hardwareEnforced, tagApplicationId);
    if (application === undefined) return "application_missing";
    const [packages, digests] = readElements(single(application.value).value);
    const names = readElements(packages!.value).map((item) =>
      readElements(item.value)[0]!.value.toString("utf8")
    );
    if (!names.includes(input.packageName)) return "package_mismatch";
    const accepted = input.signerDigests.map(normalizeDigest);
    const signed = readElements(digests!.value).some((item) =>
      accepted.includes(item.value.toString("hex"))
    );
    return signed ? null : "signer_mismatch";
  } catch {
    return "attestation_malformed";
  }
}

const statusUrl = "https://android.googleapis.com/attestation/status";
let revocations: { fetchedAt: number; serials: ReadonlySet<string> } | null = null;

/** Google's revoked attestation serials, cached for an hour. Null when they cannot be read. */
export async function fetchAndroidRevokedSerials(
  fetcher: typeof fetch = fetch
): Promise<ReadonlySet<string> | null> {
  if (revocations !== null && Date.now() - revocations.fetchedAt < 3_600_000) {
    return revocations.serials;
  }
  try {
    const response = await fetcher(statusUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const { entries } = (await response.json()) as { entries?: Record<string, unknown> };
    if (entries === undefined) return null;
    const serials = new Set(
      Object.keys(entries).map((key) => key.toLowerCase().replace(/^0+/u, ""))
    );
    revocations = { fetchedAt: Date.now(), serials };
    return serials;
  } catch {
    return null;
  }
}

export const grogoniAndroidPackage = "market.grogoni.app";
const directSigner =
  "C0:AA:FB:59:8D:E5:87:49:DD:50:89:90:6E:F3:B0:8C:77:76:D3:0A:02:A5:D6:AD:61:C4:DE:98:D6:7F:DD:CD";

/** `ANDROID_ATTESTATION_SIGNERS` adds signers, such as Play App Signing's, comma separated. */
export function grogoniAndroidSigners(extra: string | undefined): string[] {
  return [
    directSigner,
    ...(extra ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  ];
}
