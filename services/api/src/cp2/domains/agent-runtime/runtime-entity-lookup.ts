import type {
  CustomerSummary,
  ProductSummary,
  RuntimeToolName,
  SupplierSummary
} from "@grogoni/shared-types";

import { normalizeRuntimeLookup } from "./shared.js";
import type { AgentRuntimeDomainDeps } from "./store.js";

export function findRuntimeProductByName(
  deps: AgentRuntimeDomainDeps,
  businessId: string,
  productName: string
): ProductSummary | null {
  const normalizedName = normalizeRuntimeLookup(productName);

  if (normalizedName.length === 0) {
    return null;
  }

  const products = [...deps.products.values()].filter(
    (product) => product.businessId === businessId
  );

  return (
    products.find((product) => normalizeRuntimeLookup(product.name) === normalizedName) ??
    products.find((product) => normalizeRuntimeLookup(product.name).includes(normalizedName)) ??
    null
  );
}

export function findRuntimeSupplierByName(
  deps: AgentRuntimeDomainDeps,
  businessId: string,
  supplierName: string
): SupplierSummary | null {
  const normalizedName = normalizeRuntimeLookup(supplierName);

  if (normalizedName.length === 0) {
    return null;
  }

  const suppliers = deps.suppliersForBusiness(businessId);

  return (
    suppliers.find((supplier) => normalizeRuntimeLookup(supplier.name) === normalizedName) ??
    suppliers.find((supplier) => normalizeRuntimeLookup(supplier.name).includes(normalizedName)) ??
    null
  );
}

export function findRuntimeCustomerByName(
  deps: AgentRuntimeDomainDeps,
  businessId: string,
  customerName: string
): CustomerSummary | null {
  const normalizedName = normalizeRuntimeLookup(customerName);

  if (normalizedName.length === 0) {
    return null;
  }

  const customers = [...deps.customers.values()].filter(
    (customer) => customer.businessId === businessId
  );

  return (
    customers.find((customer) => normalizeRuntimeLookup(customer.name) === normalizedName) ??
    customers.find((customer) => normalizeRuntimeLookup(customer.name).includes(normalizedName)) ??
    null
  );
}

type EntityFinder = (
  deps: AgentRuntimeDomainDeps,
  businessId: string,
  name: string
) => ProductSummary | SupplierSummary | CustomerSummary | null;

const runtimeEntityReferenceFields: Partial<
  Record<RuntimeToolName, { field: string; noun: string; find: EntityFinder }>
> = {
  "product.update": { field: "productName", noun: "product", find: findRuntimeProductByName },
  "product.stock_adjust": {
    field: "productName",
    noun: "product",
    find: findRuntimeProductByName
  },
  "product.delete": { field: "productName", noun: "product", find: findRuntimeProductByName },
  "customer.update": { field: "customerName", noun: "customer", find: findRuntimeCustomerByName },
  "supplier.update": { field: "supplierName", noun: "supplier", find: findRuntimeSupplierByName }
};

/**
 * The "oracle" check named in docs/agent-runtime-vs-research-standards-audit.md: every tool below
 * looks its named entity up by name at EXECUTION time and throws a 404 Cp2Error on a miss
 * (findRuntimeProductByName and friends, above) - but that only fires after the merchant has
 * already confirmed the drafted action, since createRuntimeTurn mints the confirmation token
 * before execution ever runs. Calling this first, before the confirmation token is minted, turns
 * a hallucinated or mis-parsed entity name (model-invented or badly parser-extracted - either way
 * the merchant never actually confirmed that name refers to that record) into an immediate,
 * ordinary clarification instead of a wasted confirm round-trip that ends in a raw 404.
 */
export function findRuntimeUnknownEntityReferenceError(
  deps: AgentRuntimeDomainDeps,
  businessId: string,
  toolName: RuntimeToolName,
  toolInput: Record<string, unknown>
): string | null {
  const lookup = runtimeEntityReferenceFields[toolName];
  if (lookup === undefined) return null;

  const rawName = toolInput[lookup.field];
  // An empty/missing name is already caught by validateRuntimeToolInput (packages/tool-core/src/
  // validation/runtime.ts) as a required-field error on every one of these tools - nothing to add
  // here for that case.
  if (typeof rawName !== "string" || rawName.trim().length === 0) return null;

  if (lookup.find(deps, businessId, rawName) !== null) return null;

  return `I couldn't find a ${lookup.noun} named "${rawName.trim()}" in your records. Please check the name, or add it first.`;
}
