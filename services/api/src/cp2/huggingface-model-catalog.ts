import type { AiModelSummary } from "@grogoni/shared-types";

export type HuggingFaceAiModelSummary = Omit<AiModelSummary, "source"> & {
  source: "huggingface";
};

export interface HuggingFaceModelSearchResult {
  models: HuggingFaceAiModelSummary[];
  status: "available" | "unavailable";
  connection: "authenticated" | "public";
  message: string;
}

export interface HuggingFaceModelCatalog {
  searchModels: (search?: string) => Promise<HuggingFaceModelSearchResult>;
}

export interface HuggingFaceModelCatalogOptions {
  cacheTtlMs?: number;
  fetcher?: typeof fetch;
  maxAssetBytes?: number;
  maxRepositories?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  token?: string;
}

interface HuggingFaceModelRepository {
  cardData?: {
    license?: string | null;
    license_link?: string | null;
  } | null;
  disabled?: boolean;
  downloads?: number;
  gated?: boolean | "auto" | "manual";
  id?: string;
  modelId?: string;
  pipeline_tag?: string | null;
  private?: boolean;
  siblings?: HuggingFaceRepoFile[];
  tags?: string[];
}

interface HuggingFaceRepoFile {
  lfs?: {
    size?: number;
  } | null;
  rfilename?: string;
  size?: number;
}

interface CachedSearch {
  expiresAt: number;
  result: HuggingFaceModelSearchResult;
}

const defaultCacheTtlMs = 15 * 60 * 1000;
const defaultMaxAssetBytes = 2 * 1024 ** 3;
const defaultRequestTimeoutMs = 8_000;
const failureCacheTtlMs = 60_000;
const minimumAssetBytes = 50 * 1024 ** 2;

export function createHuggingFaceModelCatalog(
  options: HuggingFaceModelCatalogOptions = {}
): HuggingFaceModelCatalog {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
  const maxAssetBytes = options.maxAssetBytes ?? defaultMaxAssetBytes;
  const maxRepositories = Math.min(10, Math.max(1, options.maxRepositories ?? 6));
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? defaultRequestTimeoutMs);
  const token = normalizeToken(options.token);
  const cache = new Map<string, CachedSearch>();

  return {
    async searchModels(search) {
      const normalizedSearch = normalizeSearch(search);
      const cacheKey = normalizedSearch || "popular-android-gguf";
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now()) {
        return cloneSearchResult(cached.result);
      }

      const result = await discoverHuggingFaceModels({
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

export function createHuggingFaceModelCatalogFromEnvironment(): HuggingFaceModelCatalog {
  const token = process.env.HF_TOKEN ?? process.env.HUGGINGFACE_TOKEN;
  return createHuggingFaceModelCatalog({
    ...(token === undefined ? {} : { token })
  });
}

async function discoverHuggingFaceModels(input: {
  fetcher: typeof fetch;
  maxAssetBytes: number;
  maxRepositories: number;
  requestTimeoutMs: number;
  search: string;
  token: string | undefined;
}): Promise<HuggingFaceModelSearchResult> {
  const searchUrl = new URL("https://huggingface.co/api/models");
  if (input.search.length > 0) {
    searchUrl.searchParams.set("search", input.search);
  }
  searchUrl.searchParams.set("filter", "gguf");
  searchUrl.searchParams.set("sort", "downloads");
  searchUrl.searchParams.set("direction", "-1");
  searchUrl.searchParams.set("limit", String(input.maxRepositories));
  searchUrl.searchParams.set("full", "true");
  searchUrl.searchParams.set("cardData", "true");

  try {
    const response = await input.fetcher(searchUrl, {
      headers: huggingFaceHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) {
      return unavailableResult(input.token, huggingFaceFailureMessage(response.status));
    }

    const repositories = ((await response.json()) as HuggingFaceModelRepository[])
      .filter(isInstallableRepository)
      .slice(0, input.maxRepositories);
    const discovered = await Promise.all(
      repositories.map((repository) =>
        discoverRepositoryModels({
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
        const recommendationDifference = Number(right.recommended) - Number(left.recommended);
        if (recommendationDifference !== 0) return recommendationDifference;
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
          ? `Hugging Face ${connectionLabel(input.token)} connected, but no commercially permitted Android-sized GGUF files matched.`
          : `Hugging Face ${connectionLabel(input.token)} connected. Found ${models.length} installable GGUF ${
              models.length === 1 ? "file" : "files"
            }.`
    };
  } catch {
    return unavailableResult(
      input.token,
      "Hugging Face model discovery is temporarily unavailable."
    );
  }
}

async function discoverRepositoryModels(input: {
  fetcher: typeof fetch;
  maxAssetBytes: number;
  repository: HuggingFaceModelRepository;
  requestTimeoutMs: number;
  token: string | undefined;
}): Promise<HuggingFaceAiModelSummary[]> {
  const repositoryId = repositoryIdFor(input.repository);
  if (repositoryId === null) return [];

  const detailsUrl = new URL(
    `https://huggingface.co/api/models/${repositoryId
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`
  );
  detailsUrl.searchParams.set("blobs", "true");

  try {
    const response = await input.fetcher(detailsUrl, {
      headers: huggingFaceHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) return [];
    const details = (await response.json()) as HuggingFaceModelRepository;
    if (!isInstallableRepository(details)) return [];

    return (details.siblings ?? [])
      .filter((file) => isInstallableGgufFile(file, input.maxAssetBytes))
      .sort(compareGgufFiles)
      .slice(0, 3)
      .map((file) => huggingFaceFileToAiModel(details, file));
  } catch {
    return [];
  }
}

function huggingFaceFileToAiModel(
  repository: HuggingFaceModelRepository,
  file: HuggingFaceRepoFile
): HuggingFaceAiModelSummary {
  const repositoryId = repositoryIdFor(repository)!;
  const fileName = file.rfilename!;
  const fileSizeBytes = fileSize(file)!;
  const repositorySlug = repositoryId.toLowerCase().replace("/", ".");
  const assetSlug = slugify(fileName.replace(/\.gguf$/i, "")).slice(0, 80);
  const modelCardUrl = `https://huggingface.co/${repositoryId}`;
  const capabilities = inferCapabilities(
    `${repositoryId} ${fileName} ${(repository.tags ?? []).join(" ")}`
  );

  return {
    id: `huggingface:${repositorySlug}.${assetSlug}`.slice(0, 180),
    label: humanizeModelLabel(fileName),
    provider: "local",
    description: `${repositoryId} on-device GGUF model from the Hugging Face Hub.`,
    capabilities,
    available: true,
    source: "huggingface",
    format: "GGUF",
    license: "Apache-2.0",
    licenseUrl: safeLicenseUrl(repository.cardData?.license_link, repositoryId),
    modelCardUrl,
    downloadUrl: `${modelCardUrl}/resolve/main/${encodeRepositoryPath(fileName)}?download=true`,
    fileName,
    fileSizeBytes,
    minimumMemoryGb: inferMinimumMemoryGb(fileSizeBytes),
    recommended: /q4[_ .-]?k[_ .-]?m/i.test(fileName) && fileSizeBytes <= 800 * 1024 ** 2,
    // Discovered dynamically from the Hugging Face Hub; its context window is not known without
    // parsing a model card, so it is left undeclared rather than guessed.
    contextWindow: null
  };
}

function isInstallableRepository(repository: HuggingFaceModelRepository): boolean {
  const repositoryId = repositoryIdFor(repository);
  const tags = repository.tags ?? [];
  const license = repository.cardData?.license?.trim().toLowerCase();
  return (
    repositoryId !== null &&
    repository.private !== true &&
    repository.disabled !== true &&
    (repository.gated === false || repository.gated === undefined) &&
    (license === "apache-2.0" || tags.some((tag) => tag.toLowerCase() === "license:apache-2.0"))
  );
}

function repositoryIdFor(repository: HuggingFaceModelRepository): string | null {
  const repositoryId = repository.id ?? repository.modelId;
  return typeof repositoryId === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryId)
    ? repositoryId
    : null;
}

function isInstallableGgufFile(file: HuggingFaceRepoFile, maxAssetBytes: number): boolean {
  const size = fileSize(file);
  return (
    typeof file.rfilename === "string" &&
    file.rfilename.toLowerCase().endsWith(".gguf") &&
    !/(^|[/_.-])(mmproj|tokenizer|imatrix)([/_.-]|$)/i.test(file.rfilename) &&
    size !== null &&
    size >= minimumAssetBytes &&
    size <= maxAssetBytes
  );
}

function fileSize(file: HuggingFaceRepoFile): number | null {
  const size = file.size ?? file.lfs?.size;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

function compareGgufFiles(left: HuggingFaceRepoFile, right: HuggingFaceRepoFile): number {
  const preferenceDifference =
    quantizationPreference(right.rfilename) - quantizationPreference(left.rfilename);
  return preferenceDifference !== 0
    ? preferenceDifference
    : (fileSize(left) ?? 0) - (fileSize(right) ?? 0);
}

function quantizationPreference(fileName: string | undefined): number {
  if (fileName === undefined) return 0;
  if (/q4[_ .-]?k[_ .-]?m/i.test(fileName)) return 4;
  if (/q3[_ .-]?k[_ .-]?m/i.test(fileName)) return 3;
  if (/q5[_ .-]?k[_ .-]?m/i.test(fileName)) return 2;
  return 1;
}

function safeLicenseUrl(value: string | null | undefined, repositoryId: string): string {
  if (value !== null && value !== undefined) {
    try {
      const url = new URL(value);
      if (
        url.protocol === "https:" &&
        url.hostname === "huggingface.co" &&
        url.username.length === 0 &&
        url.password.length === 0
      ) {
        return url.toString();
      }
    } catch {
      // Fall back to the repository license path.
    }
  }
  return `https://huggingface.co/${repositoryId}/blob/main/LICENSE`;
}

function encodeRepositoryPath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function huggingFaceHeaders(token: string | undefined): HeadersInit {
  return {
    accept: "application/json",
    "user-agent": "grogoni-on-device-model-catalog",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function huggingFaceFailureMessage(status: number): string {
  if (status === 401 || status === 403 || status === 429) {
    return "Hugging Face model discovery is rate-limited or unauthorized. Try again later or configure HF_TOKEN.";
  }
  return `Hugging Face model discovery failed (${status}).`;
}

function unavailableResult(
  token: string | undefined,
  message: string
): HuggingFaceModelSearchResult {
  return {
    models: [],
    status: "unavailable",
    connection: token === undefined ? "public" : "authenticated",
    message
  };
}

function normalizeSearch(search: string | undefined): string {
  return (search ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+._ /-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80);
}

function normalizeToken(token: string | undefined): string | undefined {
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
    "hugging-face-hub",
    ...(/qwen|gemma|aya|multilingual/.test(normalized) ? ["multilingual"] : []),
    ...(/instruct|chat|conversational/.test(normalized) ? ["instruction-following"] : []),
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

function cloneSearchResult(result: HuggingFaceModelSearchResult): HuggingFaceModelSearchResult {
  return {
    ...result,
    models: result.models.map((model) => ({
      ...model,
      capabilities: [...model.capabilities]
    }))
  };
}
