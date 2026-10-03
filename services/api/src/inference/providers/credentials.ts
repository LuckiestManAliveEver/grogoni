import {
  decryptOAuthToken,
  decryptSecretEnvelope,
  deriveSecretEnvelopeKey,
  encryptOAuthToken,
  encryptSecretEnvelope,
  secretEnvelopeKeyVersion
} from "../../cp2/secret-box.js";
import type { CredentialScope, ResolvedCredential } from "./contract.js";
import type { InferenceProviderConfig } from "./provider-config.js";
import type { ProviderCredentialRecord, ProviderCredentialRepository } from "./repositories.js";
import { SecretValue } from "./secret-value.js";

/**
 * Encrypts/decrypts provider secrets with the API's single at-rest envelope (cp2/secret-box.ts).
 * Injectable so tests can prove that nothing downstream ever sees ciphertext or plaintext it
 * should not.
 */
export interface SecretCipher {
  encrypt(plaintext: string): { ciphertext: string; keyVersion: number };
  decrypt(ciphertext: string, keyVersion: number): string;
}

export const secretBoxCipher: SecretCipher = {
  encrypt(plaintext) {
    return { ciphertext: encryptOAuthToken(plaintext), keyVersion: secretEnvelopeKeyVersion };
  },
  decrypt(ciphertext) {
    return decryptOAuthToken(ciphertext);
  }
};

/**
 * Versioned keys for provider credentials, so they can be rotated without touching OAuth tokens.
 * Version 1 is always the API's shared envelope key (secretBoxCipher); higher versions come from
 * INFERENCE_CREDENTIAL_KEYS ("2:<secret>,3:<secret>", each secret at least 32 characters). New
 * credentials are written with the highest version; rows under an older version stay readable and
 * are re-encrypted by rotateCredentialKeys(). Once a rotation run reports nothing left on an old
 * version, that key can be removed from the environment.
 */
export function createKeyringCipher(keys: ReadonlyMap<number, string>): SecretCipher & {
  readonly currentVersion: number;
} {
  const derived = new Map<number, Buffer>();
  for (const [version, secret] of keys) {
    if (!Number.isSafeInteger(version) || version < 2) {
      throw new Error("INFERENCE_CREDENTIAL_KEYS versions must be integers of 2 or more.");
    }
    if (secret.length < 32) {
      throw new Error("INFERENCE_CREDENTIAL_KEYS secrets must contain at least 32 characters.");
    }
    derived.set(version, deriveSecretEnvelopeKey(secret));
  }
  const currentVersion = Math.max(secretEnvelopeKeyVersion, ...derived.keys());
  return {
    currentVersion,
    encrypt(plaintext) {
      if (currentVersion === secretEnvelopeKeyVersion) return secretBoxCipher.encrypt(plaintext);
      return {
        ciphertext: encryptSecretEnvelope(plaintext, derived.get(currentVersion) as Buffer),
        keyVersion: currentVersion
      };
    },
    decrypt(ciphertext, keyVersion) {
      if (keyVersion === secretEnvelopeKeyVersion)
        return secretBoxCipher.decrypt(ciphertext, keyVersion);
      const key = derived.get(keyVersion);
      if (key === undefined)
        throw new Error(`Credential key version ${keyVersion} is not configured.`);
      return decryptSecretEnvelope(ciphertext, key);
    }
  };
}

export function parseCredentialKeyring(value: string | undefined): Map<number, string> {
  const keys = new Map<number, string>();
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    const version = Number(trimmed.slice(0, separator));
    if (separator <= 0 || !Number.isSafeInteger(version)) {
      throw new Error('INFERENCE_CREDENTIAL_KEYS must look like "2:<secret>,3:<secret>".');
    }
    keys.set(version, trimmed.slice(separator + 1));
  }
  return keys;
}

/**
 * Re-encrypts every stored credential that is not on the cipher's current key version. Idempotent
 * and safe to run at every boot. A row that cannot be decrypted is left untouched and counted.
 */
export async function rotateCredentialKeys(input: {
  repository: ProviderCredentialRepository;
  cipher: SecretCipher & { readonly currentVersion: number };
  now?: () => Date;
}): Promise<{ rotated: number; failed: number }> {
  let rotated = 0;
  let failed = 0;
  for (const record of await input.repository.listNeedingRotation(input.cipher.currentVersion)) {
    if (record.encryptedSecret === null) continue;
    try {
      const plaintext = input.cipher.decrypt(record.encryptedSecret, record.keyVersion);
      const next = input.cipher.encrypt(plaintext);
      await input.repository.update({
        ...record,
        encryptedSecret: next.ciphertext,
        keyVersion: next.keyVersion,
        updatedAt: (input.now?.() ?? new Date()).toISOString()
      });
      rotated += 1;
    } catch {
      failed += 1;
    }
  }
  return { rotated, failed };
}

/**
 * Deterministic credential precedence (brief §11):
 *
 *   explicit request scope  ->  tenant BYOK  ->  user BYOK  ->  Grogoni-managed
 *
 * - "explicit" narrows resolution to exactly one scope and never falls through: a request that
 *   asks for the tenant's own key must not silently be billed to Grogoni.
 * - Tenant and user lookups are exact-owner matches in the repository (tenant_id = X / user_id = Y),
 *   so one tenant can never resolve another tenant's credential.
 * - Grogoni-managed means the provider's credentialRef: an env var captured at boot, or a
 *   platform-scoped encrypted row. Env values never leave this module except inside SecretValue.
 * - A BYOK row that fails to decrypt is skipped (and reported), never surfaced as an error string
 *   that could echo ciphertext.
 */
export class CredentialResolver {
  constructor(
    private readonly deps: {
      repository: ProviderCredentialRepository;
      cipher: SecretCipher;
      managedSecrets: ReadonlyMap<string, string>;
      onDecryptFailure?: (credentialId: string) => void;
    }
  ) {}

  async resolve(input: {
    provider: InferenceProviderConfig;
    tenantId?: string | null;
    userId?: string | null;
    explicitScope?: Exclude<CredentialScope, "explicit">;
  }): Promise<ResolvedCredential | null> {
    const order: Array<Exclude<CredentialScope, "explicit">> =
      input.explicitScope === undefined ? ["tenant", "user", "platform"] : [input.explicitScope];
    for (const scope of order) {
      const credential = await this.resolveScope(scope, input);
      if (credential !== null) {
        return input.explicitScope === undefined
          ? credential
          : { ...credential, scope: "explicit" };
      }
    }
    return null;
  }

  private async resolveScope(
    scope: Exclude<CredentialScope, "explicit">,
    input: { provider: InferenceProviderConfig; tenantId?: string | null; userId?: string | null }
  ): Promise<ResolvedCredential | null> {
    if (scope === "platform") return this.resolveManaged(input.provider);
    if (!input.provider.byokAllowed) return null;
    const ownerId = scope === "tenant" ? input.tenantId : input.userId;
    if (ownerId === null || ownerId === undefined || ownerId === "") return null;
    const record = await this.deps.repository.findActive({
      providerId: input.provider.id,
      scope,
      ...(scope === "tenant" ? { tenantId: ownerId } : { userId: ownerId })
    });
    return record === undefined ? null : this.decryptRecord(record, scope);
  }

  private async resolveManaged(
    provider: InferenceProviderConfig
  ): Promise<ResolvedCredential | null> {
    const ref = provider.credentialRef;
    if (ref === null) return null;
    if (ref.startsWith("env:")) {
      const value = this.deps.managedSecrets.get(ref.slice(4));
      return value === undefined
        ? null
        : { scope: "platform", credentialId: null, secret: new SecretValue(value) };
    }
    if (ref.startsWith("secret://")) {
      const record = await this.deps.repository.get(ref.slice("secret://".length));
      if (
        record === undefined ||
        record.scope !== "platform" ||
        record.providerId !== provider.id ||
        record.status !== "ACTIVE"
      ) {
        return null;
      }
      return this.decryptRecord(record, "platform");
    }
    return null;
  }

  private decryptRecord(
    record: ProviderCredentialRecord,
    scope: Exclude<CredentialScope, "explicit">
  ): ResolvedCredential | null {
    if (record.encryptedSecret === null) return null;
    try {
      return {
        scope,
        credentialId: record.id,
        secret: new SecretValue(
          this.deps.cipher.decrypt(record.encryptedSecret, record.keyVersion)
        ),
        ...(record.baseUrl === null ? {} : { baseUrlOverride: record.baseUrl })
      };
    } catch {
      this.deps.onDecryptFailure?.(record.id);
      return null;
    }
  }
}
