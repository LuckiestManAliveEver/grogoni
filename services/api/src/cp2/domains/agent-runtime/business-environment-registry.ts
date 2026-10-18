import { createBusinessEnvironmentRegistry } from "@grogoni/tool-core";
import { inventoryReplenishmentEnvironment } from "./inventory-environment.js";

// Definitions become active only after their execution and verification policies exist.
export const businessEnvironmentRegistry = createBusinessEnvironmentRegistry([
  inventoryReplenishmentEnvironment
]);
