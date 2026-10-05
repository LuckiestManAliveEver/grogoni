import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createGitHubAgentCatalog } from "../services/api/src/cp2/github-agent-catalog";
import { createHuggingFaceAgentCatalog } from "../services/api/src/cp2/huggingface-agent-catalog";

describe("OSS agent discovery", () => {
  it("discovers established licensed GitHub agent repositories and caches searches", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/search/repositories");
      expect(url.searchParams.get("q")).toContain("retail agent topic:ai-agents");
      expect(url.searchParams.get("sort")).toBe("stars");
      return Response.json({
        items: [
          {
            full_name: "example/retail-agent",
            html_url: "https://github.com/example/retail-agent",
            default_branch: "main",
            description: "A Python retail agent framework",
            license: { spdx_id: "MIT" },
            language: "Python",
            stargazers_count: 4_200,
            topics: ["ai-agents", "retail"],
            pushed_at: "2026-08-01T00:00:00.000Z",
            archived: false,
            fork: false
          },
          {
            full_name: "example/unlicensed-agent",
            html_url: "https://github.com/example/unlicensed-agent",
            license: null,
            stargazers_count: 99_000
          }
        ]
      });
    });
    const catalog = createGitHubAgentCatalog({ fetcher: fetcher as typeof fetch, now: () => 1 });

    const first = await catalog.searchAgents("Retail agent");
    const second = await catalog.searchAgents("Retail agent");

    expect(first).toMatchObject({
      status: "available",
      agents: [
        {
          id: "github:example/retail-agent",
          source: "github",
          license: "MIT",
          runtime: "python",
          executionMode: "backend-adapter",
          popularity: 4_200
        }
      ]
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("discovers only licensed callable Hugging Face Gradio Spaces", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/api/spaces/semantic-search") {
        expect(url.searchParams.get("q")).toBe("shop assistant");
        expect(url.searchParams.get("sdk")).toBe("gradio");
        return Response.json({
          spaces: [{ id: "example/shop-agent" }, { id: "example/private-agent" }]
        });
      }
      if (url.pathname === "/api/spaces/example/shop-agent") {
        return Response.json({
          id: "example/shop-agent",
          private: false,
          disabled: false,
          likes: 320,
          sdk: "gradio",
          tags: ["agent", "license:apache-2.0"],
          cardData: {
            license: "apache-2.0",
            title: "Shop Agent",
            short_description: "A callable shop assistant.",
            suggested_hardware: "t4-small"
          },
          runtime: { hardware: "t4-small", stage: "RUNNING" }
        });
      }
      if (url.pathname === "/api/spaces/example/private-agent") {
        return Response.json({
          id: "example/private-agent",
          private: true,
          likes: 9_000,
          sdk: "gradio",
          cardData: { license: "mit" }
        });
      }
      return new Response(null, { status: 404 });
    });
    const catalog = createHuggingFaceAgentCatalog({ fetcher: fetcher as typeof fetch });

    const result = await catalog.searchAgents("Shop assistant");

    expect(result).toMatchObject({
      status: "available",
      agents: [
        {
          id: "huggingface:example/shop-agent",
          label: "Shop Agent",
          executionMode: "hosted-api",
          requiresGpu: true,
          popularity: 320
        }
      ]
    });
  });

  it("no longer exposes hosted discovery routes", async () => {
    // GitHub and Hugging Face discovery routes were removed with the local-first runtime
    // (docs/local-first-cloud-audit.md); the catalog adapters above remain unit-tested only.
    const app = buildApi();
    for (const url of [
      "/v1/oss-agents/github?search=retail",
      "/v1/oss-agents/huggingface?search=retail"
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });
});
