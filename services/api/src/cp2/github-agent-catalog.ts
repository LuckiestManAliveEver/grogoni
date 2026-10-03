import type {
  AgentDefinitionId,
  OssAgentSearchResult,
  OssAgentSummary,
  OssAgentRuntime
} from "@grogoni/shared-types";

export interface GitHubAgentCatalog {
  searchAgents: (search?: string) => Promise<OssAgentSearchResult>;
}

export interface GitHubAgentCatalogOptions {
  cacheTtlMs?: number;
  fetcher?: typeof fetch;
  maxRepositories?: number;
  minimumStars?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  token?: string;
}

interface GitHubRepositorySearchResponse {
  items?: GitHubAgentRepository[];
}

interface GitHubAgentRepository {
  archived?: boolean;
  default_branch?: string;
  description?: string | null;
  disabled?: boolean;
  fork?: boolean;
  full_name?: string;
  html_url?: string;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
  pushed_at?: string | null;
  stargazers_count?: number;
  topics?: string[];
}

interface CachedSearch {
  expiresAt: number;
  result: OssAgentSearchResult;
}

const allowedLicenses = new Set([
  "Apache-2.0",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0"
]);
const defaultCacheTtlMs = 15 * 60 * 1000;
const failureCacheTtlMs = 60_000;

export function createGitHubAgentCatalog(
  options: GitHubAgentCatalogOptions = {}
): GitHubAgentCatalog {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
  const maxRepositories = Math.min(20, Math.max(1, options.maxRepositories ?? 12));
  const minimumStars = Math.max(0, options.minimumStars ?? 100);
  const requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 8_000);
  const token = normalizeToken(options.token);
  const cache = new Map<string, CachedSearch>();

  return {
    async searchAgents(search) {
      const normalizedSearch = normalizeSearch(search);
      const cacheKey = normalizedSearch || "established-ai-agents";
      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now()) return cloneResult(cached.result);

      const result = await discoverGitHubAgents({
        fetcher,
        maxRepositories,
        minimumStars,
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

export function createGitHubAgentCatalogFromEnvironment(): GitHubAgentCatalog {
  return createGitHubAgentCatalog({
    ...(process.env.GITHUB_TOKEN === undefined ? {} : { token: process.env.GITHUB_TOKEN })
  });
}

async function discoverGitHubAgents(input: {
  fetcher: typeof fetch;
  maxRepositories: number;
  minimumStars: number;
  requestTimeoutMs: number;
  search: string;
  token: string | undefined;
}): Promise<OssAgentSearchResult> {
  const terms = input.search;
  const searchUrl = new URL("https://api.github.com/search/repositories");
  searchUrl.searchParams.set(
    "q",
    `${terms.length > 0 ? `${terms} ` : ""}topic:ai-agents archived:false fork:false stars:>=${input.minimumStars}`
  );
  searchUrl.searchParams.set("sort", "stars");
  searchUrl.searchParams.set("order", "desc");
  searchUrl.searchParams.set("per_page", String(input.maxRepositories));

  try {
    const response = await input.fetcher(searchUrl, {
      headers: githubHeaders(input.token),
      signal: AbortSignal.timeout(input.requestTimeoutMs)
    });
    if (!response.ok) return unavailable(input.token, githubFailureMessage(response.status));

    const body = (await response.json()) as GitHubRepositorySearchResponse;
    const agents = (body.items ?? [])
      .filter((repository) => isOpenSourceAgentRepository(repository, input.minimumStars))
      .map(repositoryToAgent)
      .slice(0, input.maxRepositories);

    return {
      agents,
      status: "available",
      connection: input.token === undefined ? "public" : "authenticated",
      message:
        agents.length === 0
          ? "GitHub connected, but no established, licensed agent repositories matched."
          : `GitHub connected. Found ${agents.length} established open-source agent ${agents.length === 1 ? "repository" : "repositories"}.`
    };
  } catch {
    return unavailable(input.token, "GitHub agent discovery is temporarily unavailable.");
  }
}

function isOpenSourceAgentRepository(
  repository: GitHubAgentRepository,
  minimumStars: number
): boolean {
  return (
    repository.archived !== true &&
    repository.disabled !== true &&
    repository.fork !== true &&
    typeof repository.full_name === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) &&
    typeof repository.html_url === "string" &&
    allowedLicenses.has(repository.license?.spdx_id ?? "") &&
    (repository.stargazers_count ?? 0) >= minimumStars
  );
}

function repositoryToAgent(repository: GitHubAgentRepository): OssAgentSummary {
  const sourceId = repository.full_name!;
  const sourceUrl = repository.html_url!;
  const license = repository.license!.spdx_id!;
  const runtime = inferRuntime(repository.language, repository.topics);
  const text = `${repository.description ?? ""} ${(repository.topics ?? []).join(" ")}`;
  const requiresGpu = /\b(?:cuda|gpu|vllm)\b/i.test(text);
  const minimumMemoryGb = requiresGpu
    ? 8
    : runtime === "javascript" || runtime === "typescript"
      ? 4
      : 6;

  return {
    id: `github:${sourceId.toLowerCase()}` as AgentDefinitionId,
    label: sourceId.split("/")[1] ?? sourceId,
    description: repository.description?.trim() || `${sourceId} open-source agent project.`,
    source: "github",
    sourceId,
    sourceUrl,
    license,
    licenseUrl: `${sourceUrl}/blob/${repository.default_branch || "main"}/LICENSE`,
    licenseVerified: true,
    runtime,
    executionMode: "backend-adapter",
    minimumDeviceTier: requiresGpu ? "high" : "medium",
    minimumMemoryGb,
    requiresGpu,
    popularity: repository.stargazers_count ?? 0,
    capabilities: [...new Set(["open-source", "agent", ...(repository.topics ?? [])])].slice(0, 12),
    updatedAt: normalizeTimestamp(repository.pushed_at)
  };
}

function inferRuntime(
  language: string | null | undefined,
  topics: string[] | undefined
): OssAgentRuntime {
  const value = `${language ?? ""} ${(topics ?? []).join(" ")}`.toLowerCase();
  if (value.includes("typescript")) return "typescript";
  if (value.includes("javascript") || value.includes("nodejs")) return "javascript";
  if (value.includes("python")) return "python";
  if (value.includes("docker")) return "docker";
  return "unknown";
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeSearch(search: string | undefined): string {
  return (search ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+._ -]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .slice(0, 80);
}

function githubHeaders(token: string | undefined): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "grogoni-oss-agent-catalog",
    "x-github-api-version": "2022-11-28",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
  };
}

function githubFailureMessage(status: number): string {
  return status === 403 || status === 429
    ? "GitHub agent discovery is rate-limited. Try again later or configure GITHUB_TOKEN."
    : `GitHub agent discovery failed (${status}).`;
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
