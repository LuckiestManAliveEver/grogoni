// @vitest-environment jsdom
//
// Regression: hydrateAccountOssAgentManifests cached each saved manifest in a loop, and the
// first one that failed the install safety check threw out of it. Both callers swallow the error
// with .catch(() => []), so one bad saved agent hid every saved agent on the account.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiHelpers from "../apps/web/src/api-helpers";

vi.mock("../apps/web/src/api-helpers", async () => {
  const actual = await vi.importActual<typeof ApiHelpers>("../apps/web/src/api-helpers");
  return { ...actual, getJson: vi.fn() };
});

const { getJson } = await import("../apps/web/src/api-helpers");
const { hydrateAccountOssAgentManifests } = await import("../apps/web/src/account-ai-assets");
const { listInstalledOssAgentManifests } = await import("../apps/web/src/oss-agent-installation");

const validAgent = {
  id: "huggingface:example/retail-agent",
  label: "Retail Agent",
  description: "A licensed retail assistant Space.",
  source: "huggingface",
  sourceId: "example/retail-agent",
  sourceUrl: "https://huggingface.co/spaces/example/retail-agent",
  license: "apache-2.0",
  licenseUrl: "https://huggingface.co/spaces/example/retail-agent/blob/main/LICENSE",
  licenseVerified: true,
  runtime: "gradio",
  executionMode: "hosted-api",
  minimumDeviceTier: "low",
  minimumMemoryGb: 2,
  requiresGpu: false,
  popularity: 120,
  capabilities: ["agent", "retail"],
  updatedAt: "2026-07-15T00:00:00.000Z"
};

function manifest(agent: unknown) {
  return {
    manifestVersion: 1,
    accountId: "account-1",
    userId: "user-1",
    agent,
    installedAt: "2026-07-15T00:00:00.000Z"
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getJson).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("hydrateAccountOssAgentManifests", () => {
  it("skips a manifest that fails the install check and keeps the valid ones", async () => {
    const unlicensed = {
      ...validAgent,
      id: "github:example/unlicensed-agent",
      label: "Unlicensed Agent",
      source: "github",
      sourceId: "example/unlicensed-agent",
      sourceUrl: "https://github.com/example/unlicensed-agent",
      licenseVerified: false
    };
    vi.mocked(getJson).mockResolvedValue({
      manifests: [manifest(unlicensed), manifest(validAgent)]
    });

    const usable = await hydrateAccountOssAgentManifests();

    expect(usable.map((item) => item.agent.id)).toEqual([validAgent.id]);
    expect(listInstalledOssAgentManifests().map((item) => item.agent.id)).toEqual([validAgent.id]);
    expect(console.warn).toHaveBeenCalledWith(
      "Skipped a saved agent manifest that failed the install check.",
      expect.objectContaining({ agentId: unlicensed.id })
    );
  });

  it("drops a manifest whose source link is not https, so it never renders as a link", async () => {
    const unsafeLink = { ...validAgent, sourceUrl: "javascript:alert(1)" };
    vi.mocked(getJson).mockResolvedValue({ manifests: [manifest(unsafeLink)] });

    await expect(hydrateAccountOssAgentManifests()).resolves.toEqual([]);
  });

  it("returns every manifest when all are valid", async () => {
    const second = {
      ...validAgent,
      id: "huggingface:example/second-agent",
      sourceId: "example/second-agent",
      sourceUrl: "https://huggingface.co/spaces/example/second-agent"
    };
    vi.mocked(getJson).mockResolvedValue({
      manifests: [manifest(validAgent), manifest(second)]
    });

    const usable = await hydrateAccountOssAgentManifests();
    expect(usable).toHaveLength(2);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
