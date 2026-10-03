import type {
  CloudModelArtifactSummary,
  InstalledOssAgentManifestSummary,
  OssAgentSummary
} from "@grogoni/shared-types";

import { getJson, postJson } from "./api-helpers";
import { installOssAgentManifest } from "./oss-agent-installation";

export async function installOssAgentForAccount(
  agent: OssAgentSummary
): Promise<InstalledOssAgentManifestSummary> {
  const manifest = await postJson<InstalledOssAgentManifestSummary>("/v1/oss-agents/installed", {
    agent
  });
  installOssAgentManifest(manifest.agent, localStorage, manifest.installedAt);
  return manifest;
}

export async function hydrateAccountOssAgentManifests(): Promise<
  InstalledOssAgentManifestSummary[]
> {
  const response = await getJson<{ manifests: InstalledOssAgentManifestSummary[] }>(
    "/v1/oss-agents/installed"
  );
  for (const manifest of response.manifests) {
    installOssAgentManifest(manifest.agent, localStorage, manifest.installedAt);
  }
  return response.manifests;
}

// Uploading a device-installed model artifact (uploadLocalModelToAccount) and restoring one back
// down to a device (restoreAccountModelToDevice) were both removed with the private on-device
// model architecture. Neither had a legitimate hosted-first replacement: the metadata the backend
// requires to register an artifact (storageKey, runtimeBackend, installationStatus,
// compatibilityStatus - see services/api/src/cp2/domains/agent-runtime/route-body-parsers.ts's
// InstalledModelBody) was only ever produced by the on-device GGUF install/verification pipeline
// in the now-deleted ai-model-manager.ts, so there is nothing left to compute those fields from a
// plain user-picked file. listAccountModelArtifacts stays as a harmless read-only account API.
export async function listAccountModelArtifacts(): Promise<CloudModelArtifactSummary[]> {
  return (await getJson<{ artifacts: CloudModelArtifactSummary[] }>("/v1/model-artifacts"))
    .artifacts;
}
