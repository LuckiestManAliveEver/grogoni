/**
 * Contract for the guest intent classifier (services/api/src/guest-intent/README.md): POST
 * /v1/guest/intent, served by the Edge API and the Node API, called by the web chat for a guest
 * (someone without a shop) before it answers. The model only picks one of these intents and,
 * for a search, the words to search. Every reply a guest reads is written by the app, never by
 * the model.
 */

/**
 * The intents the rules in apps/web/src/marketplace-search-reply.ts already tell apart:
 * - search: something to buy or ask about (a product, its price or availability), or a bare
 *   product name. The only intent that carries a query.
 * - greeting: hello, bye, how are you, ok / yes / sawa, emoji: small talk with nothing to find.
 * - thanks: thanks or gratitude with nothing else asked for.
 * - help: a help, support or contact request ("help me", "call me", "talk to a person").
 * - about: a question about Grogoni or the assistant itself ("who are you", "how does this work").
 * - order_help: an existing order or delivery (track, cancel, refund, delivery fee or area).
 * - selling: the guest wants to sell on Grogoni or open a shop.
 */
export const guestIntents = [
  "search",
  "greeting",
  "thanks",
  "help",
  "about",
  "order_help",
  "selling"
] as const;
export type GuestIntent = (typeof guestIntents)[number];

export const guestIntentPath = "/v1/guest/intent";

export const guestIntentLimits = {
  /** Longer messages are refused (413) and the client routes them by rules without asking. */
  maxMessageChars: 500,
  maxQueryChars: 80,
  maxQueryWords: 8
} as const;

export interface GuestIntentRequest {
  message: string;
}

/** 200 response. Any other status, or a body that fails parseGuestIntentResponse, means "use the rules". */
export interface GuestIntentResponse {
  intent: GuestIntent;
  /** The words to search, taken from the guest's own message. Non-null only for "search". */
  query: string | null;
  modelId: string;
  latencyMs: number;
}

/** Error codes the endpoint answers with; the client treats every one as "use the rules". */
export type GuestIntentErrorCode =
  | "auth_required"
  | "invalid_request"
  | "message_too_long"
  | "rate_limited"
  | "guest_intent_unavailable"
  | "guest_intent_failed";

const queryCharacters = /^[\p{L}\p{N}][\p{L}\p{N}\s'&.,/%-]*$/u;

function words(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Levenshtein distance, stopping early once it passes `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      best = Math.min(best, current[j]!);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** How far a query word may be from a word the guest typed: a fixed typo, never a new word. */
function typoAllowance(word: string): number {
  return word.length >= 6 ? 2 : word.length >= 4 ? 1 : 0;
}

/**
 * The search query, if every word of it comes from the guest's own message (or is a one or two
 * letter typo fix of a word in it, "suger" -> "sugar"). This is what keeps a prompt-injected
 * message from putting model-chosen words into a reply: the reply can only ever quote the guest.
 * Null when the query is empty, too long, has odd characters, or introduces a word of its own.
 */
export function groundGuestSearchQuery(query: unknown, message: string): string | null {
  if (typeof query !== "string") return null;
  const trimmed = query.trim().replace(/\s+/gu, " ");
  if (
    trimmed.length === 0 ||
    trimmed.length > guestIntentLimits.maxQueryChars ||
    !queryCharacters.test(trimmed)
  )
    return null;
  const queryWords = words(trimmed);
  if (queryWords.length === 0 || queryWords.length > guestIntentLimits.maxQueryWords) return null;
  const messageWords = new Set(words(message));
  const grounded = queryWords.every(
    (word) =>
      messageWords.has(word) ||
      [...messageWords].some(
        (typed) => editDistance(word, typed, typoAllowance(typed)) <= typoAllowance(typed)
      )
  );
  return grounded ? trimmed : null;
}

/**
 * A classification as the model (or the endpoint) states it, validated: a known intent, and a
 * grounded query for a search and none otherwise. Null for anything else, so the caller falls
 * back to the rules instead of guessing.
 */
export function parseGuestIntentClassification(
  value: unknown,
  message: string
): { intent: GuestIntent; query: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const intent = record.intent;
  if (typeof intent !== "string" || !(guestIntents as readonly string[]).includes(intent))
    return null;
  if (intent !== "search") return { intent: intent as GuestIntent, query: null };
  const query = groundGuestSearchQuery(record.query, message);
  return query === null ? null : { intent: "search", query };
}

/** The endpoint's 200 body, validated against the message that was sent. */
export function parseGuestIntentResponse(
  value: unknown,
  message: string
): GuestIntentResponse | null {
  const classification = parseGuestIntentClassification(value, message);
  if (classification === null) return null;
  const record = value as Record<string, unknown>;
  return {
    ...classification,
    modelId: typeof record.modelId === "string" ? record.modelId : "unknown",
    latencyMs: typeof record.latencyMs === "number" ? record.latencyMs : 0
  };
}
