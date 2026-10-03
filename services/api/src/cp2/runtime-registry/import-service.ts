import type {
  AgentDefinitionId,
  OssAgentSummary,
  RuntimeAssetImportState,
  RuntimeAssetProvenance,
  RuntimeRegistryContext,
  RuntimeRegistryImport,
  RuntimeRegistryProviderId,
  RuntimeRegistryResourceDetails,
  RuntimeRegistryResourceRef
} from "@grogoni/shared-types";
import {
  portableAgentManifestFromOssAgent,
  validatePortableAgentManifest
} from "@grogoni/shared-types";
import { Cp2Error } from "../cp2-error.js";
import type { RuntimeRegistryAdapter } from "./types.js";
import {
  RuntimeRegistryAccessRequiredError,
  RuntimeRegistryResourceNotFoundError
} from "./types.js";
import type { RuntimeRegistryImportStore } from "./import-store.js";

const modelArtifactStorageNotWiredReason =
  "Safe artifact storage (streamed, size-capped, checksum-verified) is not wired into this import " +
  "path yet - see services/api/src/cp2/account-ai-asset-store.ts. Downloading the full model " +
  "artifact server-side without that safety net is out of scope for this step, so the import stops " +
  "here rather than faking a READY model.";

export interface StartRuntimeRegistryImportInput {
  accountId: string;
  userId: string;
  ref: RuntimeRegistryResourceRef;
}

export interface RuntimeRegistryImportServiceDeps {
  store: RuntimeRegistryImportStore;
  adapters: Partial<Record<RuntimeRegistryProviderId, RuntimeRegistryAdapter>>;
  now?: () => string;
}

export function createRuntimeRegistryImportService(deps: RuntimeRegistryImportServiceDeps) {
  const now = deps.now ?? (() => new Date().toISOString());

  async function transition(
    importRecord: RuntimeRegistryImport,
    state: RuntimeAssetImportState,
    stateReason: string | null,
    extra: Partial<Pick<RuntimeRegistryImport, "provenance" | "registeredAssetId">> = {}
  ): Promise<RuntimeRegistryImport> {
    return deps.store.update(
      importRecord.id,
      importRecord.accountId,
      { state, stateReason, ...extra },
      now()
    );
  }

  return {
    async startImport(input: StartRuntimeRegistryImportInput): Promise<RuntimeRegistryImport> {
      const adapter = deps.adapters[input.ref.provider];
      if (adapter === undefined) {
        throw new Cp2Error(
          400,
          "runtime_registry_provider_unavailable",
          `The ${input.ref.provider} runtime registry provider is not configured.`
        );
      }

      let record = await deps.store.create(
        {
          accountId: input.accountId,
          kind: input.ref.kind,
          provider: input.ref.provider,
          state: "DISCOVERED",
          stateReason: null,
          ref: input.ref,
          provenance: null,
          registeredAssetId: null
        },
        now()
      );

      const context: RuntimeRegistryContext = { accountId: input.accountId, connected: false };
      record = await transition(record, "INSPECTING", null);

      let details: RuntimeRegistryResourceDetails;
      try {
        details = await adapter.inspect(input.ref, context);
      } catch (error) {
        if (error instanceof RuntimeRegistryAccessRequiredError) {
          // Access is denied, not merely unimplemented - never attempt to circumvent it (e.g. by
          // retrying with a different credential this caller doesn't own). The record stops here;
          // a caller can retry the same import once their connected account is actually authorized.
          return transition(record, "ACCESS_REQUIRED", error.message);
        }
        const message =
          error instanceof RuntimeRegistryResourceNotFoundError
            ? error.message
            : "The runtime registry resource could not be inspected.";
        return transition(record, "INSPECTION_FAILED", message);
      }

      if (input.ref.kind === "agent") {
        return importAgent(record, details, input, transition);
      }
      return importModel(record, details, input, transition);
    },

    async getImport(id: string, accountId: string): Promise<RuntimeRegistryImport | null> {
      return deps.store.get(id, accountId);
    },

    async listImports(accountId: string): Promise<RuntimeRegistryImport[]> {
      return deps.store.list(accountId);
    }
  };
}

type TransitionFn = (
  record: RuntimeRegistryImport,
  state: RuntimeAssetImportState,
  stateReason: string | null,
  extra?: Partial<Pick<RuntimeRegistryImport, "provenance" | "registeredAssetId">>
) => Promise<RuntimeRegistryImport>;

// ---------------------------------------------------------------------------
// Agent: discover -> inspect -> validate (grogoni.agent.json if present, else synthesize) -> REGISTERED
// ---------------------------------------------------------------------------

async function importAgent(
  record: RuntimeRegistryImport,
  details: RuntimeRegistryResourceDetails,
  input: StartRuntimeRegistryImportInput,
  transition: TransitionFn
): Promise<RuntimeRegistryImport> {
  if (details.compatibility.status === "incompatible") {
    return transition(
      record,
      "VALIDATION_FAILED",
      details.compatibility.reason ?? "This agent failed compatibility inspection."
    );
  }
  if (
    details.compatibility.status === "inspection_required" ||
    details.compatibility.status === "unknown"
  ) {
    return transition(
      record,
      "LICENSE_CONFIRMATION_REQUIRED",
      details.compatibility.reason ?? "This agent's license needs confirmation before import."
    );
  }

  const declaredManifest = readEmbeddedManifest(details, "grogoniAgentManifest");
  const manifestValidation =
    declaredManifest === undefined ? null : validatePortableAgentManifest(declaredManifest);
  if (manifestValidation !== null && !manifestValidation.valid) {
    return transition(
      record,
      "VALIDATION_FAILED",
      `grogoni.agent.json failed validation: ${manifestValidation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`
    );
  }

  const manifest =
    manifestValidation !== null && manifestValidation.valid
      ? manifestValidation.manifest
      : portableAgentManifestFromOssAgent(syntheticOssAgentSummary(details));

  record = await transition(record, "VALIDATED", null);
  record = await transition(record, "IMPORTING", null);
  const provenance = buildProvenance(details, input.userId);
  return transition(record, "REGISTERED", null, {
    provenance,
    registeredAssetId: manifest.agent.id
  });
}

// ---------------------------------------------------------------------------
// Model: discover -> inspect -> validate -> resolve one artifact -> REGISTERED -> PROVISIONING
// (server-side artifact download is intentionally out of scope for this task; see
// modelArtifactStorageNotWiredReason)
// ---------------------------------------------------------------------------

async function importModel(
  record: RuntimeRegistryImport,
  details: RuntimeRegistryResourceDetails,
  input: StartRuntimeRegistryImportInput,
  transition: TransitionFn
): Promise<RuntimeRegistryImport> {
  if (details.compatibility.status !== "compatible") {
    return transition(
      record,
      details.compatibility.status === "incompatible" ? "INCOMPATIBLE" : "VALIDATION_FAILED",
      details.compatibility.reason ?? "This model failed compatibility inspection."
    );
  }
  const file = details.files[0];
  if (file === undefined) {
    return transition(record, "VALIDATION_FAILED", "No installable artifact file was found.");
  }

  record = await transition(record, "VALIDATED", null);
  record = await transition(record, "IMPORTING", null);
  const checksum = readChecksum(details);
  const provenance = buildProvenance(details, input.userId, {
    filename: file.path,
    ...(checksum === undefined ? {} : { checksum })
  });
  record = await transition(record, "REGISTERED", null, { provenance });
  return transition(record, "PROVISIONING", modelArtifactStorageNotWiredReason);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a RuntimeAssetProvenance record. Optional fields are omitted entirely (never assigned
 *  `undefined`) to satisfy exactOptionalPropertyTypes - see tsconfig.base.json. */
function buildProvenance(
  details: RuntimeRegistryResourceDetails,
  importedBy: string,
  extra: { filename?: string; checksum?: string } = {}
): RuntimeAssetProvenance {
  const repositoryUrl = repositoryUrlFor(details);
  return {
    provider: details.provider === "github" ? "github" : "huggingface",
    externalId: details.externalId,
    ...(repositoryUrl === undefined ? {} : { repositoryUrl }),
    ...(details.owner === null ? {} : { owner: details.owner }),
    ...(details.revision === null ? {} : { revision: details.revision }),
    ...(extra.filename === undefined ? {} : { filename: extra.filename }),
    ...(extra.checksum === undefined ? {} : { checksum: extra.checksum }),
    ...(details.license === undefined ? {} : { license: details.license }),
    importedAt: new Date().toISOString(),
    importedBy
  };
}

function repositoryUrlFor(details: RuntimeRegistryResourceDetails): string | undefined {
  if (details.repositoryId === null) return undefined;
  if (details.provider === "github") return `https://github.com/${details.repositoryId}`;
  if (details.provider === "huggingface") {
    return details.kind === "agent"
      ? `https://huggingface.co/spaces/${details.repositoryId}`
      : `https://huggingface.co/${details.repositoryId}`;
  }
  return undefined;
}

function readChecksum(details: RuntimeRegistryResourceDetails): string | undefined {
  const metadata = details.providerMetadata as Record<string, unknown>;
  const sibling = metadata.sibling as Record<string, unknown> | undefined;
  const lfs = sibling?.lfs as Record<string, unknown> | undefined;
  if (typeof lfs?.oid === "string") return lfs.oid;
  if (typeof sibling?.blobId === "string") return sibling.blobId;
  const asset = metadata.asset as Record<string, unknown> | undefined;
  if (typeof asset?.digest === "string") return asset.digest;
  return undefined;
}

/** GitHub agent inspect() surfaces a repository-authored grogoni.agent.json (when present) under
 *  providerMetadata.grogoniAgentManifest - see github-adapter.ts. Absent for every other provider. */
function readEmbeddedManifest(
  details: RuntimeRegistryResourceDetails,
  key: string
): unknown | undefined {
  const metadata = details.providerMetadata as Record<string, unknown>;
  return metadata[key];
}

function syntheticOssAgentSummary(details: RuntimeRegistryResourceDetails): OssAgentSummary {
  const source = details.provider === "github" ? "github" : "huggingface";
  return {
    id: `${source}:${details.externalId.toLowerCase()}` as AgentDefinitionId,
    label: details.displayName,
    description: details.description ?? `${details.externalId} open-source agent.`,
    source,
    sourceId: details.externalId,
    sourceUrl: repositoryUrlFor(details) ?? `https://${source}.com`,
    license: details.license ?? "unknown",
    licenseUrl: `${repositoryUrlFor(details) ?? ""}`,
    licenseVerified: details.verified,
    runtime: "unknown",
    executionMode: source === "github" ? "backend-adapter" : "hosted-api",
    minimumDeviceTier: "medium",
    minimumMemoryGb: 4,
    requiresGpu: false,
    popularity: details.stars ?? 0,
    capabilities: ["open-source", "agent"],
    updatedAt: details.updatedAt ?? null
  };
}
