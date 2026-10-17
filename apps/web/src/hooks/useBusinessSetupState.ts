import { useState, type Dispatch, type SetStateAction } from "react";

import type { CountryCode } from "libphonenumber-js";
import type {
  AccountShopSummary,
  ConversationInboxItem,
  ConversationMessageSummary,
  ConversationView
} from "@grogoni/shared-types";

import type { GrogoniMode } from "../app-shell";
import { navigateToOwnerRoute } from "../browser-navigation";
import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, postJson, putJson } from "../api-helpers";
import { getCountryDialCode } from "../country-dial-codes";
import { normalizeOwnerPhoneInput } from "../phone-identity";
import { createDefaultAgent, readStoredOwnerAuth } from "../owner-app-bootstrap";
import { ownedShop } from "../stored-shop";
import {
  activeAgentStorageKey,
  activeBusinessStorageKey,
  legacyActiveBusinessStorageKey,
  setupDraftStorageKey,
  type ActiveBusiness,
  type AgentSettings,
  type BusinessResponse,
  type CountryDialCode,
  type SessionResponse,
  type SupportedLanguage
} from "../grogoni-application-shared";

interface UseBusinessSetupStateDeps {
  business: ActiveBusiness | null;
  setBusiness: Dispatch<SetStateAction<ActiveBusiness | null>>;
  session: SessionResponse | null;
  setSession: Dispatch<SetStateAction<SessionResponse | null>>;
  setAgentSettings: Dispatch<SetStateAction<AgentSettings>>;
  setMode: Dispatch<SetStateAction<GrogoniMode>>;
  setView: (view: "chat") => void;
  refreshSession: () => Promise<void>;
  setConversationInbox: Dispatch<SetStateAction<ConversationInboxItem[]>>;
  setActiveConversationId: Dispatch<SetStateAction<string | null>>;
  loadConversationThread: (conversationId: string) => Promise<void>;
  setStatusMessage: (message: string) => void;
  initialSetupDraft: { businessName?: string; language?: SupportedLanguage } | null;
  initialCountryCode: CountryDialCode;
  registerReset: (domainKey: string, fn: () => void) => void;
}

export function useBusinessSetupState(deps: UseBusinessSetupStateDeps) {
  const [businessName, setBusinessName] = useState(deps.initialSetupDraft?.businessName ?? "");
  const [language, setLanguage] = useState<SupportedLanguage>(
    deps.initialSetupDraft?.language ?? "en"
  );
  const [businessSetupStep, setBusinessSetupStep] = useState<"phone" | "details">("phone");
  const [shopPhoneCountryCode, setShopPhoneCountryCode] = useState<CountryDialCode>(
    deps.initialCountryCode
  );
  const [shopPhoneNumber, setShopPhoneNumber] = useState(() => {
    const initialOwnerAuth = readStoredOwnerAuth();
    return initialOwnerAuth !== null && !initialOwnerAuth.contact.includes("@")
      ? initialOwnerAuth.contact
      : "";
  });
  const [isBusinessSetupOpen, setIsBusinessSetupOpen] = useState(false);

  async function saveOwnerPhoneForShop(phoneNumber: string, country: CountryCode) {
    if (deps.session === null) {
      deps.setStatusMessage("Your session has expired. Sign in again.");
      return;
    }

    try {
      const response = await putJson<{ user: SessionResponse["user"] }>("/account/phone", {
        phoneNumber,
        country
      });
      deps.setSession((current) =>
        current === null
          ? current
          : {
              ...current,
              user: response.user
            }
      );
      setShopPhoneNumber(response.user.phoneNumberE164 ?? phoneNumber);
      setBusinessSetupStep("details");
      deps.setStatusMessage("Phone number saved. Add your shop details.");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function createInitialOwnerControlsMessage(shopId: string) {
    try {
      let response = await getJson<{ conversations: ConversationInboxItem[] }>("/v1/conversations");
      let conversationId =
        response.conversations.find(
          (conversation) =>
            conversation.kind === "personal" &&
            (conversation.activeShopId === shopId || conversation.activeShopId === null)
        )?.id ?? null;

      if (conversationId === null) {
        const created = await postJson<ConversationView>("/v1/conversations", {
          kind: "personal",
          activeShopId: shopId,
          title: "Grogoni agent"
        });
        conversationId = created.conversation.id;
        response = await getJson<{ conversations: ConversationInboxItem[] }>("/v1/conversations");
        deps.setConversationInbox(
          response.conversations.filter((item) => !item.taskParentConversationId)
        );
      }

      await postJson<ConversationMessageSummary>("/v1/messages", {
        conversationId,
        clientMessageId: `shop-welcome-owner-controls-${shopId}`,
        author: "agent",
        content: { type: "owner-controls", shopId },
        clientTimestamp: new Date().toISOString()
      });
      deps.setActiveConversationId(conversationId);
      navigateToOwnerRoute({ mode: "seller", view: "chat", conversationId }, { replace: true });
      await deps.loadConversationThread(conversationId);
    } catch {
      // Shop creation remains successful if messaging is temporarily unavailable.
      // The idempotent client message ID allows a later retry without duplicates.
    }
  }

  async function createBusiness() {
    if (deps.business !== null) {
      setIsBusinessSetupOpen(false);
      deps.setStatusMessage("This account has already registered a store.");
      return;
    }

    if (businessName.trim().length === 0) {
      deps.setStatusMessage("Business name is required");
      return;
    }

    if (deps.session === null) {
      deps.setStatusMessage("Sign up or log in before setting up a business");
      return;
    }

    try {
      const selectedPhoneCountry = getCountryDialCode(shopPhoneCountryCode);
      const normalizedPhone = normalizeOwnerPhoneInput(
        shopPhoneNumber,
        selectedPhoneCountry.countryCode
      );
      let response: BusinessResponse;
      try {
        response = await postJson<BusinessResponse>("/businesses", {
          name: businessName.trim(),
          language,
          phoneNumber: normalizedPhone,
          phoneCountry: selectedPhoneCountry.countryCode
        });
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "store_already_registered") throw error;
        // This account already owns a shop (made on another device, or the first create's reply
        // was lost). Open that shop instead of leaving the person on an error.
        const shops = await getJson<{ shops: AccountShopSummary[] }>("/v1/shops").catch(() => null);
        if (shops === null) {
          setIsBusinessSetupOpen(false);
          deps.setStatusMessage(
            "This account already has a shop, but it could not be opened just now. Check your connection, then tap Sell again."
          );
          return;
        }
        const existing = ownedShop(shops.shops);
        if (existing === null) throw error;
        await openCreatedBusiness(existing, false);
        deps.setStatusMessage(`You already have a shop, ${existing.name}. Opened it.`);
        return;
      }
      await openCreatedBusiness({ ...response.business, role: response.membership.role }, true);
      deps.setStatusMessage("Business ready. Seller controls are now active.");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function openCreatedBusiness(nextBusiness: ActiveBusiness, isNew: boolean) {
    const nextAgent = createDefaultAgent(nextBusiness);
    deps.setBusiness(nextBusiness);
    deps.setAgentSettings(nextAgent);
    setIsBusinessSetupOpen(false);
    deps.setMode("seller");
    navigateToOwnerRoute({ mode: "seller", view: "chat" }, { replace: true });
    localStorage.setItem(activeBusinessStorageKey, JSON.stringify(nextBusiness));
    localStorage.removeItem(legacyActiveBusinessStorageKey);
    localStorage.setItem(activeAgentStorageKey, JSON.stringify(nextAgent));
    localStorage.removeItem(setupDraftStorageKey);
    await deps.refreshSession();
    if (isNew) await createInitialOwnerControlsMessage(nextBusiness.id);
    deps.setView("chat");
  }

  deps.registerReset("business-setup", () => {
    setBusinessName("");
    setShopPhoneNumber("");
    // language/businessSetupStep/shopPhoneCountryCode/isBusinessSetupOpen were never included in
    // resetClientToStartup's reset sweep before this extraction - same class of pre-existing gap
    // this effort already found and fixed for purchaseReceipts (Phase 4) and the product stock
    // fields (Phase 8). Fixed here rather than carried forward.
    setLanguage(deps.initialSetupDraft?.language ?? "en");
    setBusinessSetupStep("phone");
    setShopPhoneCountryCode(deps.initialCountryCode);
    setIsBusinessSetupOpen(false);
  });

  return {
    businessName,
    setBusinessName,
    language,
    setLanguage,
    businessSetupStep,
    setBusinessSetupStep,
    shopPhoneCountryCode,
    setShopPhoneCountryCode,
    shopPhoneNumber,
    setShopPhoneNumber,
    isBusinessSetupOpen,
    setIsBusinessSetupOpen,
    saveOwnerPhoneForShop,
    createBusiness,
    createInitialOwnerControlsMessage
  };
}
