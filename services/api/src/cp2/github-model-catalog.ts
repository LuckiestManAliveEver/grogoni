import type { AiModelSummary } from "@grogoni/shared-types";

export type GitHubAiModelSummary = Omit<AiModelSummary, "source"> & {
  source: "github";
};

export interface GitHubModelSearchResult {
  models: GitHubAiModelSummary[];
  status: "available" | "unavailable";
  connection: "authenticated" | "public";
  message: string;
}

export interface GitHubModelCatalog {
  searchModels: (search?: string) => Promise<GitHubModelSearchResult>;
}

export interface GitHubModelCatalogOptions {
  cacheTtlMs?: number;
  fetcher?: typeof fetch;
  maxAssetBytes?: number;
  maxRepositories?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  token?: string;
}

interface GitHubRepositorySearchResponse {
  items?: GitHubRepository[];
}

interface GitHubRepository {
  default_branch?: string;
  description?: string | null;
  full_name?: string;
  html_url?: string;
  license?: {
    spdx_id?: string | null;
  } | null;
}

interface GitHubRelease {
  assets?: GitHubReleaseAsset[];
  draft?: boolean;
  html_url?: string;
  name?: string | null;
  prerelease?: boolean;
  tag_name?: string;
}

interface GitHubReleaseAsset {
  browser_download_url?: string;
  name?: string;
  size?: number;
  state?: string;
}

interface CachedSearch {
  expiresAt: number;
  result: GitHubModelSearchResult;
}

const defaultCacheTtlMs = 15 * 60 * 1000;
const defaultMaxAssetBytes = 2 * 1024 ** 3;
const defaultRequestTimeoutMs = 8_000;
const failureCacheTtlMs = 60_000;
const minimumAssetBytes = 50 * 1024 ** 2;

export function createGitHubModelCatalog(
  options: GitHubModelCatalogOptions = {}
): GitHubModelCatalog {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
  const maxAssetBytes = options.maxAssetBytes ?? defaultMaxAssetBytes;
  const maxRepositories = Math.min(8, Math.max(1, options.maxRepositories ?? 5));
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? defaultRequestTimeoutMs);
  const token = normalizeGitHubToken(options.token);
  const cache = new Map<string, CachedSearch>();

  return {
    async searchModels(search) {
      const normalizedSearch = normalizeGitHubSearch(search);
      const cacheKey = normalizedSearch || "android-small-model";
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now()) {
        return cloneSearchResult(cached.result);
      }

      const result = await discoverGitHubModels({
        fetcher,
        maxAssetBytes,
        maxRepositories,
        requestTimeoutMs,
        search: normalizedSearch,
        token
      });
      cache.set(cacheKey, {
        expiresAt:
          now() +
          (result.status === "available" ? cacheTtlMs : Math.min(cacheTtlMs, failureCacheTtlMs)),
        result
      });
      return cloneSearchResult(result);
    }
  };
}

export function createGitHubModelCatalogFromEnvironment(): GitHubModelCatalog {
  return createGitHubModelCatalog({
    ...(process.env.GITHUB_TOKEN === undefined ? {} : { token: process.env.GITHUB_TOKEN })
  });
}

async function discoverGitHubModels(input: {
  fetcher: typeof fetch;
  maxAssetBytes: number;
  maxRepositories: number;
  requestTimeoutMs: number;
  search: string;
  token: string | undefined;
}): Promise<GitHubModelSearchResult> {
  const terms = input.search || "small android language model";
  const query = `${terms} gguf in:name,description,readme license:apache-2.0 archived:false`;
  const searchUrl = new URL("https://api.github.com/search/repositories");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("sort", "stars");
  searchUrl.searchParams.set("order", "desc");
  searchUrl.searchParams.set("per_page", String(input.maxRepositories));

  try {
    const response = await input.fetcher(searchUrl, {
      headers: githubHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) {
      return {
        models: [],
        status: "unavailable",
        connection: input.token === undefined ? "public" : "authenticated",
        message: githubFailureMessage(response.status)
      };
    }

    const body = (await response.json()) as GitHubRepositorySearchResponse;
    const repositories = (body.items ?? [])
      .filter(isCommercialGitHubRepository)
      .slice(0, input.maxRepositories);
    const discovered = await Promise.all(
      repositories.map((repository) =>
        discoverRepositoryReleaseModels({
          fetcher: input.fetcher,
          maxAssetBytes: input.maxAssetBytes,
          repository,
          requestTimeoutMs: input.requestTimeoutMs,
          token: input.token
        })
      )
    );
    const models = discovered
      .flat()
      .sort((left, right) => {
        const sizeDifference = (left.fileSizeBytes ?? 0) - (right.fileSizeBytes ?? 0);
        return sizeDifference !== 0 ? sizeDifference : left.label.localeCompare(right.label);
      })
      .slice(0, 12);

    return {
      models,
      status: "available",
      connection: input.token === undefined ? "public" : "authenticated",
      message:
        models.length === 0
          ? `GitHub ${connectionLabel(input.token)} connected, but no commercially permitted Android-sized GGUF release assets matched.`
          : `GitHub ${connectionLabel(input.token)} connected. Found ${models.length} installable GGUF release ${
              models.length === 1 ? "asset" : "assets"
            }.`
    };
  } catch {
    return {
      models: [],
      status: "unavailable",
      connection: input.token === undefined ? "public" : "authenticated",
      message: "GitHub model discovery is temporarily unavailable."
    };
  }
}

async function discoverRepositoryReleaseModels(input: {
  fetcher: typeof fetch;
  maxAssetBytes: number;
  repository: GitHubRepository;
  requestTimeoutMs: number;
  token: string | undefined;
}): Promise<GitHubAiModelSummary[]> {
  const fullName = input.repository.full_name;
  if (fullName === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
    return [];
  }

  const releasesUrl = new URL(`https://api.github.com/repos/${fullName}/releases`);
  releasesUrl.searchParams.set("per_page", "5");

  try {
    const response = await input.fetcher(releasesUrl, {
      headers: githubHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) return [];
    const releases = (await response.json()) as GitHubRelease[];

    return releases
      .filter((release) => release.draft !== true && release.prerelease !== true)
      .flatMap((release) =>
        (release.assets ?? [])
          .filter((asset) => isInstallableGgufAsset(asset, fullName, input.maxAssetBytes))
          .slice(0, 3)
          .map((asset) => githubAssetToAiModel(input.repository, release, asset))
      );
  } catch {
    return [];
  }
}

function githubAssetToAiModel(
  repository: GitHubRepository,
  release: GitHubRelease,
  asset: GitHubReleaseAsset
): GitHubAiModelSummary {
  const fullName = repository.full_name!;
  const fileName = asset.name!;
  const fileSizeBytes = asset.size!;
  const repositorySlug = fullName.toLowerCase().replace("/", ".");
  const assetSlug = slugify(fileName.replace(/\.gguf$/i, "")).slice(0, 64);
  const releaseLabel = release.name?.trim() || release.tag_name?.trim() || "published release";
  const capabilities = inferCapabilities(`${fullName} ${fileName}`);

  return {
    id: `github:${repositorySlug}.${assetSlug}`.slice(0, 150),
    label: humanizeModelLabel(fileName),
    provider: "local",
    description: `${repository.description?.trim() || `${fullName} on-device model`} GitHub ${releaseLabel}.`,
    capabilities,
    available: true,
    source: "github",
    format: "GGUF",
    license: "Apache-2.0",
    licenseUrl: `${repository.html_url}/blob/${repository.default_branch || "main"}/LICENSE`,
    modelCardUrl: release.html_url ?? repository.html_url ?? `https://github.com/${fullName}`,
    downloadUrl: asset.browser_download_url!,
    fileName,
    fileSizeBytes,
    minimumMemoryGb: inferMinimumMemoryGb(fileSizeBytes),
    recommended: /q4[_-]?k[_-]?m/i.test(fileName) && fileSizeBytes <= 800 * 1024 ** 2,
    // Discovered dynamically from a third-party GitHub release; its context window is not known
    // without parsing a model card, so it is left undeclared rather than guessed.
    contextWindow: null
  };
}

function isCommercialGitHubRepository(repository: GitHubRepository): boolean {
  return (
    repository.license?.spdx_id === "Apache-2.0" &&
    typeof repository.full_name === "string" &&
    typeof repository.html_url === "string"
  );
}

function isInstallableGgufAsset(
  asset: GitHubReleaseAsset,
  fullName: string,
  maxAssetBytes: number
): boolean {
  if (
    asset.state !== "uploaded" ||
    typeof asset.name !== "string" ||
    !asset.name.toLowerCase().endsWith(".gguf") ||
    typeof asset.size !== "number" ||
    !Number.isFinite(asset.size) ||
    asset.size < minimumAssetBytes ||
    asset.size > maxAssetBytes ||
    typeof asset.browser_download_url !== "string"
  ) {
    return false;
  }

  try {
    const url = new URL(asset.browser_download_url);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.pathname.startsWith(`/${fullName}/releases/download/`) &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function normalizeGitHubSearch(search: string | undefined): string {
  return (search ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+._ -]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80);
}

function githubHeaders(token: string | undefined): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "grogoni-on-device-model-catalog",
    "x-github-api-version": "2022-11-28",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function githubFailureMessage(status: number): string {
  if (status === 403 || status === 429) {
    return "GitHub model discovery is rate-limited. Try again later or configure GITHUB_TOKEN.";
  }
  return `GitHub model discovery failed (${status}).`;
}

function normalizeGitHubToken(token: string | undefined): string | undefined {
  const normalized = token?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function connectionLabel(token: string | undefined): string {
  return token === undefined ? "public API" : "authenticated API";
}

function inferMinimumMemoryGb(fileSizeBytes: number): number {
  if (fileSizeBytes <= 450 * 1024 ** 2) return 2;
  if (fileSizeBytes <= 800 * 1024 ** 2) return 3;
  if (fileSizeBytes <= 1_300 * 1024 ** 2) return 6;
  return 8;
}

function inferCapabilities(value: string): string[] {
  const normalized = value.toLowerCase();
  return [
    "chat",
    "offline",
    "github-release",
    ...(/qwen|gemma|aya|multilingual/.test(normalized) ? ["multilingual"] : []),
    ...(/instruct|chat/.test(normalized) ? ["instruction-following"] : []),
    ...(/reason|math/.test(normalized) ? ["reasoning"] : [])
  ];
}

function humanizeModelLabel(fileName: string): string {
  return fileName
    .replace(/\.gguf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bq(\d)\s*k\s*m\b/gi, "Q$1_K_M")
    .replace(/\bq(\d)\s*(\d)\b/gi, "Q$1_$2")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

function cloneSearchResult(result: GitHubModelSearchResult): GitHubModelSearchResult {
  return {
    ...result,
    models: result.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities]
    }))
  };
}
