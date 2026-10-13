import type { BusinessEnvironmentManifest } from "@grogoni/tool-core";

export const inventoryReplenishmentEnvironment: BusinessEnvironmentManifest = {
  id: "grogoni.retail.inventory",
  version: "1.0.0",
  name: "Inventory Replenishment",
  description:
    "Prepare budgeted purchase drafts from committed inventory, sales and confirmed supplier offers. No supplier submission.",
  domain: "retail",
  capabilities: ["procurement.prepare"],
  observationSchema: {
    version: "1.0.0",
    inventory: "committed",
    sales: "confirmed-seven-day-window",
    quotes: "owner-confirmed-all-in-unit-bound"
  },
  verificationPolicyId: "grogoni.inventory.replenishment.v1",
  evaluationPolicyId: "grogoni.inventory.outcomes.v1",
  executionMode: "LIVE",
  status: "ACTIVE"
};
