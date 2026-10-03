import { useState } from "react";

import type { AccountShopSummary, BuyFeedSummary } from "@grogoni/shared-types";

import { getErrorMessage } from "../chat-message-plumbing";
import { fetchFreshJson, getJson, postJson } from "../api-helpers";
import { resolveStoredShopAtLaunch } from "../stored-shop";
import { activeBusinessStorageKey } from "../grogoni-application-shared";
import { agentSettingsFromBusinessProfile, readStoredBusiness } from "../owner-app-bootstrap";
import type {
  ActiveBusiness,
  AgentSettings,
  BuyCartItem,
  BusinessAgentProfileSummary,
  MarketplaceIntroStateSummary,
  PublicStorefrontListResponse,
  PublicStorefrontSummary,
  RoleCheckResponse,
  SessionResponse,
  ShopPresenceStatus,
  ShopPresenceSummary
} from "../grogoni-application-shared";

interface UseMarketplaceStateDeps {
  session: SessionResponse | null;
  setBusiness: (business: ActiveBusiness | null) => void;
  setAgentSettings: (agent: AgentSettings) => void;
  setStatusMessage: (message: string) => void;
  // Navigation's setters are only needed inside completeMarketplaceIntro/validateStoredBusiness
  // (called later, at click/effect time), and Navigation already runs before Marketplace in
  // OwnerApp's hook-call order, so a plain getter (not a required-eager dep) is enough here -
  // matches the getter pattern used throughout this effort for cross-domain reads/writes.
  getNavigationSetters: () => {
    setIsMarketplaceShortcutOpen: (open: boolean) => void;
    setShopPresenceStatus: (status: ShopPresenceStatus) => void;
  };
  registerReset: (domainKey: string, fn: () => void) => void;
}

export function useMarketplaceState(deps: UseMarketplaceStateDeps) {
  const [isMarketplaceIntroComplete, setIsMarketplaceIntroComplete] = useState(
    () => localStorage.getItem("grogoni.marketplace-intro.completed.v1") === "true"
  );
  const [publicStorefronts, setPublicStorefronts] = useState<PublicStorefrontSummary[]>([]);
  const [publicStorefrontsLoading, setPublicStorefrontsLoading] = useState(false);
  const [buyFeed, setBuyFeed] = useState<BuyFeedSummary | null>(null);
  const [buyCart, setBuyCart] = useState<BuyCartItem[]>([]);

  const { session, setBusiness, setAgentSettings, setStatusMessage } = deps;

  async function loadMarketplaceIntroState() {
    try {
      const state = await getJson<MarketplaceIntroStateSummary>("/v1/marketplace-intro");
      if (state.completedAt !== null) {
        localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
        setIsMarketplaceIntroComplete(true);
      }
    } catch {
      // Anonymous and offline visitors use the local completion marker.
    }
  }

  async function loadPublicStorefronts() {
    setPublicStorefrontsLoading(true);
    try {
      const response = await getJson<PublicStorefrontListResponse>("/public/storefronts?limit=24");
      setPublicStorefronts(response.storefronts);
    } catch {
      setPublicStorefronts([]);
    } finally {
      setPublicStorefrontsLoading(false);
    }
  }

  async function completeMarketplaceIntro() {
    const { setIsMarketplaceShortcutOpen } = deps.getNavigationSetters();
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
    setIsMarketplaceIntroComplete(true);
    setIsMarketplaceShortcutOpen(false);
    setStatusMessage("Marketplace ready. Use the Marketplace button to return anytime.");

    if (session !== null) {
      try {
        await postJson<MarketplaceIntroStateSummary>("/v1/marketplace-intro/complete", {
          businessId: null
        });
      } catch (error) {
        setStatusMessage(getErrorMessage(error));
      }
    }
  }

  async function validateStoredBusiness() {
    const { setShopPresenceStatus } = deps.getNavigationSetters();
    const storedBusiness = readStoredBusiness();

    if (storedBusiness === null) {
      return;
    }

    // Set only when the server answered the owner check; a failure anywhere below (including the
    // owner branch's own follow-up requests) must not be mistaken for "not the owner".
    let ownerCheck: RoleCheckResponse | null = null;
    try {
      const roleCheck = await postJson<RoleCheckResponse>("/roles/check", {
        businessId: storedBusiness.id,
        role: "owner"
      });
      ownerCheck = roleCheck;

      if (roleCheck.allowed) {
        setBusiness(storedBusiness);
        const [presence, agentProfile] = await Promise.all([
          getJson<ShopPresenceSummary>(`/businesses/${storedBusiness.id}/presence`),
          getJson<BusinessAgentProfileSummary>(`/businesses/${storedBusiness.id}/agent-profile`)
        ]);
        setShopPresenceStatus(presence.status);
        setAgentSettings(agentSettingsFromBusinessProfile(agentProfile, storedBusiness));
        setStatusMessage("Owner shell active");
        return;
      }
    } catch {
      // Local development uses an in-memory API store; stale cached business views are expected after restarts.
    }

    // The server says this account is not the owner: open the stored shop only if the account is
    // still a member of it (staff can be removed or leave), with the role the server reports now.
    if (ownerCheck !== null && !ownerCheck.allowed) {
      const decision = await resolveStoredShopAtLaunch(storedBusiness, async () => {
        const { shops } = await fetchFreshJson<{ shops: AccountShopSummary[] }>("/v1/shops");
        return shops;
      });
      if (decision.action === "forget") {
        localStorage.removeItem(activeBusinessStorageKey);
        setBusiness(null);
        return;
      }
      if (decision.action === "open") {
        setBusiness(decision.business);
        setStatusMessage("Saved workspace loaded");
        return;
      }
    }

    // The owner, an unanswered check, or offline: keep the device's saved workspace.
    setBusiness(storedBusiness);
    setStatusMessage("Saved workspace loaded");
  }

  deps.registerReset("marketplace", () => {
    setPublicStorefronts([]);
    setPublicStorefrontsLoading(false);
    setBuyFeed(null);
    setBuyCart([]);
  });

  return {
    isMarketplaceIntroComplete,
    setIsMarketplaceIntroComplete,
    publicStorefronts,
    setPublicStorefronts,
    publicStorefrontsLoading,
    setPublicStorefrontsLoading,
    buyFeed,
    setBuyFeed,
    buyCart,
    setBuyCart,
    loadMarketplaceIntroState,
    loadPublicStorefronts,
    completeMarketplaceIntro,
    validateStoredBusiness
  };
}
