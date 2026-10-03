/**
 * Eleventh slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). Owns `mcpAccessTokens` and the derived
 * `mcpTokenIdByHash` index - the smallest, most self-contained slice yet, matching the assessment
 * already made when `AgentRuntimeDomain` was extracted: zero code coupling either direction with
 * any other domain, a dedicated route module (`services/api/src/mcp/routes.ts`, entirely separate
 * from `cp2/routes.ts`), and its own purge-script batch. Named `mcp-tokens` (not `mcp`) to avoid
 * confusion with that top-level `services/api/src/mcp/` route directory.
 *
 * **Known pre-existing gap, preserved as-is, not silently fixed:** `hydrateSnapshot()` never
 * cleared `mcpAccessTokens` before this extraction - every other Map in the store is cleared
 * before its snapshot data is restored, but this one was not, so an in-process restore (calling
 * `hydrateSnapshot` more than once on the same running instance, not a normal startup path) would
 * leave stale tokens from the prior in-memory state merged with the new snapshot instead of fully
 * replaced. This domain's own `clear()` method does clear the Map correctly (for the
 * account-purge path, which does need it), but `Cp2Store.hydrateSnapshot()` deliberately does not
 * call it, matching the pre-extraction behavior exactly rather than introducing a fix as an
 * incidental side effect of moving code.
 */
import { createHash } from "node:crypto";
import type { McpAccessTokenSummary } from "@grogoni/shared-types";

export interface McpAccessTokenRecord extends McpAccessTokenSummary {
  userId: string;
  /** Immutable creation provenance only. Never an authentication or authorization dependency. */
  createdBySessionId: string | null;
  tokenHash: string;
}

export function hashMcpAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

export function mcpAccessTokenSummary(token: McpAccessTokenRecord): McpAccessTokenSummary {
  return {
    id: token.id,
    accountId: token.accountId,
    name: token.name,
    scopes: [...token.scopes],
    shopId: token.shopId,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt
  };
}
