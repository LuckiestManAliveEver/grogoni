import { describe, expect, it } from "vitest";
import { shouldInitializeOllama } from "../services/api/src/config.js";

describe("hosted provider startup", () => {
  it("skips an unconfigured local provider for hosted production inference", () => {
    expect(shouldInitializeOllama("backend", { NODE_ENV: "production" })).toBe(false);
    expect(shouldInitializeOllama("vercel", { NODE_ENV: "production" })).toBe(false);
  });

  it("keeps local defaults, development and explicitly configured local providers", () => {
    expect(shouldInitializeOllama("local", { NODE_ENV: "production" })).toBe(true);
    expect(shouldInitializeOllama("backend", { NODE_ENV: "development" })).toBe(true);
    expect(
      shouldInitializeOllama("backend", {
        NODE_ENV: "production",
        OLLAMA_BASE_URL: "https://ollama.example.com"
      })
    ).toBe(true);
  });
});
