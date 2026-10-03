import { randomUUID } from "node:crypto";
import type {
  AuthSessionView,
  ExternalRegistryConnection,
  ExternalRegistryProvider
} from "@grogoni/shared-types";
import { decryptOAuthToken, encryptOAuthToken } from "../../oauth.js";
import { Cp2Error } from "../../cp2-error.js";
import {
  externalConnectionKey,
  externalConnectionView,
  type ExternalConnectionRecord
} from "./shared.js";
import type { Cp2Snapshot } from "../../store.js";

export interface ExternalConnectionsDomainDeps {
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthSessionView;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  /**
   * Swappable only for tests - production always uses the global `fetch`. Keeping this on deps
   * (rather than importing `fetch` at call sites) is what lets connect() tests stub provider
   * responses without touching `globalThis.fetch`, matching how other domains inject their I/O
   * boundaries instead of reaching for ambient globals.
   */
  fetchImpl?: typeof fetch;
}

interface ProviderValidationResult {
  externalAccountId: string;
  externalUsername: string | null;
  scopes: string[];
}

interface GitHubUserResponse {
  id?: number | string;
  login?: string;
}

interface HuggingFaceWhoAmIResponse {
  id?: string;
  name?: string;
  auth?: {
    accessToken?: {
      role?: string;
      fineGrained?: { scoped?: unknown[] };
    };
  };
}

/**
 * Fourteenth-ish domain slice, built directly against the oauth/mcp-tokens template rather than
 * extracted from Cp2Store: an account-scoped credential store with real Postgres columns (see
 * infra/db/migrations/073_external_registry_connections.sql), the same "real table, not the
 * generic cp2_* entity_id/record convention" shape user_identities and mcp_access_tokens use.
 */
export class ExternalConnectionsDomain {
  private readonly connections = new Map<string, ExternalConnectionRecord>();
  private readonly connectionIdByAccountProvider = new Map<string, string>();

  constructor(private readonly deps: ExternalConnectionsDomainDeps) {}

  get connectionsMap(): Map<string, ExternalConnectionRecord> {
    return this.connections;
  }

  clear(): void {
    this.connections.clear();
    this.connectionIdByAccountProvider.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const record of snapshot.externalRegistryConnections ?? []) {
      this.connections.set(record.id, record);
      this.connectionIdByAccountProvider.set(
        externalConnectionKey(record.accountId, record.provider),
        record.id
      );
    }
  }

  rebuildIndex(): void {
    this.connectionIdByAccountProvider.clear();
    for (const record of this.connections.values()) {
      this.connectionIdByAccountProvider.set(
        externalConnectionKey(record.accountId, record.provider),
        record.id
      );
    }
  }

  async connect(input: {
    sessionId: string | null;
    provider: ExternalRegistryProvider;
    token: string;
    now?: Date;
  }): Promise<ExternalRegistryConnection> {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const token = input.token.trim();

    if (token.length === 0) {
      throw new Cp2Error(
        400,
        "external_connection_token_required",
        "A personal access token is required."
      );
    }

    // Exactly one lightweight real API call validates the token before anything is stored - a
    // token that fails this call is never persisted, encrypted or not.
    const validation =
      input.provider === "github"
        ? await this.validateGitHubToken(token)
        : await this.validateHuggingFaceToken(token);

    const key = externalConnectionKey(session.account.id, input.provider);
    const existingId = this.connectionIdByAccountProvider.get(key);
    const existing = existingId === undefined ? undefined : this.connections.get(existingId);
    const record: ExternalConnectionRecord = {
      id: existing?.id ?? randomUUID(),
      accountId: session.account.id,
      provider: input.provider,
      externalAccountId: validation.externalAccountId,
      externalUsername: validation.externalUsername,
      status: "connected",
      scopes: validation.scopes,
      // Never set true by connect() itself, even on a reconnect of a previously-authorized
      // connection - see authorizeInference() below and the migration 097 comment. A reconnect
      // that changes the underlying token should not silently re-carry forward a prior inference
      // billing authorization without the account confirming it again for the new token.
      inferenceAuthorized: false,
      encryptedToken: encryptOAuthToken(token),
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.connections.set(record.id, record);
    this.connectionIdByAccountProvider.set(key, record.id);

    this.deps.recordAuditEvent({
      type: "external_connection.connected",
      aggregateType: "external_registry_connection",
      aggregateId: record.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { provider: input.provider, reconnected: existing !== undefined }
    });

    return externalConnectionView(record);
  }

  /**
   * The one action that turns a merely-connected Hugging Face account into one whose credential
   * may be billed for this account's own inference usage. Deliberately separate from connect() -
   * see the type-level comment on ExternalRegistryConnection.inferenceAuthorized and migration 097.
   * Setting `authorized: false` (the account changing its mind) always succeeds; setting it `true`
   * requires a still-connected, still-decryptable credential, so an account can never end up
   * "authorized for inference" over a token that no longer actually exists.
   */
  authorizeInference(input: {
    sessionId: string | null;
    id: string;
    authorized: boolean;
    now?: Date;
  }): ExternalRegistryConnection {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const record = this.connections.get(input.id);

    if (record === undefined || record.accountId !== session.account.id) {
      throw new Cp2Error(404, "external_connection_not_found", "Connected account was not found.");
    }
    if (input.authorized && (record.status !== "connected" || record.encryptedToken === null)) {
      throw new Cp2Error(
        409,
        "external_connection_not_usable",
        "Reconnect this account before authorizing it for inference billing."
      );
    }

    const updated: ExternalConnectionRecord = {
      ...record,
      inferenceAuthorized: input.authorized,
      updatedAt: now.toISOString()
    };
    this.connections.set(record.id, updated);

    this.deps.recordAuditEvent({
      type: "external_connection.inference_authorization_changed",
      aggregateType: "external_registry_connection",
      aggregateId: record.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { provider: record.provider, authorized: input.authorized }
    });

    return externalConnectionView(updated);
  }

  disconnect(input: { sessionId: string | null; id: string; now?: Date }): {
    disconnected: true;
    id: string;
  } {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const record = this.connections.get(input.id);

    if (record === undefined || record.accountId !== session.account.id) {
      throw new Cp2Error(404, "external_connection_not_found", "Connected account was not found.");
    }

    // Revocation removes the credential, not just hides it: encryptedToken is cleared, never
    // merely flagged, so nothing decryptable remains at rest once disconnected.
    const revoked: ExternalConnectionRecord = {
      ...record,
      status: "revoked",
      encryptedToken: null,
      updatedAt: now.toISOString()
    };
    this.connections.set(record.id, revoked);

    this.deps.recordAuditEvent({
      type: "external_connection.disconnected",
      aggregateType: "external_registry_connection",
      aggregateId: record.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { provider: record.provider }
    });

    return { disconnected: true, id: record.id };
  }

  list(input: { sessionId: string | null; now?: Date }): ExternalRegistryConnection[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());

    return [...this.connections.values()]
      .filter((record) => record.accountId === session.account.id)
      .map(externalConnectionView)
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  /**
   * Internal-only: not exported from routes.ts, not reachable by any route handler outside this
   * domain, and never included in any summary/telemetry payload. This is what server-side
   * registry adapters call (via Cp2Store.resolveExternalConnectionToken) when building an
   * authenticated request to GitHub/HF. Returns null - never throws, never logs the token or the
   * encrypted value - whenever there is no usable credential, so callers can transparently fall
   * back to an unauthenticated request instead of surfacing a decryption error upstream.
   */
  resolveToken(accountId: string, provider: ExternalRegistryProvider): string | null {
    const id = this.connectionIdByAccountProvider.get(externalConnectionKey(accountId, provider));
    const record = id === undefined ? undefined : this.connections.get(id);

    if (record === undefined || record.status !== "connected" || record.encryptedToken === null) {
      return null;
    }

    try {
      return decryptOAuthToken(record.encryptedToken);
    } catch {
      return null;
    }
  }

  /**
   * Internal-only, same access rules as resolveToken() plus one more: returns null unless the
   * account has explicitly authorized this exact connection for inference billing
   * (authorizeInference() above), never merely because a connection exists. This is what the
   * inference request-building path (not registry search/import) must call - resolveToken() above
   * remains discovery-only and must never be used to source a credential for a billed model call.
   */
  resolveInferenceToken(accountId: string, provider: ExternalRegistryProvider): string | null {
    const id = this.connectionIdByAccountProvider.get(externalConnectionKey(accountId, provider));
    const record = id === undefined ? undefined : this.connections.get(id);

    if (
      record === undefined ||
      record.status !== "connected" ||
      record.encryptedToken === null ||
      !record.inferenceAuthorized
    ) {
      return null;
    }

    try {
      return decryptOAuthToken(record.encryptedToken);
    } catch {
      return null;
    }
  }

  private async validateGitHubToken(token: string): Promise<ProviderValidationResult> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    let response: Response;

    try {
      response = await doFetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "grogoni"
        }
      });
    } catch {
      throw new Cp2Error(
        502,
        "external_connection_provider_unreachable",
        "Could not reach GitHub to validate the token."
      );
    }

    if (!response.ok) {
      throw new Cp2Error(
        401,
        "external_connection_token_invalid",
        "GitHub rejected this token. Check that it is valid and has not expired."
      );
    }

    const payload = (await response.json()) as GitHubUserResponse;

    if (payload.id === undefined) {
      throw new Cp2Error(
        502,
        "external_connection_provider_response_invalid",
        "GitHub returned an unexpected response."
      );
    }

    const scopesHeader = response.headers.get("x-oauth-scopes") ?? "";
    const scopes = scopesHeader
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);

    return {
      externalAccountId: String(payload.id),
      externalUsername: payload.login ?? null,
      scopes
    };
  }

  private async validateHuggingFaceToken(token: string): Promise<ProviderValidationResult> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    let response: Response;

    try {
      response = await doFetch("https://huggingface.co/api/whoami-v2", {
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "grogoni"
        }
      });
    } catch {
      throw new Cp2Error(
        502,
        "external_connection_provider_unreachable",
        "Could not reach Hugging Face to validate the token."
      );
    }

    if (!response.ok) {
      throw new Cp2Error(
        401,
        "external_connection_token_invalid",
        "Hugging Face rejected this token. Check that it is valid and has not expired."
      );
    }

    const payload = (await response.json()) as HuggingFaceWhoAmIResponse;

    if (payload.id === undefined && payload.name === undefined) {
      throw new Cp2Error(
        502,
        "external_connection_provider_response_invalid",
        "Hugging Face returned an unexpected response."
      );
    }

    const role = payload.auth?.accessToken?.role;

    return {
      externalAccountId: payload.id ?? payload.name ?? "unknown",
      externalUsername: payload.name ?? null,
      scopes: role === undefined ? [] : [role]
    };
  }
}
