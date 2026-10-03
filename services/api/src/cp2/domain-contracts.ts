import type { UserIdentitySummary } from "@grogoni/shared-types";

/** Public cross-domain record contracts. Domain-private modules may own the storage. */
export interface CustomerRuntimeCapabilityRecord {
  id: string;
  businessId: string;
  conversationId: string;
  platformIdentityId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface UserIdentityRecord extends UserIdentitySummary {
  encryptedAccessToken: string | null;
  encryptedRefreshToken: string | null;
  encryptedIdToken: string | null;
  tokenType: string | null;
  tokenExpiresAt: string | null;
  scope: string | null;
  updatedAt: string;
}
