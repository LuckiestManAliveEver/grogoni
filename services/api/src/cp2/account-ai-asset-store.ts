import { randomUUID } from "node:crypto";
import type {
  CloudModelArtifactSummary,
  InstalledAgentModelSummary,
  InstalledOssAgentManifestSummary,
  OssAgentSummary
} from "@grogoni/shared-types";
import {
  portableAgentManifestFromOssAgent,
  validatePortableAgentManifest
} from "@grogoni/shared-types";

export const modelArtifactChunkSizeBytes = 4 * 1024 * 1024;

export interface AccountAiAssetStore {
  putAgentManifest(input: InstalledOssAgentManifestSummary): Promise<void>;
  listAgentManifests(
    accountId: string,
    userId: string
  ): Promise<InstalledOssAgentManifestSummary[]>;
  beginModelArtifact(input: {
    accountId: string;
    userId: string;
    model: InstalledAgentModelSummary;
    now: string;
  }): Promise<CloudModelArtifactSummary>;
  putModelArtifactChunk(input: {
    artifactId: string;
    accountId: string;
    userId: string;
    chunkIndex: number;
    bytes: Buffer;
  }): Promise<void>;
  completeModelArtifact(input: {
    artifactId: string;
    accountId: string;
    userId: string;
    now: string;
  }): Promise<CloudModelArtifactSummary>;
  listModelArtifacts(accountId: string, userId: string): Promise<CloudModelArtifactSummary[]>;
  getModelArtifactChunk(input: {
    artifactId: string;
    accountId: string;
    userId: string;
    chunkIndex: number;
  }): Promise<Buffer | null>;
}

export function createMemoryAccountAiAssetStore(): AccountAiAssetStore {
  const agents = new Map<string, InstalledOssAgentManifestSummary>();
  const artifacts = new Map<string, CloudModelArtifactSummary>();
  const chunks = new Map<string, Buffer>();
  const ownerKey = (accountId: string, userId: string, id: string) =>
    `${accountId}:${userId}:${id}`;

  return {
    async putAgentManifest(input) {
      agents.set(ownerKey(input.accountId, input.userId, input.agent.id), structuredClone(input));
    },
    async listAgentManifests(accountId, userId) {
      return [...agents.values()]
        .filter((item) => item.accountId === accountId && item.userId === userId)
        .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
        .map((item) => structuredClone(item));
    },
    async beginModelArtifact({ accountId, userId, model, now }) {
      for (const candidate of [...artifacts.values()]) {
        if (
          candidate.accountId === accountId &&
          candidate.userId === userId &&
          candidate.modelId === model.modelId &&
          candidate.status === "UPLOADING"
        ) {
          artifacts.delete(candidate.id);
          for (let index = 0; index < candidate.chunkCount; index += 1) {
            chunks.delete(`${candidate.id}:${index}`);
          }
        }
      }
      const artifact = modelArtifactFromInstallation(accountId, userId, model, now);
      artifacts.set(artifact.id, artifact);
      return structuredClone(artifact);
    },
    async putModelArtifactChunk(input) {
      const artifact = requireOwnedArtifact(artifacts, input);
      assertArtifactChunk(artifact, input.chunkIndex, input.bytes);
      chunks.set(`${artifact.id}:${input.chunkIndex}`, Buffer.from(input.bytes));
    },
    async completeModelArtifact(input) {
      const artifact = requireOwnedArtifact(artifacts, input);
      let storedBytes = 0;
      for (let index = 0; index < artifact.chunkCount; index += 1) {
        const bytes = chunks.get(`${artifact.id}:${index}`);
        if (bytes === undefined) throw new Error("The cloud model upload is incomplete.");
        storedBytes += bytes.byteLength;
      }
      if (storedBytes !== artifact.fileSizeBytes) {
        throw new Error("The cloud model upload size does not match the model metadata.");
      }
      const completed = { ...artifact, status: "READY" as const, completedAt: input.now };
      artifacts.set(completed.id, completed);
      for (const candidate of [...artifacts.values()]) {
        if (
          candidate.id === completed.id ||
          candidate.accountId !== completed.accountId ||
          candidate.userId !== completed.userId ||
          candidate.modelId !== completed.modelId ||
          candidate.status !== "READY"
        ) {
          continue;
        }
        artifacts.delete(candidate.id);
        for (let index = 0; index < candidate.chunkCount; index += 1) {
          chunks.delete(`${candidate.id}:${index}`);
        }
      }
      return structuredClone(completed);
    },
    async listModelArtifacts(accountId, userId) {
      return [...artifacts.values()]
        .filter(
          (item) =>
            item.accountId === accountId && item.userId === userId && item.status === "READY"
        )
        .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""))
        .map((item) => structuredClone(item));
    },
    async getModelArtifactChunk(input) {
      requireOwnedArtifact(artifacts, input);
      const bytes = chunks.get(`${input.artifactId}:${input.chunkIndex}`);
      return bytes === undefined ? null : Buffer.from(bytes);
    }
  };
}

export function modelArtifactFromInstallation(
  accountId: string,
  userId: string,
  model: InstalledAgentModelSummary,
  now: string,
  id = randomUUID()
): CloudModelArtifactSummary {
  return {
    id,
    accountId,
    userId,
    sourceInstallationId: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    provider: model.provider,
    repositoryId: model.repositoryId,
    filename: model.filename,
    format: "GGUF",
    quantization: model.quantization,
    architecture: model.architecture,
    parameterCount: model.parameterCount,
    contextLength: model.contextLength,
    fileSizeBytes: model.fileSizeBytes,
    checksum: model.checksum,
    license: model.license,
    commercialUseAllowed: model.commercialUseAllowed,
    chunkSizeBytes: modelArtifactChunkSizeBytes,
    chunkCount: Math.ceil(model.fileSizeBytes / modelArtifactChunkSizeBytes),
    status: "UPLOADING",
    createdAt: now,
    completedAt: null
  };
}

export function copyAgentManifest(input: {
  accountId: string;
  userId: string;
  agent: OssAgentSummary;
  installedAt: string;
}): InstalledOssAgentManifestSummary {
  return {
    manifestVersion: 1,
    ...input,
    agent: structuredClone(input.agent),
    portableManifest: portableAgentManifestFromOssAgent(input.agent)
  };
}

export function hydrateAccountAgentManifest(
  input: Omit<InstalledOssAgentManifestSummary, "portableManifest"> & {
    portableManifest?: unknown;
  }
): InstalledOssAgentManifestSummary {
  const validation = validatePortableAgentManifest(input.portableManifest);
  return {
    ...structuredClone(input),
    agent: structuredClone(input.agent),
    portableManifest: validation.valid
      ? validation.manifest
      : portableAgentManifestFromOssAgent(input.agent)
  };
}

function requireOwnedArtifact(
  artifacts: Map<string, CloudModelArtifactSummary>,
  input: { artifactId: string; accountId: string; userId: string }
): CloudModelArtifactSummary {
  const artifact = artifacts.get(input.artifactId);
  if (
    artifact === undefined ||
    artifact.accountId !== input.accountId ||
    artifact.userId !== input.userId
  ) {
    throw new Error("Cloud model artifact was not found.");
  }
  return artifact;
}

export function assertArtifactChunk(
  artifact: CloudModelArtifactSummary,
  chunkIndex: number,
  bytes: Buffer
): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= artifact.chunkCount) {
    throw new Error("Cloud model chunk index is invalid.");
  }
  const expected =
    chunkIndex === artifact.chunkCount - 1
      ? artifact.fileSizeBytes - chunkIndex * artifact.chunkSizeBytes
      : artifact.chunkSizeBytes;
  if (bytes.byteLength !== expected) {
    throw new Error("Cloud model chunk size does not match the artifact metadata.");
  }
  if (chunkIndex === 0 && bytes.subarray(0, 4).toString("ascii") !== "GGUF") {
    throw new Error("The cloud model artifact is not a GGUF file.");
  }
}
