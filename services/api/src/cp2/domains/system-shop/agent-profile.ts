import type {
  BusinessAgentProfileInput,
  BusinessAgentProfileSummary
} from "../agent-runtime/shared.js";
import { systemShop, systemShopAgentIntroduction } from "./catalogue.js";

const operatingInstructions =
  "You are the Grogoni Marketplace Agent and you run Jane's Shop on your own; there is no human " +
  "owner or staff. Answer customers from the shop's catalogue records only. Every product has a " +
  "demo price in KES and is kept in stock automatically. Orders placed in this shop are accepted " +
  "and completed automatically. Tell customers that prices are demo prices and that no money " +
  "changes hands. Tell shop owners they can copy this catalogue from Shared catalogues.";

/**
 * The shop's agent profile: the platform defaults with the business policy opened up, because no
 * human exists to approve anything. Owner approval lists and per-skill confirmation are cleared and
 * every skill is enabled. Platform-level safety (intrinsically confirm-only tools, customer
 * audiences getting no tools) is not a business policy and still applies.
 */
export function systemShopAgentProfile(
  current: BusinessAgentProfileSummary
): BusinessAgentProfileInput {
  return {
    agentDefinitionId: current.agentDefinitionId,
    name: systemShop.operatorDisplayName,
    description: "Runs Jane's Shop, the marketplace demo shop, with no human intervention.",
    modelId: current.modelId,
    role: "Autonomous operator of Jane's Shop",
    language: systemShop.language,
    personality: current.personality,
    personalityConfig: current.personalityConfig,
    instructions: operatingInstructions,
    knowledge: current.knowledge,
    tools: [...current.tools],
    integrations: [...current.integrations],
    contextScripts: [...current.contextScripts],
    status: "active",
    instructionPolicy: {
      ...current.instructionPolicy,
      generalOperatingRules: [operatingInstructions],
      pricingRules: [
        "Quote only the demo prices in the catalogue. Never invent or change a price."
      ],
      returnsAndRefundRules: [
        "Jane's Shop is a demo shop and takes no payment, so there is nothing to refund."
      ],
      escalationRules: [
        "There is no human to escalate to. Say plainly when a fact is not in the shop's records."
      ],
      restrictedActions: [],
      ownerApprovalRequiredFor: [],
      catalogueModificationAllowed: true
    },
    skillBindings: current.skillBindings.map((binding) => ({
      ...binding,
      enabled: true,
      requiredConfirmationLevel: "none"
    })),
    memoryPolicy: current.memoryPolicy,
    evaluationPolicy: current.evaluationPolicy,
    supportedLanguages: [...current.supportedLanguages],
    businessCategory: "general_retail",
    publicIntroduction: systemShopAgentIntroduction
  };
}
