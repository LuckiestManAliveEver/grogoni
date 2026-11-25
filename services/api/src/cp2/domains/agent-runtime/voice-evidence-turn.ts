import { validateRuntimeToolInput, type RuntimeToolProposal } from "@grogoni/tool-core";

/**
 * A voice note turn (voicecom P2.1): the transcript is untrusted evidence, so whatever was
 * proposed (by the model or any deterministic parser) is narrowed to a clarification. Acting on
 * spoken words needs a separate text message that the person typed and sent.
 */
export function voiceEvidenceOnlyProposal<P extends RuntimeToolProposal>(
  proposal: P,
  voiceEvidenceOnly: boolean | undefined
): P | RuntimeToolProposal {
  if (!voiceEvidenceOnly || proposal.toolName === "unknown.clarify") return proposal;
  return {
    toolName: "unknown.clarify",
    input: {},
    reason: "Please send a separate text message to request an action.",
    validation: validateRuntimeToolInput("unknown.clarify", {})
  };
}
