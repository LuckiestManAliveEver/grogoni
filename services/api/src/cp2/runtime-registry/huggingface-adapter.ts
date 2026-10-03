import type { OssAgentSummary, RuntimeAssetKind } from "@grogoni/shared-types";
import type {
  RuntimeRegistryContext,
  RuntimeRegistryResourceDetails,
  RuntimeRegistryResourceFile,
  RuntimeRegistryResourceRef,
  RuntimeRegistrySearchItem,
  RuntimeRegistrySearchQuery
} from "@grogoni/shared-types";
import type {
  HuggingFaceModelCatalog,
  HuggingFaceAiModelSummary
} from "../huggingface-model-catalog.js";
import type { HuggingFaceAgentCatalog } from "../huggingface-agent-catalog.js";
import {
  RuntimeRegistryAccessRequiredError,
  RuntimeRegistryResourceNotFoundError,
  type RuntimeRegistryAdapter
} from "./types.js";

export interface HuggingFaceRegistryAdapterOptions {
  modelCatalog: HuggingFaceModelCatalog;
  agentCatalog: HuggingFaceAgentCatalog;
  fetcher?: typeof fetch;
  token?: string;
  requestTimeoutMs?: number;
}

const defaultRequestTimeoutMs = 8_000;
const readmeExcerptMaxChars = 2_000;
const maxReadmeFetchBytes = 200_000;

/**
 * Wraps the existing, already-working huggingface-model-catalog.ts and huggingface-agent-catalog.ts
 * behind the RuntimeRegistryAdapter interface.
 */
export function createHuggingFaceRegistryAdapter(
  options: HuggingFaceRegistryAdapterOptions
): RuntimeRegistryAdapter {
  const fetcher = options.fetcher ?? fetch;
  const token = options.token;
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? defaultRequestTimeoutMs);

  return {
    id: "huggingface",
    displayName: "Hugging Face",

    async search(
      query: RuntimeRegistrySearchQuery,
      context: RuntimeRegistryContext
    ): Promise<RuntimeRegistrySearchItem[]> {
      void context; // Reserved for a future per-account HF token; env-level token only today.
      const kinds = new Set<RuntimeAssetKind>(query.kinds ?? ["model", "agent"]);
      const items: RuntimeRegistrySearchItem[] = [];

      if (kinds.has("model")) {
        const result = await options.modelCatalog.searchModels(query.query);
        for (const model of result.models) {
          const item = huggingFaceModelToItem(model);
          if (item !== null) items.push(item);
        }
      }
      if (kinds.has("agent")) {
        const result = await options.agentCatalog.searchAgents(query.query);
        items.push(...result.agents.map(huggingFaceAgentToItem));
      }

      return items;
    },

    async inspect(
      ref: RuntimeRegistryResourceRef,
      context: RuntimeRegistryContext
    ): Promise<RuntimeRegistryResourceDetails> {
      void context;
      if (ref.kind === "model") {
        return inspectHuggingFaceModel(ref, { fetcher, token, requestTimeoutMs });
      }
      if (ref.kind === "agent") {
        return inspectHuggingFaceSpace(ref, { fetcher, token, requestTimeoutMs });
      }
      throw new RuntimeRegistryResourceNotFoundError(ref);
    }
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function huggingFaceModelToItem(
  model: HuggingFaceAiModelSummary
): RuntimeRegistrySearchItem | null {
  const parsed = parseHuggingFaceDownloadUrl(model.downloadUrl);
  if (parsed === null) return null;
  return {
    provider: "huggingface",
    kind: "model",
    externalId: `${parsed.repositoryId}#${parsed.fileName}`,
    name: parsed.fileName,
    displayName: model.label,
    description: model.description,
    owner: parsed.repositoryId.split("/")[0] ?? null,
    repositoryId: parsed.repositoryId,
    revision: "main",
    stars: null,
    downloads: null,
    updatedAt: null,
    license: model.license,
    verified: model.license === "Apache-2.0",
    imported: false,
    // The underlying catalog already filters to installable, commercially licensed, non-gated,
    // non-private GGUF files - a listed result already passed every static check that matters.
    compatibility: { status: "compatible" }
  };
}

function huggingFaceAgentToItem(agent: OssAgentSummary): RuntimeRegistrySearchItem {
  return {
    provider: "huggingface",
    kind: "agent",
    externalId: agent.sourceId,
    name: agent.sourceId,
    displayName: agent.label,
    description: agent.description,
    owner: agent.sourceId.split("/")[0] ?? null,
    repositoryId: agent.sourceId,
    revision: "main",
    stars: agent.popularity,
    downloads: null,
    updatedAt: agent.updatedAt,
    license: agent.license,
    verified: agent.licenseVerified,
    imported: false,
    compatibility: agent.licenseVerified
      ? { status: "compatible" }
      : { status: "inspection_required", reason: "License needs confirmation before import." }
  };
}

// ---------------------------------------------------------------------------
// Resource inspection (metadata + README excerpt only - never a weight file)
// ---------------------------------------------------------------------------

async function inspectHuggingFaceModel(
  ref: RuntimeRegistryResourceRef,
  deps: { fetcher: typeof fetch; token: string | undefined; requestTimeoutMs: number }
): Promise<RuntimeRegistryResourceDetails> {
  const parsed = parseModelExternalId(ref.externalId);
  if (parsed === null) throw new RuntimeRegistryResourceNotFoundError(ref);
  const details = await fetchJson(
    `https://huggingface.co/api/models/${encodeRepositoryPath(parsed.repositoryId)}?blobs=true`,
    ref,
    deps
  );
  if (details === null) throw new RuntimeRegistryResourceNotFoundError(ref);
  const siblings = (details.siblings as Array<Record<string, unknown>> | undefined) ?? [];
  const sibling = siblings.find((entry) => entry.rfilename === parsed.fileName);
  if (sibling === undefined) throw new RuntimeRegistryResourceNotFoundError(ref);
  const cardData = details.cardData as { license?: string | null } | undefined;
  const license = cardData?.license ?? null;
  const readmeExcerpt = await fetchReadmeExcerpt(
    `https://huggingface.co/${encodeRepositoryPath(parsed.repositoryId)}/raw/main/README.md`,
    deps
  );
  const lfsSize = (sibling.lfs as { size?: number } | undefined)?.size;
  const sizeBytes = typeof sibling.size === "number" ? sibling.size : (lfsSize ?? null);

  return {
    provider: "huggingface",
    kind: "model",
    externalId: ref.externalId,
    name: parsed.fileName,
    displayName: humanizeFileName(parsed.fileName),
    description: `${parsed.repositoryId} on-device GGUF model from the Hugging Face Hub.`,
    owner: parsed.repositoryId.split("/")[0] ?? null,
    repositoryId: parsed.repositoryId,
    revision: "main",
    stars: null,
    downloads: (details.downloads as number | undefined) ?? null,
    updatedAt: (details.lastModified as string | undefined) ?? null,
    license,
    verified: (license ?? "").toLowerCase() === "apache-2.0",
    imported: false,
    compatibility: { status: "compatible" },
    readmeExcerpt,
    files: [{ path: parsed.fileName, sizeBytes, contentType: "application/octet-stream" }],
    providerMetadata: { repository: details, sibling }
  };
}

async function inspectHuggingFaceSpace(
  ref: RuntimeRegistryResourceRef,
  deps: { fetcher: typeof fetch; token: string | undefined; requestTimeoutMs: number }
): Promise<RuntimeRegistryResourceDetails> {
  const repositoryId = ref.externalId;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryId)) {
    throw new RuntimeRegistryResourceNotFoundError(ref);
  }
  const details = await fetchJson(
    `https://huggingface.co/api/spaces/${encodeRepositoryPath(repositoryId)}`,
    ref,
    deps
  );
  if (details === null) throw new RuntimeRegistryResourceNotFoundError(ref);
  const cardData = details.cardData as
    | { license?: string | null; title?: string | null; short_description?: string | null }
    | undefined;
  const license = cardData?.license ?? readLicenseTag(details) ?? null;
  const readmeExcerpt = await fetchReadmeExcerpt(
    `https://huggingface.co/spaces/${encodeRepositoryPath(repositoryId)}/raw/main/README.md`,
    deps
  );
  const files: RuntimeRegistryResourceFile[] = [];

  return {
    provider: "huggingface",
    kind: "agent",
    externalId: repositoryId,
    name: repositoryId,
    displayName: cardData?.title?.trim() || (repositoryId.split("/")[1] as string) || repositoryId,
    description: cardData?.short_description?.trim() || `${repositoryId} public agent Space.`,
    owner: repositoryId.split("/")[0] ?? null,
    repositoryId,
    revision: "main",
    stars: (details.likes as number | undefined) ?? null,
    downloads: null,
    updatedAt: (details.lastModified as string | undefined) ?? null,
    license,
    verified: license !== null,
    imported: false,
    compatibility:
      license !== null
        ? { status: "compatible" }
        : { status: "inspection_required", reason: "License needs confirmation before import." },
    readmeExcerpt,
    files,
    providerMetadata: { space: details }
  };
}

function readLicenseTag(details: Record<string, unknown>): string | null {
  const tags = (details.tags as string[] | undefined) ?? [];
  const licenseTag = tags.find((tag) => tag.toLowerCase().startsWith("license:"));
  return licenseTag?.slice("license:".length) ?? null;
}

/**
 * A gated/private Hugging Face repository responds 401/403 (access denied, existence confirmed)
 * rather than 404 (does not exist) - unlike GitHub, which deliberately collapses both into 404 for
 * a private repo to avoid confirming existence to an unauthorized caller. That distinction is real
 * signal here, so it is preserved as RuntimeRegistryAccessRequiredError rather than folded into the
 * generic "not found" case; callers map it to the import state machine's ACCESS_REQUIRED, never an
 * attempt to work around it.
 */
async function fetchJson(
  url: string,
  ref: RuntimeRegistryResourceRef,
  deps: { fetcher: typeof fetch; token: string | undefined; requestTimeoutMs: number }
): Promise<Record<string, unknown> | null> {
  try {
    const response = await deps.fetcher(url, {
      headers: huggingFaceHeaders(deps.token),
      signal: AbortSignal.timeout(deps.requestTimeoutMs)
    });
    if (response.status === 401 || response.status === 403) {
      throw new RuntimeRegistryAccessRequiredError(ref);
    }
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof RuntimeRegistryAccessRequiredError) throw error;
    return null;
  }
}

/** Small text file only (README), truncated - never a weight/artifact file. Bounded read guards
 *  against an unexpectedly large README being fetched in full. */
async function fetchReadmeExcerpt(
  url: string,
  deps: { fetcher: typeof fetch; token: string | undefined; requestTimeoutMs: number }
): Promise<string | null> {
  try {
    const response = await deps.fetcher(url, {
      headers: huggingFaceHeaders(deps.token),
      signal: AbortSignal.timeout(deps.requestTimeoutMs)
    });
    if (!response.ok) return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > maxReadmeFetchBytes) {
      return null;
    }
    const text = await response.text();
    return text.slice(0, readmeExcerptMaxChars);
  } catch {
    return null;
  }
}

function parseHuggingFaceDownloadUrl(
  downloadUrl: string | null
): { repositoryId: string; fileName: string } | null {
  if (downloadUrl === null) return null;
  try {
    const url = new URL(downloadUrl);
    if (url.hostname !== "huggingface.co") return null;
    const match = /^\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url.pathname);
    if (match === null) return null;
    return { repositoryId: match[1]!, fileName: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

function parseModelExternalId(
  externalId: string
): { repositoryId: string; fileName: string } | null {
  const separatorIndex = externalId.indexOf("#");
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) return null;
  const repositoryId = externalId.slice(0, separatorIndex);
  const fileName = externalId.slice(separatorIndex + 1);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryId)) return null;
  return { repositoryId, fileName };
}

function humanizeFileName(fileName: string): string {
  return fileName
    .replace(/\.gguf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function encodeRepositoryPath(repositoryId: string): string {
  return repositoryId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function huggingFaceHeaders(token: string | undefined): HeadersInit {
  return {
    accept: "application/json",
    "user-agent": "grogoni-runtime-registry",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}
