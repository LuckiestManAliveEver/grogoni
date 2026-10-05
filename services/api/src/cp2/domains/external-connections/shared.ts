/**
 * External registry connections domain: lets an account paste a GitHub or Hugging Face personal
 * access token so registry search/import (built by a parallel workstream against
 * `RuntimeRegistryContext`/`resolveExternalConnectionToken`) gets higher API rate limits and can
 * reach private/gated resources. Mirrors
 * services/api/src/cp2/domains/oauth/shared.ts's shape - pure types and small pure helpers only,
 * no I/O, no fetch. The provider-validation fetch calls live in store.ts (this domain's only
 * impure surface), matching how services/api/src/cp2/oauth.ts keeps its own fetch calls out of
 * domains/oauth/shared.ts.
 *
 * Architecture note (see the task brief): connections are established via a pasted personal
 * access token, not a new OAuth app flow - this needs no registered OAuth application or client
 * secret from the deployment owner. The token is encrypted at rest with the same
 * encryptOAuthToken/decryptOAuthToken helpers services/api/src/cp2/oauth.ts already provides for
 * userIdentities, never returned to the browser after storage, and resolved server-side only via
 * `resolveToken` below.
 */
import type {
  ExternalRegistryConnection,
  ExternalRegistryConnectionStatus,
  ExternalRegistryProvider
} from "@grogoni/shared-types";

/**
 * Server-side record. Extends the public summary type with the encrypted token - this field must
 * never leave this domain except through `encryptOAuthToken`/`decryptOAuthToken`. Every route
 * response and every other public accessor must go through `externalConnectionView` below, which
 * strips it.
 */
export interface ExternalConnectionRecord extends ExternalRegistryConnection {
  encryptedToken: string | null;
}

export function externalConnectionKey(
  accountId: string,
  provider: ExternalRegistryProvider
): string {
  return `${accountId}:${provider}`;
}

/** Strips the encrypted token. The only shape ever sent to a Fastify route response. */
export function externalConnectionView(
  record: ExternalConnectionRecord
): ExternalRegistryConnection {
  return {
    id: record.id,
    accountId: record.accountId,
    provider: record.provider,
    externalAccountId: record.externalAccountId,
    externalUsername: record.externalUsername,
    status: record.status,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function isUsableConnectionStatus(status: ExternalRegistryConnectionStatus): boolean {
  return status === "connected";
}

export function parseExternalRegistryProvider(value: unknown): ExternalRegistryProvider | null {
  return value === "github" || value === "huggingface" ? value : null;
}
