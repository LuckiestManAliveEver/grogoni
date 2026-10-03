import { randomUUID } from "node:crypto";
import type {
  AuthSessionView,
  BusinessSummary,
  McpAccessScope,
  McpAccessTokenCreated,
  McpAccessTokenSummary,
  McpPrincipal,
  MembershipSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { hashMcpAccessToken, mcpAccessTokenSummary, type McpAccessTokenRecord } from "./shared.js";
import type { Cp2Snapshot } from "../../store.js";

export interface McpTokensDomainDeps {
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthSessionView;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  listAccountShops: (input: {
    sessionId: string | null;
    now?: Date;
  }) => Array<{ business: BusinessSummary; membership: MembershipSummary }>;
  requireIntegrationPrincipal: (input: {
    accountId: string;
    userId: string;
    shopId: string | null;
    now: Date;
  }) => void;
}

export class McpTokensDomain {
  private readonly mcpAccessTokens = new Map<string, McpAccessTokenRecord>();
  private readonly mcpTokenIdByHash = new Map<string, string>();

  constructor(private readonly deps: McpTokensDomainDeps) {}

  get mcpAccessTokensMap(): Map<string, McpAccessTokenRecord> {
    return this.mcpAccessTokens;
  }

  get mcpTokenIdByHashMap(): Map<string, string> {
    return this.mcpTokenIdByHash;
  }

  clear(): void {
    this.mcpAccessTokens.clear();
    this.mcpTokenIdByHash.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const token of snapshot.mcpAccessTokens ?? []) {
      const legacyToken = token as McpAccessTokenRecord & { sessionId?: string };
      const restored: McpAccessTokenRecord = {
        ...token,
        createdBySessionId: token.createdBySessionId ?? legacyToken.sessionId ?? null
      };
      delete (restored as McpAccessTokenRecord & { sessionId?: string }).sessionId;
      this.mcpAccessTokens.set(restored.id, restored);
      this.mcpTokenIdByHash.set(token.tokenHash, token.id);
    }
  }

  rebuildTokenIndex(): void {
    this.mcpTokenIdByHash.clear();
    for (const token of this.mcpAccessTokens.values()) {
      this.mcpTokenIdByHash.set(token.tokenHash, token.id);
    }
  }

  createMcpAccessToken(input: {
    sessionId: string | null;
    name: string;
    scopes: McpAccessScope[];
    shopId?: string | null;
    expiresInSeconds?: number;
    now?: Date;
  }): McpAccessTokenCreated {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const name = input.name.trim();
    if (name.length < 3 || name.length > 80) {
      throw new Cp2Error(400, "mcp_token_name_invalid", "Token name must be 3 to 80 characters.");
    }
    const scopes = [...new Set(input.scopes)];
    if (
      scopes.length === 0 ||
      scopes.some((scope) => scope !== "mcp:read" && scope !== "mcp:act")
    ) {
      throw new Cp2Error(400, "mcp_scope_invalid", "At least one supported MCP scope is required.");
    }
    const shopId = input.shopId ?? null;
    if (
      shopId !== null &&
      !this.deps
        .listAccountShops({ sessionId: session.session.id, now })
        .some(({ business }) => business.id === shopId)
    ) {
      throw new Cp2Error(403, "mcp_shop_forbidden", "The MCP token cannot access that shop.");
    }
    const expiresInSeconds = input.expiresInSeconds ?? 3_600;
    if (
      !Number.isInteger(expiresInSeconds) ||
      expiresInSeconds < 60 ||
      expiresInSeconds > 2_592_000
    ) {
      throw new Cp2Error(
        400,
        "mcp_token_ttl_invalid",
        "MCP token lifetime must be between 60 seconds and 30 days."
      );
    }
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1_000).toISOString();
    const accessToken = `grogoni_mcp_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    const record: McpAccessTokenRecord = {
      id: randomUUID(),
      accountId: session.account.id,
      userId: session.user.id,
      createdBySessionId: session.session.id,
      tokenHash: hashMcpAccessToken(accessToken),
      name,
      scopes,
      shopId,
      createdAt: now.toISOString(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null
    };
    this.mcpAccessTokens.set(record.id, record);
    this.mcpTokenIdByHash.set(record.tokenHash, record.id);
    this.deps.recordAuditEvent({
      type: "mcp.token_created",
      aggregateType: "mcp_access_token",
      aggregateId: record.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { scopes, shopId, expiresAt }
    });
    return { accessToken, token: mcpAccessTokenSummary(record) };
  }

  listMcpAccessTokens(input: { sessionId: string | null; now?: Date }): McpAccessTokenSummary[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    return [...this.mcpAccessTokens.values()]
      .filter((token) => token.accountId === session.account.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(mcpAccessTokenSummary);
  }

  revokeMcpAccessToken(input: {
    sessionId: string | null;
    tokenId: string;
    now?: Date;
  }): McpAccessTokenSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const token = this.mcpAccessTokens.get(input.tokenId);
    if (token === undefined || token.accountId !== session.account.id) {
      throw new Cp2Error(404, "mcp_token_not_found", "MCP token was not found.");
    }
    token.revokedAt ??= now.toISOString();
    this.deps.recordAuditEvent({
      type: "mcp.token_revoked",
      aggregateType: "mcp_access_token",
      aggregateId: token.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {}
    });
    return mcpAccessTokenSummary(token);
  }

  authenticateMcpAccessToken(input: {
    accessToken: string;
    requiredScope?: McpAccessScope;
    now?: Date;
  }): McpPrincipal {
    const now = input.now ?? new Date();
    const tokenHash = hashMcpAccessToken(input.accessToken);
    const tokenId = this.mcpTokenIdByHash.get(tokenHash);
    const token = tokenId === undefined ? undefined : this.mcpAccessTokens.get(tokenId);
    if (
      token === undefined ||
      token.revokedAt !== null ||
      Date.parse(token.expiresAt) <= now.getTime()
    ) {
      throw new Cp2Error(401, "mcp_token_invalid", "MCP access token is invalid or expired.");
    }
    if (input.requiredScope !== undefined && !token.scopes.includes(input.requiredScope)) {
      throw new Cp2Error(403, "mcp_scope_forbidden", "MCP token lacks the required scope.");
    }
    this.deps.requireIntegrationPrincipal({
      accountId: token.accountId,
      userId: token.userId,
      shopId: token.shopId,
      now
    });
    token.lastUsedAt = now.toISOString();
    return {
      tokenId: token.id,
      accountId: token.accountId,
      userId: token.userId,
      scopes: [...token.scopes],
      shopId: token.shopId,
      expiresAt: token.expiresAt
    };
  }
}
