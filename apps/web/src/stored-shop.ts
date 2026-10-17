import type { AccountShopSummary } from "@grogoni/shared-types";
import type { ActiveBusiness } from "./grogoni-application-shared";

// What a device should do with the shop it last opened, given the account's shops as the server
// reports them now (docs/architecture/staff-invitations.md). A staff member who was removed, or
// who left, must not be put back into a shop they no longer belong to just because this device
// remembers it; and a member's role must come from the server, not from the stored copy.
export type StoredShopDecision =
  { action: "open"; business: ActiveBusiness } | { action: "forget" };

export function decideStoredShop(
  stored: ActiveBusiness,
  shops: readonly AccountShopSummary[]
): StoredShopDecision {
  const shop = shops.find((entry) => entry.business.id === stored.id);
  if (shop === undefined) return { action: "forget" };
  return { action: "open", business: { ...stored, ...shop.business, role: shop.membership.role } };
}

/**
 * The shop this account owns, for the "already registered a store" answer to a second shop
 * create: the person meant to open their shop, not to see an error.
 */
export function ownedShop(shops: readonly AccountShopSummary[]): ActiveBusiness | null {
  const shop = shops.find((entry) => entry.membership.role === "owner");
  return shop === undefined ? null : { ...shop.business, role: shop.membership.role };
}

/** After leaving `businessId`: open another shop the account still has, or none. */
export function shopAfterLeaving(
  shops: readonly AccountShopSummary[],
  businessId: string
): AccountShopSummary | null {
  return shops.find((shop) => shop.business.id !== businessId) ?? null;
}

/**
 * At launch, for a stored shop the account does not own: ask the server which shops the account
 * has now. Keep the device's saved workspace only when the server could not answer (offline, or a
 * 5xx); a definite answer that the account cannot use it (401/403/404, or the shop is missing from
 * the list) forgets it, so a removed staff member is not put back into the shop.
 */
export async function resolveStoredShopAtLaunch(
  stored: ActiveBusiness,
  fetchShops: () => Promise<readonly AccountShopSummary[]>
): Promise<StoredShopDecision | { action: "keep" }> {
  try {
    return decideStoredShop(stored, await fetchShops());
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number" && status >= 400 && status < 500) return { action: "forget" };
    return { action: "keep" };
  }
}
