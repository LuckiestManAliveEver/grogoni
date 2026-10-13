import type { RuntimeToolDefinition, RuntimeToolName } from "../contracts/runtime.js";
import { coreReadsRuntimeTools } from "../domains/core-reads.js";
import { complianceRuntimeTools } from "../domains/compliance.js";
import { commerceRuntimeTools } from "../domains/commerce.js";
import { networkRuntimeTools } from "../domains/network.js";
import { productsRuntimeTools } from "../domains/products.js";
import { customersRuntimeTools } from "../domains/customers.js";
import { suppliersRuntimeTools } from "../domains/suppliers.js";
import { commercialRecordsRuntimeTools } from "../domains/commercial-records.js";
import { procurementRuntimeTools } from "../domains/procurement.js";
import { invoicesRuntimeTools } from "../domains/invoices.js";
import { paymentsRuntimeTools } from "../domains/payments.js";
import { logisticsRuntimeTools } from "../domains/logistics.js";
import { receiptsRuntimeTools } from "../domains/receipts.js";
import { importsRuntimeTools } from "../domains/imports.js";
import { messagingRuntimeTools } from "../domains/messaging.js";
import { workspaceRuntimeTools } from "../domains/workspace.js";
import { computerRuntimeTools } from "../domains/computer.js";
import { sharedRuntimeTools } from "../domains/shared.js";

/**
 * The single canonical runtime-tool registry. Domain modules own metadata; this file only
 * composes them in the established order so prompt and MCP projections remain stable.
 */
export const runtimeToolRegistry: Record<RuntimeToolName, RuntimeToolDefinition> = {
  ...coreReadsRuntimeTools,
  ...complianceRuntimeTools,
  ...networkRuntimeTools,
  ...commerceRuntimeTools,
  ...productsRuntimeTools,
  ...customersRuntimeTools,
  ...suppliersRuntimeTools,
  ...commercialRecordsRuntimeTools,
  ...procurementRuntimeTools,
  ...invoicesRuntimeTools,
  ...paymentsRuntimeTools,
  ...logisticsRuntimeTools,
  ...receiptsRuntimeTools,
  ...importsRuntimeTools,
  ...messagingRuntimeTools,
  ...workspaceRuntimeTools,
  ...computerRuntimeTools,
  ...sharedRuntimeTools
};
