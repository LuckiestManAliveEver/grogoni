import type { OssAgentSummary } from "@grogoni/shared-types";

import type { AgentSettings } from "./grogoni-application-shared";

export type AgentCompatibilityStatus = "hosted-ready" | "backend-assisted" | "unavailable";

export interface RankedOssAgent {
  agent: OssAgentSummary;
  status: AgentCompatibilityStatus;
  reason: string;
  score: number;
}

export function rankPortableOssAgents(input: {
  agents: OssAgentSummary[];
  backendAvailable: boolean;
}): RankedOssAgent[] {
  const { agents, backendAvailable } = input;
  return agents
    .map((agent): RankedOssAgent => {
      const hosted = agent.executionMode === "hosted-api";
      const status: AgentCompatibilityStatus = !agent.licenseVerified
        ? "unavailable"
        : hosted
          ? "hosted-ready"
          : backendAvailable
            ? "backend-assisted"
            : "unavailable";
      const reason = !agent.licenseVerified
        ? "Source is public, but no recognized open-source license is declared."
        : hosted
          ? agent.requiresGpu
            ? "Runs on the Space's hosted GPU; this device only uses its API."
            : "Runs through the hosted Hugging Face API without local installation."
          : !backendAvailable
            ? "This GitHub project needs a configured backend adapter before it can be selected."
            : `Runs through Grogoni's restricted backend adapter (estimated ${agent.minimumMemoryGb} GB backend memory); repository code is never executed in the browser.`;

      return {
        agent,
        status,
        reason,
        score:
          (status === "hosted-ready" ? 2_000 : status === "backend-assisted" ? 1_000 : 0) +
          Math.min(agent.popularity, 999)
      };
    })
    .sort(
      (left, right) => right.score - left.score || left.agent.label.localeCompare(right.agent.label)
    );
}

export function selectLeastMemoryOssAgent(rankedAgents: RankedOssAgent[]): RankedOssAgent | null {
  return (
    rankedAgents
      .filter((candidate) => candidate.status !== "unavailable")
      .sort(
        (left, right) =>
          left.agent.minimumMemoryGb - right.agent.minimumMemoryGb ||
          Number(left.agent.requiresGpu) - Number(right.agent.requiresGpu) ||
          Number(left.status !== "hosted-ready") - Number(right.status !== "hosted-ready") ||
          right.agent.popularity - left.agent.popularity ||
          left.agent.id.localeCompare(right.agent.id)
      )[0] ?? null
  );
}

export function applyOssAgent(agent: AgentSettings, definition: OssAgentSummary): AgentSettings {
  const sourceIntegration = `OSS agent: ${definition.sourceUrl}`;
  return {
    ...agent,
    agentDefinitionId: definition.id,
    name: definition.label,
    description: definition.description,
    role: `Open-source ${definition.runtime} agent from ${definition.sourceId}`,
    integrations: [
      ...agent.integrations.filter((integration) => !integration.startsWith("OSS agent: ")),
      sourceIntegration
    ]
  };
}
