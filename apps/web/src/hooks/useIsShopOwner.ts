import { useEffect, useState } from "react";

import { postJson } from "../api-helpers";
import type { RoleCheckResponse } from "../grogoni-application-shared";

/**
 * Whether the signed-in person owns this shop: true, false, or null while unknown (or when the
 * check failed, so a network error never shows an owner a read-only card for good). Owner-only
 * settings (presence, catalogue sharing, the directory listing) are refused to staff by the API;
 * this lets their cards say so up front instead of on Save.
 */
export function useIsShopOwner(businessId: string): boolean | null {
  const [owner, setOwner] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setOwner(null);
    void postJson<RoleCheckResponse>("/roles/check", { businessId, role: "owner" })
      .then((check) => {
        if (!cancelled) setOwner(check.allowed);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [businessId]);
  return owner;
}
