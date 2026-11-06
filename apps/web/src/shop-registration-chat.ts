/**
 * Registering a shop by talking to the marketplace agent. The agent asks for the shop's name and,
 * when the account has none saved, a phone number, then asks the person to confirm. A shop is
 * permanent and an account owns one, so nothing is created without that yes. Written by the app,
 * not the model, so a shop is only created from what the person typed.
 */
export type ShopRegistrationStep =
  | { step: "name" }
  | { step: "phone"; name: string }
  | { step: "confirm"; name: string; phoneNumber: string | null };

export type ShopRegistrationTurn =
  | { kind: "ask"; next: ShopRegistrationStep; reply: string }
  | { kind: "cancelled"; reply: string }
  | { kind: "register"; name: string; phoneNumber: string | null };

// The whole message must ask for a shop: "open a store account" or "make business cards" must not.
const wantsShop =
  /^(?:(?:hi|hello|please)[,\s]+)?(?:(?:i|we)(?:\s+would\s+like|'d\s+like|\s+want|\s+need|\s+wish)\s+to\s+|(?:can|could|may)\s+(?:i|we)\s+|help\s+me\s+|please\s+)?(?:open|start|create|register|set\s*up|make)\s+(?:a|an|my|our)\s+(?:new\s+)?(?:shop|store|business)(?:\s+(?:on\s+grogoni|here|please|now))?[.!?]*$|^(?:(?:i|we)(?:\s+would\s+like|'d\s+like|\s+want)\s+to\s+)?(?:sell\s+on\s+grogoni|become\s+a\s+(?:seller|shop\s*owner|merchant))[.!?]*$|^(?:nataka|ningependa|tunataka)\s+(?:kufungua|kuanzisha|kusajili)\s+(?:duka|biashara)(?:\s+yangu)?[.!?]*$|^nataka\s+kuuza(?:\s+kwa\s+grogoni)?[.!?]*$/iu;

const cancelWords = /^(?:cancel|stop|never\s*mind|no|no\s+thanks|acha|hapana)[.!]*$/iu;
const confirmWords = /^(?:yes|yes\s+please|confirm|create\s+it|ok|okay|ndio|ndiyo|sawa)[.!]*$/iu;
/** A question or a command, not a name. The confirmation step catches anything this misses. */
const unlikelyName =
  /[?]|^(?:where|what|why|how|when)\b|^(?:confirm|cancel)\s+\w+$|^(?:please\s+)?remind\b/iu;

export function isShopRegistrationRequest(message: string): boolean {
  return wantsShop.test(message.trim());
}

export function startShopRegistration(): ShopRegistrationTurn & { kind: "ask" } {
  return {
    kind: "ask",
    next: { step: "name" },
    reply: "Happy to set up your shop. What is it called? Say cancel at any time to stop."
  };
}

function confirmation(name: string, phoneNumber: string | null): ShopRegistrationTurn {
  return {
    kind: "ask",
    next: { step: "confirm", name, phoneNumber },
    reply: `Create a shop called ${name}${phoneNumber === null ? "" : ` with phone ${phoneNumber}`}? An account can own one shop. Reply yes to create it.`
  };
}

export function continueShopRegistration(
  state: ShopRegistrationStep,
  message: string,
  savedPhone: string | null
): ShopRegistrationTurn {
  const text = message.trim();
  if (cancelWords.test(text)) {
    return { kind: "cancelled", reply: "No problem. I have not created a shop." };
  }
  if (state.step === "confirm") {
    return confirmWords.test(text)
      ? { kind: "register", name: state.name, phoneNumber: state.phoneNumber }
      : { kind: "cancelled", reply: "I have not created a shop. Ask me again when you are ready." };
  }
  if (state.step === "phone") return confirmation(state.name, text);
  if (text.length < 2 || text.length > 60 || unlikelyName.test(text)) {
    return {
      kind: "ask",
      next: state,
      reply: "What should your shop be called? Send just the name, or say cancel to stop."
    };
  }
  if (savedPhone !== null) return confirmation(text, null);
  return {
    kind: "ask",
    next: { step: "phone", name: text },
    reply: `Which phone number should ${text} use?`
  };
}

const storageKey = "grogoni.shop-registration.v1";

export interface PendingShopRegistration {
  accountId: string;
  threadId: string | null;
  step: ShopRegistrationStep;
}

const pendingLifetimeMs = 30 * 60 * 1000;
/** Used when storage is unavailable, so the flow still works until the page reloads. */
let memoryPending: string | null = null;

/** Kept for this tab, so a reload does not lose the conversation. */
export function savePendingShopRegistration(pending: PendingShopRegistration | null): void {
  memoryPending = pending === null ? null : JSON.stringify({ ...pending, savedAt: Date.now() });
  try {
    if (memoryPending === null) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, memoryPending);
  } catch {
    // The copy in memory carries on.
  }
}

function storedPending(): string | null {
  // Memory holds the latest save even when storage refused it; storage survives a reload.
  if (memoryPending !== null) return memoryPending;
  try {
    return sessionStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function readPendingShopRegistration(): PendingShopRegistration | null {
  try {
    const raw = storedPending();
    if (raw === null) return null;
    const { savedAt, ...pending } = JSON.parse(raw) as PendingShopRegistration & {
      savedAt?: number;
    };
    const fresh = typeof savedAt === "number" && Date.now() - savedAt < pendingLifetimeMs;
    const valid =
      typeof pending.accountId === "string" &&
      ["name", "phone", "confirm"].includes(pending.step?.step);
    return fresh && valid ? pending : null;
  } catch {
    return null;
  }
}
