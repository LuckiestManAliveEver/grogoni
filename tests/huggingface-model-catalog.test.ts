import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createHuggingFaceModelCatalog } from "../services/api/src/cp2/huggingface-model-catalog";

describe("Hugging Face on-device model catalog", () => {
  it("discovers Apache-2.0 phone-sized GGUF files and caches searches", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        expect(init?.headers).not.toHaveProperty("authorization");

        if (url.pathname === "/api/models" && url.hostname === "huggingface.co") {
          expect(url.searchParams.get("search")).toBe("qwen mobile");
          expect(url.searchParams.get("filter")).toBe("gguf");
          expect(url.searchParams.get("sort")).toBe("downloads");
          expect(url.searchParams.get("full")).toBe("true");
          expect(url.searchParams.get("cardData")).toBe("true");
          return Response.json([
            {
              id: "example/mobile-gguf",
              private: false,
              gated: false,
              disabled: false,
              tags: ["gguf", "license:apache-2.0", "conversational"],
              cardData: { license: "apache-2.0" }
            },
            {
              id: "example/wrong-license",
              private: false,
              gated: false,
              tags: ["gguf", "license:mit"],
              cardData: { license: "mit" }
            }
          ]);
        }

        if (url.pathname === "/api/models/example/mobile-gguf") {
          expect(url.searchParams.get("blobs")).toBe("true");
          return Response.json({
            id: "example/mobile-gguf",
            private: false,
            gated: false,
            disabled: false,
            tags: ["gguf", "license:apache-2.0", "qwen", "conversational"],
            cardData: {
              license: "apache-2.0",
              license_link: "https://huggingface.co/example/mobile-gguf/blob/main/LICENSE"
            },
            siblings: [
              {
                rfilename: "qwen-mobile-instruct-q4_k_m.gguf",
                lfs: { size: 420 * 1024 ** 2 }
              },
              {
                rfilename: "qwen-mobile-mmproj.gguf",
                lfs: { size: 120 * 1024 ** 2 }
              },
              {
                rfilename: "qwen-mobile-f16.gguf",
                lfs: { size: 3 * 1024 ** 3 }
              }
            ]
          });
        }

        return new Response(null, { status: 404 });
      }
    );
    const catalog = createHuggingFaceModelCatalog({
      fetcher: fetcher as typeof fetch,
      now: () => 1_000
    });

    const first = await catalog.searchModels("Qwen mobile");
    const second = await catalog.searchModels("Qwen mobile");

    expect(first).toMatchObject({
      status: "available",
      connection: "public",
      models: [
        {
          id: expect.stringMatching(/^huggingface:example\.mobile-gguf\./),
          source: "huggingface",
          format: "GGUF",
          license: "Apache-2.0",
          minimumMemoryGb: 2,
          recommended: true
        }
      ]
    });
    expect(first.models[0]?.downloadUrl).toBe(
      "https://huggingface.co/example/mobile-gguf/resolve/main/qwen-mobile-instruct-q4_k_m.gguf?download=true"
    );
    expect(first.models[0]?.capabilities).toEqual(
      expect.arrayContaining(["offline", "hugging-face-hub", "multilingual"])
    );
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses authenticated Hub requests when HF_TOKEN is configured", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        expect(init?.headers).toMatchObject({ authorization: "Bearer hf-test-token" });
        return Response.json([]);
      }
    );
    const catalog = createHuggingFaceModelCatalog({
      fetcher: fetcher as typeof fetch,
      token: "  hf-test-token  "
    });

    const result = await catalog.searchModels("smollm");

    expect(result).toMatchObject({
      status: "available",
      connection: "authenticated",
      message: expect.stringContaining("Hugging Face authenticated API connected")
    });
  });

  it("no longer exposes Hugging Face discovery through the API", async () => {
    // Hosted model discovery routes were removed with the local-first runtime
    // (docs/local-first-cloud-audit.md); the catalog client above remains unit-tested only.
    const app = buildApi();
    const response = await app.inject({
      method: "GET",
      url: "/v1/ai-models/huggingface?search=smol"
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
