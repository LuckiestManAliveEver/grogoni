import type { BuyFeedSummary, GuestIntent } from "@grogoni/shared-types";

/**
 * The chat reply after a buyer's message ran a marketplace search. It reports what the search
 * actually found, so the buyer is never told to "open a result" when there are none.
 */
export function describeMarketplaceSearch(
  query: string,
  feed: BuyFeedSummary | null | undefined
): { reply: string; status: string } {
  if (feed === null || feed === undefined) {
    return {
      reply: `I couldn't search the marketplace for "${query}" just now. Check your connection and send it again.`,
      status: "Marketplace search failed."
    };
  }
  const shops = new Set(feed.results.map((result) => result.sourceLabel)).size;
  if (feed.results.length === 0) {
    // Worded to be right whether or not the text was a product: an ambiguous message is searched,
    // and this is what it gets back when nothing matches.
    return {
      reply: `I couldn't find "${query}" on Grogoni. If it's something to buy, try its name, like "sugar" or "maize flour".`,
      status: "No marketplace results."
    };
  }
  const items = feed.results.length === 1 ? "1 item" : `${feed.results.length} items`;
  const from = shops === 1 ? "1 shop" : `${shops} shops`;
  return {
    reply: `I found ${items} from ${from} for "${query}". Open a result to see the shop and add it to your cart.`,
    status: `${items} found.`
  };
}

/*
 * Guest routing. Someone without a shop has no assistant of their own, so the chat can only
 * search the marketplace. Telling a product from anything else in free text is judgment, not a
 * rule, so the design does not depend on getting it right: anything that is not unmistakably
 * something else is searched, and an empty search answers in words that fit either way. Only
 * unmistakable messages get their own answer: greetings, thanks, acknowledgements, help or
 * contact requests, questions about Grogoni itself, order and delivery help, and wanting to sell.
 */

const greetingPhrase =
  "how are you(?: doing| today)?|how are things|how(?:'s| is) it going|how do you do|(?:is )?any(?:one|body) there|are you there|see you(?: later| soon| tomorrow)?|hi|hello|hey|hallo|hola|jambo|hujambo|mambo|niaje|sasa|vipi|karibu|habari(?: (?:gani|yako|zako|za \\w+))?|good (?:morning|afternoon|evening|night|day)|morning|evening|bye|goodbye|good ?bye|kwaheri|see you";
const thanksPhrase =
  "thank (?:you|u)(?: (?:so much|very much|sana|again))?|thanks?(?: (?:a lot|so much|very much|bro|man|sana|again))?|thx|ty|asante(?: sana)?";
const acknowledgementPhrase =
  "ok(?:ay)?|k|yes|yeah|yep|no|nope|sure|cool|fine|great|nice|alright|sorry|pole(?: sana)?|what'?s up|wassup|niko (?:sawa|poa|fiti)|sawa(?: sawa)?|ndio|ndiyo|hapana|poa(?: sana)?|safi|freshi";
const politeTail =
  /(?:[\s,]+(?:please|pls|plz|sana|bro|tafadhali|sir|madam|ma'?am|boss|dear|friend|rafiki))+[.!?]*$/iu;
/** Greetings, thanks and "ok" said together ("OK thanks", "Hi, thanks"). */
const socialOnly = new RegExp(
  `^(?:(?:${greetingPhrase}|${thanksPhrase}|${acknowledgementPhrase})(?: there| everyone| all)?[\\s,.!?-]*)+$`,
  "iu"
);
const thanksStart = new RegExp(`^(?:${thanksPhrase})\\b`, "iu");
const thanksAnywhere = new RegExp(`\\b(?:${thanksPhrase})\\b`, "iu");
/** A greeting or thanks in front of a request ("Hi, I need sugar", "Thanks, do you have rice?"). */
const socialPrefix = new RegExp(
  `^(?:(?:${greetingPhrase}|${thanksPhrase}|${acknowledgementPhrase})(?: there)?[\\s,.!-]+)+`,
  "iu"
);
const helpOrContact =
  /^(?:help|support|menu|info|start)[.!?]*$|\bhelp\s+me\b|\bcan\s+(?:you|someone|anyone)\s+help\b|\b(?:call|ring|phone|text|whatsapp|email|contact)\s+(?:me|us)\b|\b(?:talk|speak)\s+to\b|\b(?:customer\s+(?:care|service)|a\s+(?:human|person|real\s+person|agent))\b/iu;
/** About Grogoni itself, not about something to buy. */
const aboutGrogoni =
  /^(?:who\s+are\s+you|what\s+are\s+you|what\s+is\s+(?:this|grogoni|this\s+app)|what\s+can\s+you\s+do|how\s+does\s+(?:this|it|grogoni)\s+work|how\s+do\s+i\s+use\s+(?:this|it|grogoni)|is\s+this\s+(?:a\s+)?(?:bot|robot|real|safe|free)|are\s+you\s+(?:a\s+)?(?:bot|robot|real|human))\b/iu;
/** Order and delivery help: phrases, so "a delivery bag" and "Track pants" stay products. */
const orderHelp =
  /\b(?:my\s+orders?|order\s+status|where\s+is\s+my|track\s+(?:my\s+|the\s+|an?\s+)?(?:order|delivery|parcel|package)|tracking\s+(?:number|code)|cancel|refund|return\s+(?:my|an?|the)\b|complain|complaint|problem\s+with|shida|malalamiko|deliver\s+to|do\s+you\s+deliver|delivery\s+(?:fee|cost|charge|time|status|to|area)|(?:how\s+much|what)\s+(?:is|does)\s+(?:the\s+)?delivery)\b|\bcan\s+you\s+deliver\b|^(?:delivery|deliveries|shipping)\??$/iu;
/** Wanting to sell on Grogoni, said by the person themselves. Not "selling price of…". */
const sellerTopic =
  /^sell$|\b(?:how\s+(?:do|can)\s+i|can\s+i|i\s+want\s+to|i\s+would\s+like\s+to|i'd\s+like\s+to|help\s+me)\s+(?:sell|open|start|create|set\s*up|register)\b|\b(?:open|start|create|set\s*up|register)\s+(?:a|my)\s+(?:shop|store|business|duka|biashara)\b|\bsell\s+on\s+grogoni\b|\b(?:fungua|anzisha)\s+(?:duka|biashara)\b|\bnataka\s+kuuza\b/iu;

/**
 * The product in a request to buy or a question about one, with the scaffolding removed: "I want
 * to buy sugar", "Can I get sugar?", "Is there sugar?", "Is sugar available?", "Who has sugar?",
 * "Give me 2kg sugar", "Sugar please", "Nataka kuagiza sukari" all give "sugar" (or "2kg sugar").
 * Null when nothing is asked for. A greeting, thanks or "please" around it is not part of it.
 */
export function parseMarketplaceBuyIntent(message: string): string | null {
  const text = request(message);
  if (text.length === 0) return null;
  const strips: RegExp[] = [
    /^i\s+(?:want|need|would\s+like)(?:\s+to\s+(?:buy|purchase|order|get|have))?\s+/iu,
    /^i'd\s+like(?:\s+to\s+(?:buy|purchase|order|get|have))?\s+/iu,
    /^(?:i\s*(?:am|'m)?\s*)?looking\s+for\s+/iu,
    /^(?:show|bring)\s+me\s+/iu,
    /^(?:is\s+there\s+)?any(?:one|body)\s+(?:selling|who\s+sells|with|that\s+has)\s+/iu,
    /^any\s+(?=\S)/iu,
    /^how\s+much\s+(?:for|is\s+a|is\s+the)\s+/iu,
    /^(?:can|could|may)\s+i\s+(?:buy|purchase|order|get|have|find)\s+/iu,
    /^(?:(?:can\s+you\s+)?help\s+me\s+|please\s+)?(?:find|get|buy|order)\s+(?:me\s+)?/iu,
    /^where\s+can\s+i\s+(?:buy|purchase|get|find)\s+/iu,
    /^(?:do\s+you\s+have|have\s+you\s+got|do\s+you\s+sell|does\s+anyone\s+(?:sell|have)|who\s+(?:sells|has)|find\s+me|sell\s+me|give\s+me|get\s+me|send\s+me)\s+/iu,
    /^(?:is|are)\s+there\s+(?:any\s+)?/iu,
    /^(?:order|buy|need|want)\s+/iu,
    /^(?:ni)?nataka\s+(?:kununua\s+|kuagiza\s+|kupata\s+)?/iu,
    /^(?:ni)?natafuta\s+/iu,
    /^(?:unauza|mnauza|kuna|nipe|niletee)\s+/iu,
    /^how\s+much\s+(?:is|are|does|do)\s+/iu,
    /^(?:what\s+is\s+the\s+)?(?:selling\s+)?price\s+of\s+/iu,
    /^bei\s+ya\s+/iu
  ];
  let product = text;
  let asked = false;
  for (const strip of strips) {
    const next = product.replace(strip, "");
    if (next !== product) {
      asked = true;
      product = next;
    }
  }
  // "rice price", "cement price?"
  if (/\s+(?:price|cost|bei)\??$/iu.test(product)) asked = true;
  // "Is sugar available?", "Is there sugar in stock?"
  const available = product.match(
    /^(?:is|are)\s+(.+?)\s+(?:available|in\s+stock|sold\s+here)\??$/iu
  );
  if (available !== null) {
    asked = true;
    product = available[1]!;
  }
  // Trailing punctuation first, so "sugar available?" loses " available" too.
  product = product
    .replace(/[?.!]+$/u, "")
    .replace(/\s+ni\s+(?:ngapi|bei\s+gani)$/iu, "")
    .replace(/\s+(?:available|in\s+stock|near\s+me|around\s+here|nearby|please)$/iu, "")
    .replace(/\s+(?:cost|price)$/iu, "")
    // "in Nairobi": a place (capitalised) after the product is not part of it.
    .replace(/\s+(?:in|at|around)\s+\p{Lu}[\p{L}-]+$/u, "")
    .replace(/^(?:a|an|the|some|any)\s+/iu, "")
    .trim();
  // "How much is it?" names nothing to look for.
  if (/^(?:it|this|that|these|those|them|one)$/iu.test(product)) return null;
  return asked && product.length > 0 ? product : null;
}

/** What is left once greetings, thanks, "please" and other politeness around it are set aside. */
function request(message: string): string {
  return message
    .trim()
    .replace(/\s+/gu, " ")
    .replace(socialPrefix, "")
    .replace(/^please[\s,]+/iu, "")
    .replace(politeTail, "")
    .trim();
}

export type GuestRoute =
  { kind: "search"; query: string } | { kind: "reply"; reply: string; status: string };

export const guestExplainReply =
  'I find products and shops on Grogoni. Tell me what you need, like "sugar" or "I want to buy maize flour", and I\'ll show you who sells it.';

const reply = (text: string, status: string): GuestRoute => ({
  kind: "reply",
  reply: text,
  status
});
const explain = reply(guestExplainReply, "Tell Grogoni what you need.");
const welcome = reply(
  "You're welcome. Tell me what else you need, and I'll find who sells it.",
  "Tell Grogoni what you need."
);
const orderHelpReply = reply(
  "I can't look up orders or deliveries from here. Message the shop you ordered from to track, change or cancel an order, or to ask where they deliver.",
  "Orders are handled by the shop."
);
const sellReply = reply(
  "To sell on Grogoni, tap the shop button at the top of the screen and set up your shop. It takes about a minute.",
  "Set up a shop to sell."
);

/**
 * The answer for an intent the guest intent classifier picked (guest-intent-client.ts). The copy
 * is the same app-owned copy the rules use; the model only chose which one, and for a search the
 * query, which is checked to be the guest's own words before it gets here.
 */
export function guestRouteForIntent(intent: GuestIntent, query: string | null): GuestRoute {
  switch (intent) {
    case "search":
      return query === null ? explain : { kind: "search", query };
    case "thanks":
      return welcome;
    case "order_help":
      return orderHelpReply;
    case "selling":
      return sellReply;
    case "greeting":
    case "help":
    case "about":
      return explain;
  }
}

/** How a guest's message is answered by the rules: searched as a product, or replied to. */
export function routeGuestMessage(message: string): GuestRoute {
  const text = message.trim().replace(/\s+/gu, " ");
  // Emoji, punctuation or other text with no letters or digits: nothing to look for.
  if (!/[\p{L}\p{N}]/u.test(text)) return explain;
  if (text.length === 0 || socialOnly.test(text.replace(politeTail, ""))) {
    return thanksAnywhere.test(text) ? welcome : explain;
  }
  const rest = request(text);
  if (rest.length === 0 || /^[.!?,\s]*$/u.test(rest))
    return thanksAnywhere.test(text) ? welcome : explain;
  // Thanks with more after it ("Thank you for the sugar", "Asante kwa msaada") is thanks, unless
  // what follows asks for something ("Thanks, do you have rice?").
  if (thanksStart.test(text)) {
    // "Thanks! I also need sugar": a request in any clause after the thanks is still searched.
    const asked = rest
      .split(/[,.!;]+|\s+(?:and|also|too)\s+/iu)
      .map((clause) => {
        const trimmed = clause.trim().replace(/^(?:also|and)\s+/iu, "");
        // "sugar too": a short product name with "too" / "also" after it.
        const also = trimmed.match(/^(\S+(?:\s+\S+){0,2})\s+(?:too|also|as\s+well)$/iu);
        return also !== null ? also[1]! : parseMarketplaceBuyIntent(trimmed);
      })
      .find((product) => product !== null && !helpOrContact.test(product));
    return asked ? { kind: "search", query: asked } : welcome;
  }
  if (orderHelp.test(rest)) return orderHelpReply;
  if (sellerTopic.test(rest)) return sellReply;
  // A product asked for wins over the words around it: "help me find sugar" searches sugar.
  const product = parseMarketplaceBuyIntent(rest);
  if (product !== null) {
    // "I need help" asks for help, not for a product called "help".
    if (helpOrContact.test(product)) return explain;
    return product.split(" ").length <= 6 && !/^to\s/iu.test(product)
      ? { kind: "search", query: product }
      : explain;
  }
  if (helpOrContact.test(rest) || aboutGrogoni.test(rest)) return explain;
  // Not unmistakably anything else: search it. Long sentences and other questions about
  // something unnamed are explained instead, since there is no product in them to look for.
  const words = rest.split(" ").length;
  if (words > 5 || (rest.endsWith("?") && words > 3)) return explain;
  const query = rest.replace(/[?.!]+$/u, "").trim();
  return query.length === 0 ? explain : { kind: "search", query };
}
