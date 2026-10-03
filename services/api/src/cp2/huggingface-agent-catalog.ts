import type { AgentDefinitionId, OssAgentSearchResult, OssAgentSummary } from "@grogoni/shared-types";

export interface HuggingFaceAgentCatalog {
  searchAgents: (search?: string) => Promise<OssAgentSearchResult>;
}

export interface HuggingFaceAgentCatalogOptions {
  cacheTtlMs?: number;
  fetcher?: typeof fetch;
  maxSpaces?: number;
  minimumLikes?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  token?: string;
}

interface HuggingFaceSpace {
  ai_short_description?: string | null;
  id?: string;
  author?: string;
  cardData?: {
    license?: string | null;
    short_description?: string | null;
    suggested_hardware?: string | null;
    title?: string | null;
  } | null;
  disabled?: boolean;
  lastModified?: string | null;
  likes?: number;
  private?: boolean;
  runtime?: {
    hardware?: string | { current?: string | null; requested?: string | null } | null;
    stage?: string | null;
  } | null;
  sdk?: string | null;
  shortDescription?: string | null;
  tags?: string[];
  title?: string | null;
  updatedAt?: string | null;
}

interface SemanticSearchResponse {
  spaces?: HuggingFaceSpace[];
}

interface CachedSearch {
  expiresAt: number;
  result: OssAgentSearchResult;
}

const allowedLicenses = new Set([
  "apache-2.0",
  "mit",
  "bsd-2-clause",
  "bsd-3-clause",
  "isc",
  "mpl-2.0",
  "gpl-2.0",
  "gpl-3.0",
  "agpl-3.0",
  "lgpl-2.1",
  "lgpl-3.0"
]);
const defaultCacheTtlMs = 15 * 60 * 1000;
const failureCacheTtlMs = 60_000;

export function createHuggingFaceAgentCatalog(
  options: HuggingFaceAgentCatalogOptions = {}
): HuggingFaceAgentCatalog {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
  const maxSpaces = Math.min(20, Math.max(1, options.maxSpaces ?? 12));
  const minimumLikes = Math.max(0, options.minimumLikes ?? 10);
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 8_000);
  const token = normalizeToken(options.token);
  const cache = new Map<string, CachedSearch>();

  return {
    async searchAgents(search) {
      const normalizedSearch = normalizeSearch(search);
      const cacheKey = normalizedSearch || "established-ai-agents";
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now()) return cloneResult(cached.result);

      const result = await discoverSpaces({
        fetcher,
        maxSpaces,
        minimumLikes,
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
      return cloneResult(result);
    }
  };
}

export function createHuggingFaceAgentCatalogFromEnvironment(): HuggingFaceAgentCatalog {
  const token = process.env.HF_TOKEN ?? process.env.HUGGINGFACE_TOKEN;
  return createHuggingFaceAgentCatalog({ ...(token === undefined ? {} : { token }) });
}

async function discoverSpaces(input: {
  fetcher: typeof fetch;
  maxSpaces: number;
  minimumLikes: number;
  requestTimeoutMs: number;
  search: string;
  token: string | undefined;
}): Promise<OssAgentSearchResult> {
  const searchUrl = new URL("https://huggingface.co/api/spaces/semantic-search");
  searchUrl.searchParams.set("q", input.search || "AI agent assistant");
  searchUrl.searchParams.set("sdk", "gradio");

  try {
    const response = await input.fetcher(searchUrl, {
      headers: huggingFaceHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) return unavailable(input.token, huggingFaceFailureMessage(response.status));

    const body = (await response.json()) as SemanticSearchResponse | HuggingFaceSpace[];
    const matches = Array.isArray(body) ? body : (body.spaces ?? []);
    const details = await Promise.all(
      matches.slice(0, input.maxSpaces).map((space) =>
        loadSpaceDetails({
          fetcher: input.fetcher,
          requestTimeoutMs: input.requestTimeoutMs,
          space,
          token: input.token
        })
      )
    );
    const agents = details
      .filter((space): space is HuggingFaceSpace => space !== null)
      .filter((space) => isEstablishedAgentSpace(space, input.minimumLikes))
      .map(spaceToAgent)
      .sort((left, right) => right.popularity - left.popularity)
      .slice(0, input.maxSpaces);

    return {
      agents,
      status: "available",
      connection: input.token === undefined ? "public" : "authenticated",
      message:
        agents.length === 0
          ? "Hugging Face connected, but no established Gradio agent Spaces matched."
          : `Hugging Face connected. Found ${agents.length} public agent ${agents.length === 1 ? "Space" : "Spaces"}; only entries with verified OSS licenses can be selected.`
    };
  } catch {
    return unavailable(input.token, "Hugging Face agent discovery is temporarily unavailable.");
  }
}

async function loadSpaceDetails(input: {
  fetcher: typeof fetch;
  requestTimeoutMs: number;
  space: HuggingFaceSpace;
  token: string | undefined;
}): Promise<HuggingFaceSpace | null> {
  if (!isRepositoryId(input.space.id)) return null;
  const detailsUrl = new URL(
    `https://huggingface.co/api/spaces/${input.space
      .id!.split("/")
      .map(encodeURIComponent)
      .join("/")}`
  );
  try {
    const response = await input.fetcher(detailsUrl, {
      headers: huggingFaceHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) return null;
    return { ...input.space, ...((await response.json()) as HuggingFaceSpace) };
  } catch {
    return null;
  }
}

function isEstablishedAgentSpace(space: HuggingFaceSpace, minimumLikes: number): boolean {
  return (
    isRepositoryId(space.id) &&
    space.private !== true &&
    space.disabled !== true &&
    space.sdk === "gradio" &&
    looksLikeOperationalAgent(space) &&
    (space.likes ?? 0) >= minimumLikes
  );
}

function looksLikeOperationalAgent(space: HuggingFaceSpace): boolean {
  const title = `${space.cardData?.title ?? ""} ${space.title ?? ""}`;
  const description = `${space.cardData?.short_description ?? ""} ${space.shortDescription ?? ""} ${space.ai_short_description ?? ""}`;
  const value = `${title} ${description}`.toLowerCase();
  return /\bagents?\b/.test(value) && !/\b(?:benchmark|inspector|leaderboard|quiz)\b/.test(value);
}

function spaceToAgent(space: HuggingFaceSpace): OssAgentSummary {
  const sourceId = space.id!;
  const sourceUrl = `https://huggingface.co/spaces/${sourceId}`;
  const hardware = readHardware(space);
  const requiresGpu = !/^cpu(?:-|$)/i.test(hardware) && hardware !== "none";
  const license = readLicense(space);
  return {
    id: `huggingface:${sourceId.toLowerCase()}` as AgentDefinitionId,
    label:
      space.cardData?.title?.trim() || space.title?.trim() || sourceId.split("/")[1] || sourceId,
    description:
      space.cardData?.short_description?.trim() ||
      space.shortDescription?.trim() ||
      space.ai_short_description?.trim() ||
      `${sourceId} public agent Space.`,
    source: "huggingface",
    sourceId,
    sourceUrl,
    license,
    licenseUrl: `${sourceUrl}/blob/main/LICENSE`,
    licenseVerified: allowedLicenses.has(license.toLowerCase()),
    runtime: "gradio",
    executionMode: "hosted-api",
    minimumDeviceTier: "low",
    minimumMemoryGb: 2,
    requiresGpu,
    popularity: space.likes ?? 0,
    capabilities: [...new Set(["open-source", "agent", "hosted-api", ...(space.tags ?? [])])].slice(
      0,
      12
    ),
    updatedAt: normalizeTimestamp(space.updatedAt ?? space.lastModified)
  };
}

function readHardware(space: HuggingFaceSpace): string {
  const runtimeHardware = space.runtime?.hardware;
  if (typeof runtimeHardware === "string") return runtimeHardware;
  if (runtimeHardware !== null && runtimeHardware !== undefined) {
    return runtimeHardware.current ?? runtimeHardware.requested ?? "cpu-basic";
  }
  return space.cardData?.suggested_hardware ?? "cpu-basic";
}

function readLicense(space: HuggingFaceSpace): string {
  const cardLicense = space.cardData?.license?.trim();
  if (cardLicense) return cardLicense;
  const licenseTag = (space.tags ?? []).find((tag) => tag.toLowerCase().startsWith("license:"));
  return licenseTag?.slice("license:".length) ?? "unknown";
}

function isRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeSearch(search: string | undefined): string {
  return (search ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+._ /-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80);
}

function huggingFaceHeaders(token: string | undefined): HeadersInit {
  return {
    accept: "application/json",
    "user-agent": "grogoni-oss-agent-catalog",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function huggingFaceFailureMessage(status: number): string {
  return status === 401 || status === 403 || status === 429
    ? "Hugging Face agent discovery is rate-limited or unauthorized. Try again later or configure HF_TOKEN."
    : `Hugging Face agent discovery failed (${status}).`;
}

function unavailable(token: string | undefined, message: string): OssAgentSearchResult {
  return {
    agents: [],
    status: "unavailable",
    connection: token === undefined ? "public" : "authenticated",
    message
  };
}

function normalizeToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token === undefined || token.length === 0 ? undefined : token;
}

function cloneResult(result: OssAgentSearchResult): OssAgentSearchResult {
  return {
    ...result,
    agents: result.agents.map((agent) => ({ ...agent, capabilities: [...agent.capabilities] }))
  };
}
