import { describe, expect, it } from "vitest";
import type { InstalledAgentModelSummary, OssAgentSummary } from "../packages/shared-types/src";
import { createCp2Store } from "../services/api/src/cp2/store";

const agent: OssAgentSummary = {
  id: "huggingface:example/retail-agent",
  label: "Retail Agent",
  description: "A bounded retail assistant.",
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
  updatedAt: "2026-08-01T00:00:00.000Z"
};

function model(): Omit<InstalledAgentModelSummary, "accountId" | "userId"> {
  return {
    id: "device-a-installation",
    deviceId: "device-a",
    modelId: "custom:tiny-test",
    displayName: "Tiny Test",
    provider: "custom",
    repositoryId: null,
    filename: "tiny.gguf",
    format: "GGUF",
    quantization: "Q4_K_M",
    architecture: "llama",
    parameterCount: 1_000_000,
    contextLength: 2_048,
    fileSizeBytes: 8,
    checksum: null,
    license: "User-confirmed commercial license",
    commercialUseAllowed: true,
    storageKey: "tiny.gguf",
    runtimeBackend: "LLAMA_CPP_BROWSER",
    installationStatus: "INSTALLED",
    compatibilityStatus: "COMPATIBLE",
    installedAt: "2026-08-28T10:00:00.000Z",
    lastVerifiedAt: "2026-08-28T10:00:00.000Z",
    validationError: null
  };
}

describe("account-scoped AI assets", () => {
  it("makes an agent manifest and completed model artifact available to another session", async () => {
    const store = createCp2Store();
    const first = store.signupWithPhonePin({ destination: "+254700880001", pin: "7306" });

    await store.installAccountOssAgentManifest({ sessionId: first.session.id, agent });
    const artifact = await store.beginAccountModelArtifact({
      sessionId: first.session.id,
      model: model()
    });
    await store.putAccountModelArtifactChunk({
      sessionId: first.session.id,
      artifactId: artifact.id,
      chunkIndex: 0,
      bytes: Buffer.from("GGUFtest")
    });
    await store.completeAccountModelArtifact({
      sessionId: first.session.id,
      artifactId: artifact.id
    });

    const second = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254700880001",
      pin: "7306"
    });
    expect(await store.listAccountOssAgentManifests({ sessionId: second.session.id })).toEqual([
      expect.objectContaining({
        agent: expect.objectContaining({ id: agent.id }),
        portableManifest: expect.objectContaining({
          schemaVersion: "1",
          agent: expect.objectContaining({ id: agent.id }),
          modelRequirements: expect.objectContaining({ hostedAllowed: true, localAllowed: true })
        })
      })
    ]);
    expect(await store.listAccountModelArtifacts({ sessionId: second.session.id })).toEqual([
      expect.objectContaining({ id: artifact.id, modelId: "custom:tiny-test", status: "READY" })
    ]);
    await expect(
      store.getAccountModelArtifactChunk({
        sessionId: second.session.id,
        artifactId: artifact.id,
        chunkIndex: 0
      })
    ).resolves.toEqual(Buffer.from("GGUFtest"));
  });

  it("does not expose account assets to a different account", async () => {
    const store = createCp2Store();
    const owner = store.signupWithPhonePin({ destination: "+254700880002", pin: "7306" });
    const other = store.signupWithPhonePin({ destination: "+254700880003", pin: "7306" });
    await store.installAccountOssAgentManifest({ sessionId: owner.session.id, agent });

    await expect(
      store.listAccountOssAgentManifests({ sessionId: other.session.id })
    ).resolves.toEqual([]);
    await expect(store.listAccountModelArtifacts({ sessionId: other.session.id })).resolves.toEqual(
      []
    );
  });
});
