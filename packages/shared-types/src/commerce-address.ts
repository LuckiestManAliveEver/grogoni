/**
 * Pure derivation of a shop's public-facing commerce address ("handle@grogoni.com") from its
 * internal grogoniId ("grogoni.handle"). Shared between the API (which is the source of truth for a
 * business's grogoniId) and the web app (which needs to display/derive the same address for shops
 * it already has a grogoniId for, without an extra round trip) so the two never drift apart.
 */
export function commerceAddressFromGrogoniId(grogoniId: string): string {
  const handle = grogoniId
    .trim()
    .toLowerCase()
    .replace(/^grogoni\./u, "");
  return `${handle}@grogoni.com`;
}

export function grogoniIdFromCommerceAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  const handle = normalized.endsWith("@grogoni.com")
    ? normalized.slice(0, -"@grogoni.com".length)
    : normalized.replace(/^grogoni\./u, "");
  return `grogoni.${handle}`;
}

export function normalizeCommerceAddress(address: string): string {
  return commerceAddressFromGrogoniId(grogoniIdFromCommerceAddress(address));
}
