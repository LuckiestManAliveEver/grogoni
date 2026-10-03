import { describe, expect, it } from "vitest";

import {
  portableAgentManifestFromOssAgent,
  validatePortableAgentManifest,
  type OssAgentSummary,
  type PortableAgentManifest
} from "../packages/shared-types/src";
import { GrogoniManifestAgentImporter } from "../services/api/src/cp2/domains/agent-runtime/portable-agent-importer";
import { hydrateAccountAgentManifest } from "../services/api/src/cp2/account-ai-asset-store";

const manifest: PortableAgentManifest = {
  schemaVersion: "1",
  agent: {
    id: "portable:shop-assistant",
    name: "Shop Assistant",
    description: "A portable commerce assistant.",
    version: "1.0.0"
  },
  instructions: {
    system: "Help the shop owner using only authorized Grogoni tools.",
    files: ["context/catalogue.md"]
  },
  capabilities: ["conversation", "commerce"],
  tools: [{ name: "products.list", required: false }],
  modelRequirements: {
    requiredCapabilities: ["chat", "tool-routing"],
    minimumContextWindow: 8_192,
    localAllowed: true,
    hostedAllowed: true
  },
  executionRequirements: {
    preferredTargets: ["remote-shop-device", "backend"],
    requiresNetwork: false,
    requiresFilesystem: false,
    requiresNativeBridge: false
  },
  memory: { scope: "shop" },
  permissions: {
    toolApproval: "writes",
    network: "restricted",
    filesystem: "sandboxed"
  }
};

const discoveredAgent: OssAgentSummary = {
  id: "huggingface:example/retail-agent",
  label: "Retail Agent",
  description: "A bounded retail assistant.",
  source: "huggingface",
  sourceId: "example/retail-agent",
  sourceUrl: "https://huggingface.co/spaces/example/retail-agent",
  license: "apache-2.0",
  licenseUrl: "https://huggingface.co/spaces/example/retail-agent/blob/main/LICENSE",
  licenseVerified: true,
  runtime: "python",
  executionMode: "hosted-api",
  minimumDeviceTier: "low",
  minimumMemoryGb: 2,
  requiresGpu: false,
  popularity: 12,
  capabilities: ["commerce", "conversation"],
  updatedAt: "2026-08-29T00:00:00.000Z"
};

describe("portable Grogoni agent manifests", () => {
  it("validates a provider- and device-independent manifest", () => {
    expect(validatePortableAgentManifest(manifest)).toEqual({
      valid: true,
      manifest,
      issues: []
    });
  });

  it("rejects executable/device paths, credentials, and an unusable execution policy", () => {
    const invalid = {
      ...manifest,
      instructions: { files: ["/data/local/agent.py"] },
      modelRequirements: { localAllowed: false, hostedAllowed: false },
      metadata: { command: "python agent.py", apiKey: "secret" }
    };
    const result = validatePortableAgentManifest(invalid);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("Expected validation failure");
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "$.instructions.files[0]",
        "$.modelRequirements",
        "$.metadata.command",
        "$.metadata.apiKey"
      ])
    );
  });

  it("imports the canonical Grogoni manifest through the adapter boundary", async () => {
    const importer = new GrogoniManifestAgentImporter();
    await expect(importer.inspect({ kind: "grogoni-manifest", manifest })).resolves.toMatchObject({
      supported: true,
      valid: true,
      agentId: "portable:shop-assistant"
    });
    await expect(importer.convert({ kind: "grogoni-manifest", manifest })).resolves.toEqual(manifest);
  });

  it("converts OSS discovery metadata into a declarative portable definition", () => {
    const converted = portableAgentManifestFromOssAgent(discoveredAgent);
    expect(converted).toMatchObject({
      agent: { id: discoveredAgent.id },
      modelRequirements: { hostedAllowed: true, localAllowed: true },
      executionRequirements: { requiresNativeBridge: false }
    });
    expect(JSON.stringify(converted)).not.toContain("python agent.py");
    expect(validatePortableAgentManifest(converted).valid).toBe(true);
  });

  it("derives a portable manifest for a legacy Postgres row saved before this field existed", () => {
    const legacyRow = {
      manifestVersion: 1 as const,
      accountId: "account-1",
      userId: "user-1",
      agent: discoveredAgent,
      installedAt: "2026-01-01T00:00:00.000Z"
    };
    const hydrated = hydrateAccountAgentManifest(legacyRow);
    expect(hydrated.portableManifest).toEqual(portableAgentManifestFromOssAgent(discoveredAgent));
    expect(validatePortableAgentManifest(hydrated.portableManifest).valid).toBe(true);
  });

  it("falls back to a derived manifest when a stored portableManifest is corrupted", () => {
    const corruptedRow = {
      manifestVersion: 1 as const,
      accountId: "account-1",
      userId: "user-1",
      agent: discoveredAgent,
      installedAt: "2026-01-01T00:00:00.000Z",
      portableManifest: { schemaVersion: "1", agent: { id: "not-an-object" } }
    };
    const hydrated = hydrateAccountAgentManifest(corruptedRow);
    expect(hydrated.portableManifest).toEqual(portableAgentManifestFromOssAgent(discoveredAgent));
  });
});
