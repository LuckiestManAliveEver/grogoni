import { randomUUID } from "node:crypto";

import type {
  InferenceProviderConnectionScope,
  InferenceProviderConnectionSummary,
  InferenceProviderConnectionTestResult
} from "@grogoni/shared-types";

import type { ResolvedCredential } from "./contract.js";
import type { SecretCipher } from "./credentials.js";
import { strictEndpointPolicy, validateProviderEndpoint } from "./endpoint-policy.js";
import { InferenceError } from "./errors.js";
import type { InferenceRouter } from "./inference-router.js";
import type { InferenceProviderRegistry } from "./provider-registry.js";
import type { ProviderCredentialRecord, ProviderCredentialRepository } from "./repositories.js";
import { SecretValue } from "./secret-value.js";

/** Thrown for caller mistakes the route layer turns into 4xx. Messages are safe to show. */
export class ProviderConnectionError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderConnectionError";
  }
}

/**
 * BYOK connection management: connect / replace / test / disconnect. Authorization (who may manage
 * which tenant's or user's connections) is decided by the caller (Cp2Store) *before* any method
 * here runs; this service only ever acts on the exact owner it is given, and every read path
 * returns the redacted summary below - never the ciphertext, never the key.
 */
export class ProviderConnectionService {
  constructor(
    private readonly deps: {
      registry: InferenceProviderRegistry;
      repository: ProviderCredentialRepository;
      cipher: SecretCipher;
      router: InferenceRouter;
      /** First enabled catalog model for a provider, for minimal-completion verification. */
      probeModelFor: (providerId: string) => string | undefined;
      now?: () => Date;
    }
  ) {}

  async list(owner: {
    userId: string;
    tenantId?: string;
  }): Promise<InferenceProviderConnectionSummary[]> {
    const records = await this.deps.repository.listForOwner({
      userId: owner.userId,
      ...(owner.tenantId === undefined ? {} : { tenantId: owner.tenantId })
    });
    return records
      .filter((record) => record.scope !== "platform" && record.status !== "REVOKED")
      .filter(
        (record) =>
          (record.scope === "user" && record.userId === owner.userId) ||
          (record.scope === "tenant" &&
            owner.tenantId !== undefined &&
            record.tenantId === owner.tenantId)
      )
      .map(connectionSummary)
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async get(id: string): Promise<ProviderCredentialRecord | undefined> {
    return this.deps.repository.get(id);
  }

  async connect(input: {
    scope: InferenceProviderConnectionScope;
    tenantId: string | null;
    userId: string;
    actorId: string;
    providerId: string;
    apiKey: string;
    baseUrl?: string | null;
  }): Promise<InferenceProviderConnectionSummary> {
    const registered = this.deps.registry.get(input.providerId);
    if (registered === undefined || registered.config.type === "local") {
      throw new ProviderConnectionError(
        404,
        "inference_provider_not_found",
        "This AI provider is not available."
      );
    }
    const { config } = registered;
    if (!config.byokAllowed) {
      throw new ProviderConnectionError(
        409,
        "inference_provider_byok_not_allowed",
        "This provider does not accept your own API key."
      );
    }
    const apiKey = input.apiKey.trim();
    if (apiKey.length < 8 || apiKey.length > 512 || hasWhitespaceOrControlCharacter(apiKey)) {
      throw new ProviderConnectionError(400, "inference_api_key_invalid", "Enter a valid API key.");
    }
    let baseUrl: string | null = null;
    if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl.trim() !== "") {
      if (!config.allowCredentialEndpoint) {
        throw new ProviderConnectionError(
          400,
          "inference_custom_endpoint_not_allowed",
          "This provider does not accept a custom endpoint."
        );
      }
      try {
        // Strict policy, always: a user-supplied endpoint can never reach private networks,
        // metadata services, localhost, or plain http - regardless of how the provider is configured.
        baseUrl = validateProviderEndpoint(input.baseUrl.trim(), strictEndpointPolicy).toString();
      } catch (error) {
        throw new ProviderConnectionError(
          400,
          "inference_custom_endpoint_forbidden",
          error instanceof InferenceError ? error.message : "This endpoint is not allowed."
        );
      }
    }
    if (input.scope === "tenant" && (input.tenantId === null || input.tenantId === "")) {
      throw new ProviderConnectionError(
        400,
        "inference_connection_business_required",
        "Choose a shop."
      );
    }

    // Verify before storing: a key the provider rejects is never persisted, encrypted or not.
    const transient: ResolvedCredential = {
      scope: input.scope,
      credentialId: null,
      secret: new SecretValue(apiKey),
      ...(baseUrl === null ? {} : { baseUrlOverride: baseUrl })
    };
    const probeModelId = this.deps.probeModelFor(config.id);
    const health = await this.deps.router.checkHealth({
      providerId: config.id,
      tenantId: input.tenantId,
      userId: input.userId,
      credential: transient,
      ...(probeModelId === undefined ? {} : { probeModelId })
    });
    if (health.status === "CREDENTIAL_INVALID") {
      throw new ProviderConnectionError(
        401,
        "inference_api_key_rejected",
        "The provider rejected this API key. Check that it is valid and active."
      );
    }
    if (health.status === "MISCONFIGURED") {
      throw new ProviderConnectionError(
        400,
        "inference_connection_misconfigured",
        health.message ?? "This connection is not configured correctly."
      );
    }

    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const owner =
      input.scope === "tenant"
        ? { scope: "tenant" as const, tenantId: input.tenantId as string }
        : { scope: "user" as const, userId: input.userId };
    const existing = await this.deps.repository.findActive({ providerId: config.id, ...owner });
    if (existing !== undefined) {
      // Replace = revoke then insert, so exactly one active key exists per owner and provider.
      await this.deps.repository.update(revoked(existing, now));
    }
    const encrypted = this.deps.cipher.encrypt(apiKey);
    const record: ProviderCredentialRecord = {
      id: randomUUID(),
      scope: input.scope,
      tenantId: input.scope === "tenant" ? input.tenantId : null,
      userId: input.scope === "user" ? input.userId : null,
      providerId: config.id,
      credentialType: "api_key",
      encryptedSecret: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
      secretSuffix: transient.secret.suffix(),
      baseUrl,
      status: "ACTIVE",
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
      lastVerifiedAt: health.status === "AVAILABLE" ? now : null,
      lastVerificationStatus: health.status === "AVAILABLE" ? "passed" : null
    };
    await this.deps.repository.insert(record);
    return connectionSummary(record);
  }

  async test(record: ProviderCredentialRecord): Promise<InferenceProviderConnectionTestResult> {
    if (record.status === "REVOKED" || record.encryptedSecret === null) {
      throw new ProviderConnectionError(
        409,
        "inference_connection_revoked",
        "This connection was disconnected."
      );
    }
    let secret: SecretValue;
    try {
      secret = new SecretValue(this.deps.cipher.decrypt(record.encryptedSecret, record.keyVersion));
    } catch {
      throw new ProviderConnectionError(
        409,
        "inference_connection_unreadable",
        "This key can no longer be read. Replace it to continue."
      );
    }
    const probeModelId = this.deps.probeModelFor(record.providerId);
    const health = await this.deps.router.checkHealth({
      providerId: record.providerId,
      tenantId: record.tenantId,
      userId: record.userId,
      credential: {
        scope: record.scope === "platform" ? "platform" : record.scope,
        credentialId: record.id,
        secret,
        ...(record.baseUrl === null ? {} : { baseUrlOverride: record.baseUrl })
      },
      ...(probeModelId === undefined ? {} : { probeModelId })
    });
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const passed = health.status === "AVAILABLE" || health.status === "DEGRADED";
    const updated: ProviderCredentialRecord = {
      ...record,
      status:
        health.status === "CREDENTIAL_INVALID" ? "INVALID" : passed ? "ACTIVE" : record.status,
      lastVerifiedAt: now,
      lastVerificationStatus: passed ? "passed" : "failed",
      updatedAt: now
    };
    await this.deps.repository.update(updated);
    return {
      connection: connectionSummary(updated),
      health: {
        status: health.status,
        checkedAt: health.checkedAt,
        latencyMs: health.latencyMs ?? null,
        errorCode: health.errorCode ?? null,
        message: health.message ?? null
      }
    };
  }

  async disconnect(record: ProviderCredentialRecord): Promise<{ disconnected: true; id: string }> {
    if (record.status !== "REVOKED") {
      await this.deps.repository.update(
        revoked(record, (this.deps.now?.() ?? new Date()).toISOString())
      );
    }
    return { disconnected: true, id: record.id };
  }
}

/** Revocation removes the ciphertext; nothing decryptable remains at rest. */
function revoked(record: ProviderCredentialRecord, now: string): ProviderCredentialRecord {
  return {
    ...record,
    status: "REVOKED",
    encryptedSecret: null,
    revokedAt: now,
    updatedAt: now
  };
}

/** The only shape a connection ever leaves the server in. */
export function connectionSummary(
  record: ProviderCredentialRecord
): InferenceProviderConnectionSummary {
  return {
    id: record.id,
    providerId: record.providerId,
    scope: record.scope === "tenant" ? "tenant" : "user",
    businessId: record.tenantId,
    connected: record.status === "ACTIVE",
    status: record.status,
    secretHint: record.secretSuffix,
    customEndpoint: record.baseUrl,
    lastVerifiedAt: record.lastVerifiedAt,
    lastVerificationStatus: record.lastVerificationStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function hasWhitespaceOrControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(character)) return true;
  }
  return false;
}
