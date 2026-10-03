import type { BusinessSummary } from "@grogoni/shared-types";
import { Cp2Error } from "./cp2-error.js";
import { normalizeStorefrontLookupId } from "./text-normalization.js";

export function requirePublicStorefrontBusiness(
  businesses: Map<string, BusinessSummary>,
  quarantinedBusinessIds: Set<string>,
  agentId: string
): BusinessSummary {
  const storefrontId = normalizeStorefrontLookupId(agentId);
  const business = [...businesses.values()].find(
    (candidate) => normalizeStorefrontLookupId(candidate.grogoniId) === storefrontId
  );
  if (business === undefined || quarantinedBusinessIds.has(business.id)) {
    throw new Cp2Error(404, "storefront_not_found", "Storefront was not found.");
  }
  return business;
}
