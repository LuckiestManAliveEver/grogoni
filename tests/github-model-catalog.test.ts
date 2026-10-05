import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createGitHubModelCatalog } from "../services/api/src/cp2/github-model-catalog";

describe("GitHub on-device model catalog", () => {
  it("discovers only Apache-2.0 Android-sized GGUF release assets and caches searches", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({
          items: [
            {
              full_name: "example/android-gguf",
              html_url: "https://github.com/example/android-gguf",
              default_branch: "main",
              description: "Compact multilingual model",
              license: { spdx_id: "Apache-2.0" }
            },
            {
              full_name: "example/wrong-license",
              html_url: "https://github.com/example/wrong-license",
              default_branch: "main",
              description: "Not commercially allowlisted",
              license: { spdx_id: "GPL-3.0" }
            }
          ]
        });
      }
      if (url === "https://api.github.com/repos/example/android-gguf/releases?per_page=5") {
        return Response.json([
          {
            name: "v1",
            tag_name: "v1",
            html_url: "https://github.com/example/android-gguf/releases/tag/v1",
            draft: false,
            prerelease: false,
            assets: [
              {
                name: "qwen-mini-instruct-q4_k_m.gguf",
                size: 420 * 1024 ** 2,
                state: "uploaded",
                browser_download_url:
                  "https://github.com/example/android-gguf/releases/download/v1/qwen-mini-instruct-q4_k_m.gguf"
              },
              {
                name: "readme.txt",
                size: 1000,
                state: "uploaded",
                browser_download_url:
                  "https://github.com/example/android-gguf/releases/download/v1/readme.txt"
              },
              {
                name: "oversized.gguf",
                size: 3 * 1024 ** 3,
                state: "uploaded",
                browser_download_url:
                  "https://github.com/example/android-gguf/releases/download/v1/oversized.gguf"
              }
            ]
          }
        ]);
      }
      return new Response(null, { status: 404 });
    });
    const catalog = createGitHubModelCatalog({
      fetcher: fetcher as typeof fetch,
      now: () => 1_000
    });

    const first = await catalog.searchModels("qwen android");
    const second = await catalog.searchModels("qwen android");

    expect(first).toMatchObject({
      status: "available",
      connection: "public",
      models: [
        {
          id: expect.stringMatching(/^github:example\.android-gguf\./),
          source: "github",
          format: "GGUF",
          license: "Apache-2.0",
          minimumMemoryGb: 2,
          recommended: true
        }
      ]
    });
    expect(first.models[0]?.downloadUrl).toContain("/releases/download/v1/");
    expect(first.models[0]?.capabilities).toEqual(
      expect.arrayContaining(["offline", "multilingual", "instruction-following"])
    );
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses authenticated GitHub REST requests when a token is configured", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(init?.headers).toMatchObject({ authorization: "Bearer github-test-token" });
        return Response.json({ items: [] });
      }
    );
    const catalog = createGitHubModelCatalog({
      fetcher: fetcher as typeof fetch,
      token: "  github-test-token  "
    });

    const result = await catalog.searchModels("tinyllama");

    expect(result).toMatchObject({
      status: "available",
      connection: "authenticated",
      message: expect.stringContaining("GitHub authenticated API connected")
    });
  });

  it("treats an empty token as public GitHub API access", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(init?.headers).not.toHaveProperty("authorization");
        return Response.json({ items: [] });
      }
    );
    const catalog = createGitHubModelCatalog({
      fetcher: fetcher as typeof fetch,
      token: "   "
    });

    const result = await catalog.searchModels();

    expect(result).toMatchObject({
      status: "available",
      connection: "public",
      message: expect.stringContaining("GitHub public API connected")
    });
  });

  it("no longer exposes GitHub discovery through the API", async () => {
    // Hosted model discovery routes were removed with the local-first runtime
    // (docs/local-first-cloud-audit.md); the catalog client above remains unit-tested only.
    const app = buildApi();
    const response = await app.inject({ method: "GET", url: "/v1/ai-models/github?search=smol" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("publishes Android TinyLlama downloads and the configured llama.cpp option", async () => {
    const app = buildApi();
    const tinyLlama = await app.inject({
      method: "GET",
      url: "/v1/ai-models?search=tinyllama"
    });
    const configured = await app.inject({
      method: "GET",
      url: "/v1/ai-models?search=llama.cpp"
    });

    expect(tinyLlama.statusCode).toBe(200);
    expect(tinyLlama.json().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tinyllama-1.1b-chat-q3-k-m-android",
          source: "huggingface",
          format: "GGUF",
          license: "Apache-2.0"
        }),
        expect.objectContaining({
          id: "tinyllama-1.1b-chat-q4-k-m-android",
          recommended: true,
          fileSizeBytes: 669_000_000
        })
      ])
    );
    expect(configured.statusCode).toBe(200);
    expect(configured.json().models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "llama-cpp-configured",
          source: "builtin",
          format: "remote",
          available: false
        })
      ])
    );

    await app.close();
  });
});
