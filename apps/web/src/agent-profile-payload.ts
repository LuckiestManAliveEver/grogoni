import type { AgentSettings } from "./grogoni-application-shared";
import { ensureRequiredAgentContextScripts, sanitizeContextScripts } from "./owner-app-bootstrap";

export function buildAgentProfileUpdate(agent: AgentSettings): Record<string, unknown> {
  return {
    agentDefinitionId: agent.agentDefinitionId,
    name: agent.name,
    description: agent.description,
    modelId: agent.model,
    role: agent.role,
    language: agent.language,
    personality: agent.personality,
    personalityConfig: agent.personalityConfig,
    instructions: agent.instructions,
    instructionPolicy: agent.instructionPolicy,
    knowledge: agent.knowledge,
    tools: agent.tools,
    skillBindings: agent.skillBindings,
    integrations: agent.integrations,
    contextScripts: ensureRequiredAgentContextScripts(sanitizeContextScripts(agent.contextScripts)),
    memoryPolicy: agent.memoryPolicy,
    evaluationPolicy: agent.evaluationPolicy,
    supportedLanguages: agent.supportedLanguages,
    businessCategory: agent.businessCategory,
    publicIntroduction: agent.publicIntroduction,
    status: agent.status
  };
}
