// ---------------------------------------------------------------------------
// External registry connections (GitHub / Hugging Face "connect account")
// ---------------------------------------------------------------------------

export type ExternalRegistryProvider = "github" | "huggingface";

export type ExternalRegistryConnectionStatus = "connected" | "expired" | "revoked" | "error";

/**
 * Server-side record of a connected external account. The encrypted credential itself is
 * never part of this type -- it is never returned to the browser after storage.
 */
export interface ExternalRegistryConnection {
  id: string;
  accountId: string;
  provider: ExternalRegistryProvider;
  externalAccountId: string | null;
  externalUsername: string | null;
  status: ExternalRegistryConnectionStatus;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Unified discovery / search contract
// ---------------------------------------------------------------------------

export type RuntimeAssetKind = "agent" | "model";

export type RuntimeRegistryProviderId = "grogoni" | "github" | "huggingface";

export interface RuntimeRegistrySearchQuery {
  query: string;
  kinds?: RuntimeAssetKind[];
  providers?: RuntimeRegistryProviderId[];
  cursor?: string;
  limit?: number;
}

/** Resolved per-request auth/authorization the adapters receive; never a raw token. */
export interface RuntimeRegistryContext {
  accountId: string;
  /** True only when the caller has a connected, non-expired connection for this provider. */
  connected: boolean;
}

export type RuntimeRegistryCompatibilityStatus =
  "compatible" | "incompatible" | "unknown" | "inspection_required";

export interface RuntimeRegistrySearchItem {
  provider: RuntimeRegistryProviderId;
  kind: RuntimeAssetKind;

  externalId: string;
  name: string;
  displayName: string;
  description: string | null;

  owner: string | null;
  repositoryId: string | null;
  revision: string | null;

  stars?: number | null;
  downloads?: number | null;
  updatedAt?: string | null;

  license?: string | null;

  verified: boolean;
  imported: boolean;

  compatibility: {
    status: RuntimeRegistryCompatibilityStatus;
    reason?: string;
  };
}

export interface RuntimeRegistryProviderResult {
  status: "ok" | "error";
  errorMessage?: string;
}

export interface RuntimeRegistrySearchResult {
  items: RuntimeRegistrySearchItem[];
  providers: Partial<Record<RuntimeRegistryProviderId, RuntimeRegistryProviderResult>>;
  cursor?: string;
}

export interface RuntimeRegistryResourceRef {
  provider: RuntimeRegistryProviderId;
  kind: RuntimeAssetKind;
  externalId: string;
  revision?: string;
}

/** Provider-native metadata is kept separate from the normalized search item on purpose. */
export interface RuntimeRegistryResourceDetails extends RuntimeRegistrySearchItem {
  readmeExcerpt: string | null;
  files: RuntimeRegistryResourceFile[];
  providerMetadata: Record<string, unknown>;
}

export interface RuntimeRegistryResourceFile {
  path: string;
  sizeBytes: number | null;
  contentType: string | null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface RuntimeAssetProvenance {
  provider: "github" | "huggingface";
  externalId: string;
  repositoryUrl?: string;
  owner?: string;
  revision?: string;
  commitSha?: string;
  filename?: string;
  checksum?: string;
  license?: string | null;
  importedAt: string;
  importedBy: string;
}

// ---------------------------------------------------------------------------
// Import lifecycle
// ---------------------------------------------------------------------------

export type RuntimeAssetImportState =
  | "DISCOVERED"
  | "INSPECTING"
  | "VALIDATED"
  | "IMPORTING"
  | "REGISTERED"
  | "PROVISIONING"
  | "READY"
  | "ACTIVE"
  | "INSPECTION_FAILED"
  | "VALIDATION_FAILED"
  | "IMPORT_FAILED"
  | "PROVISIONING_FAILED"
  | "INCOMPATIBLE"
  | "ACCESS_REQUIRED"
  | "LICENSE_CONFIRMATION_REQUIRED";

export const terminalFailureImportStates: readonly RuntimeAssetImportState[] = [
  "INSPECTION_FAILED",
  "VALIDATION_FAILED",
  "IMPORT_FAILED",
  "PROVISIONING_FAILED",
  "INCOMPATIBLE",
  "ACCESS_REQUIRED",
  "LICENSE_CONFIRMATION_REQUIRED"
];

export interface RuntimeRegistryImport {
  id: string;
  accountId: string;
  kind: RuntimeAssetKind;
  provider: RuntimeRegistryProviderId;
  state: RuntimeAssetImportState;
  stateReason: string | null;
  ref: RuntimeRegistryResourceRef;
  provenance: RuntimeAssetProvenance | null;
  /** Set once the imported asset is registered as a canonical agent/adapter/model id. */
  registeredAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Model artifact storage (control plane, not a filesystem)
// ---------------------------------------------------------------------------

export interface ModelArtifactLocation {
  storageProvider: string;
  storageKey: string;
  checksum: string;
  sizeBytes: number;
}
