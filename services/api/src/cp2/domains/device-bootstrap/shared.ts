/**
 * Fifteenth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns `deviceAccountBootstraps`,
 * `deviceAccountBootstrapCredentials`, `deviceRecoveryCredentials`, and
 * `deviceRecoverySessionCredentials` - the fourth slice carved out of the "core
 * auth/identity/session kernel", following the same standard rows 11-13 (Passkeys, OAuth, OTP)
 * established: investigate the actual coupling, don't assume it either way.
 *
 * **The core risk - does device bootstrap/recovery completion write `sessions`/`accounts`
 * directly - was investigated and the answer is no** for the two session-issuing entry points
 * (`continueWithDevice`, `recoverWithDeviceCredential`): both resolve or create the account via
 * `createAccount`/`requireAccount` callbacks and produce the session via a `createSession`
 * callback, the same "call back up" pattern used throughout this whole effort.
 *
 * **`mergeDeviceAccountData` deliberately stayed on `Cp2Store`, not here**, despite being called
 * by this cluster's `mergeCurrentDeviceAccountWithPin`. Reading its body shows it never touches
 * any of this domain's four Maps directly - it performs a whole-store `snapshot()` ->
 * filter/rewrite -> `hydrateSnapshot()` cycle to graft one account's session/PIN state onto
 * another, which is generic core-kernel functionality, not device-bootstrap-owned logic. It's
 * also called by `verifyEmailIdentityMerge` (a different, not-yet-extracted identity-merge
 * cluster), confirming it isn't this domain's to own. Moving it into this domain would have given
 * it a "reach into the entire store" dependency unlike every other domain's narrow callback list;
 * injecting it as a single callback (`deps.mergeDeviceAccountData(...)`) keeps the domain's
 * dependency surface the same shape as every other row's, and correctly reflects that the method
 * is core-kernel shared infrastructure used by two different callers, not this cluster's own.
 *
 * **Two reverse cross-references into this cluster's Maps, from code that stays on `Cp2Store`**:
 * `logoutAll` (core session-revocation) iterates and mutates `deviceRecoveryCredentials` and
 * deletes from `deviceRecoverySessionCredentials` when revoking every session for an account;
 * `verifyEmailIdentityMerge` (the not-yet-extracted identity-merge cluster) re-points a
 * `deviceAccountBootstraps` entry's `sessionId` after a device-to-target-account merge. Both keep
 * raw mutation access via `deviceRecoveryCredentialsMap`/`deviceRecoverySessionCredentialsMap`/
 * `deviceAccountBootstrapsMap` getters, the same escape-hatch pattern already used for
 * `otpChallengesMap` (row 13) and OAuth's `userIdentitiesMap` (row 12).
 *
 * `deviceAccountBootstrapCredentials`/`deviceRecoverySessionCredentials` are deliberately never
 * `Cp2Snapshot` fields - both hold plaintext refresh-token replay caches that should not survive
 * a restart, by design (confirmed unchanged from the pre-extraction monolith).
 */
import { createHash, createPublicKey, webcrypto } from "node:crypto";
import type { JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { Cp2Error } from "../../cp2-error.js";

export const deviceAccountBootstrapTtlMs = 10 * 60 * 1000;

export interface DeviceAccountBootstrapRecord {
  id: string;
  accountId: string;
  sessionId: string;
  expiresAt: string;
  createdAt: string;
}

export interface DeviceRecoveryCredentialRecord {
  id: string;
  accountId: string;
  publicKeyJwk: Record<string, unknown>;
  lastAssertionHash: string | null;
  lastAssertionAt: string | null;
  lastSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

export interface DeviceAccountBootstrapCredentials {
  sessionId: string;
  refreshToken: string;
}

export function normalizeDeviceBootstrapIdempotencyKey(value: string | null): string {
  const normalized = value?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(normalized)) {
    throw new Cp2Error(
      400,
      "auth_continue_idempotency_required",
      "A secure Continue request key is required."
    );
  }
  return normalized;
}

export function hashDeviceBootstrapKey(value: string): string {
  return createHash("sha256").update(`grogoni-device-bootstrap:${value}`).digest("base64url");
}

export function normalizeDeviceRecoveryCredentialId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)
  ) {
    throw new Cp2Error(401, "device_recovery_invalid", "Device recovery failed.");
  }
  return normalized;
}

export function normalizeDeviceRecoveryPublicKey(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Cp2Error(400, "device_recovery_key_required", "A device recovery key is required.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.kty !== "EC" ||
    record.crv !== "P-256" ||
    typeof record.x !== "string" ||
    typeof record.y !== "string" ||
    !/^[A-Za-z0-9_-]{40,64}$/u.test(record.x) ||
    !/^[A-Za-z0-9_-]{40,64}$/u.test(record.y)
  ) {
    throw new Cp2Error(400, "device_recovery_key_invalid", "The device recovery key is invalid.");
  }
  const normalized = { kty: "EC", crv: "P-256", x: record.x, y: record.y };
  try {
    createPublicKey({ key: normalized as NodeJsonWebKey, format: "jwk" });
  } catch {
    throw new Cp2Error(400, "device_recovery_key_invalid", "The device recovery key is invalid.");
  }
  return normalized;
}

export function deviceRecoveryPublicKeyFingerprint(publicKeyJwk: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${publicKeyJwk.kty}:${publicKeyJwk.crv}:${publicKeyJwk.x}:${publicKeyJwk.y}`)
    .digest("base64url");
}

export function deviceRecoveryAssertionPayload(
  credentialId: string,
  nonce: string,
  issuedAt: number
): string {
  return `grogoni-device-recovery:v1:${credentialId}:${issuedAt}:${nonce}`;
}

export async function verifyDeviceRecoverySignature(
  publicKeyJwk: Record<string, unknown>,
  payload: string,
  signature: string
): Promise<boolean> {
  try {
    // WebCrypto uses the same raw P-256 signature format in browsers, Node and Edge.
    // Node's synchronous verify compatibility layer does not preserve P1363 on Edge.
    const key = await webcrypto.subtle.importKey(
      "jwk",
      publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature, "base64url"),
      Buffer.from(payload, "utf8")
    );
  } catch {
    return false;
  }
}
