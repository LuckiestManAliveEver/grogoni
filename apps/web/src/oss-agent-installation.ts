import { isAgentDefinitionId, type OssAgentSummary } from "@grogoni/shared-types";

const installationStorageKey = "grogoni.oss-agent-installations.v1";

export interface InstalledOssAgentManifest {
  manifestVersion: 1;
  agent: OssAgentSummary;
  installedAt: string;
}

type AgentManifestStorage = Pick<Storage, "getItem" | "setItem">;

export function listInstalledOssAgentManifests(
  storage: AgentManifestStorage = localStorage
): InstalledOssAgentManifest[] {
  return readArray(storage, installationStorageKey).filter(isInstalledManifest);
}

export function installOssAgentManifest(
  agent: OssAgentSummary,
  storage: AgentManifestStorage = localStorage,
  installedAt = new Date().toISOString()
): InstalledOssAgentManifest {
  if (!isSafeInstallableManifest(agent)) {
    throw new Error(
      "Only license-verified GitHub or Hugging Face agent manifests can be installed."
    );
  }
  const installed: InstalledOssAgentManifest = { manifestVersion: 1, agent, installedAt };
  const manifests = listInstalledOssAgentManifests(storage).filter(
    (candidate) => candidate.agent.id !== agent.id
  );
  storage.setItem(installationStorageKey, JSON.stringify([...manifests, installed]));
  return installed;
}

function readArray(storage: AgentManifestStorage, key: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isSafeInstallableManifest(agent: OssAgentSummary): boolean {
  const expectedPrefix = `${agent.source}:`;
  const expectedHost = agent.source === "github" ? "github.com" : "huggingface.co";
  const expectedPath =
    agent.source === "github" ? `/${agent.sourceId}` : `/spaces/${agent.sourceId}`;
  try {
    const sourceUrl = new URL(agent.sourceUrl);
    return (
      agent.licenseVerified &&
      isAgentDefinitionId(agent.id) &&
      agent.id.startsWith(expectedPrefix) &&
      agent.id === `${agent.source}:${agent.sourceId}` &&
      sourceUrl.protocol === "https:" &&
      sourceUrl.hostname === expectedHost &&
      sourceUrl.pathname.replace(/\/$/, "") === expectedPath
    );
  } catch {
    return false;
  }
}

function isInstalledManifest(value: unknown): value is InstalledOssAgentManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<InstalledOssAgentManifest>;
  return (
    manifest.manifestVersion === 1 &&
    typeof manifest.installedAt === "string" &&
    typeof manifest.agent === "object" &&
    manifest.agent !== null &&
    isSafeInstallableManifest(manifest.agent as OssAgentSummary)
  );
}
