import type { ShopPresenceStatus } from "./grogoni-application-shared";
import { fulfillmentLanguage, type FulfillmentLanguage } from "./fulfillment-copy";

// Copy for the hanging shop sign (Design D1). Follows the device language like the fulfillment
// cards. "private" is the server's "hidden from the public marketplace" status
// (CP2Store.listPublicStorefronts skips it), not "contacts only".
export interface ShopSignCopy {
  plate: Record<ShopPresenceStatus, string>;
  meaning: Record<ShopPresenceStatus, string>;
  status: (meaning: string) => string;
  change: string;
  choose: string;
}

const en: ShopSignCopy = {
  plate: { online: "OPEN", private: "PRIVATE", offline: "CLOSED" },
  meaning: {
    online: "Open for customers",
    private: "Hidden from the marketplace",
    offline: "Closed for now"
  },
  status: (meaning) => `Shop status: ${meaning}`,
  change: "Change shop status",
  choose: "Choose shop status"
};

const sw: ShopSignCopy = {
  plate: { online: "FUNGUA", private: "BINAFSI", offline: "IMEFUNGWA" },
  meaning: {
    online: "Liko wazi kwa wateja",
    private: "Halionekani sokoni",
    offline: "Limefungwa kwa sasa"
  },
  status: (meaning) => `Hali ya duka: ${meaning}`,
  change: "Badilisha hali ya duka",
  choose: "Chagua hali ya duka"
};

export function shopSignCopy(language: FulfillmentLanguage = fulfillmentLanguage()): ShopSignCopy {
  return language === "sw" ? sw : en;
}

export const shopPresenceStatuses: readonly ShopPresenceStatus[] = ["online", "private", "offline"];
