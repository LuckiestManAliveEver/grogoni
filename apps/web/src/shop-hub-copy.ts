import { fulfillmentLanguage, type FulfillmentLanguage } from "./fulfillment-copy";

// English and Swahili chrome for the Shop Hub. Module, tool and setup copy comes from the API
// (the canonical registry in @grogoni/tool-core); only the hub's own buttons and states live here.

const en = {
  title: "Your shop",
  copyLink: "Copy shop link",
  copied: "Link copied",
  share: "Share shop",
  viewAsCustomer: "View as customer",
  needsAttention: "Needs attention",
  fix: "Fix",
  loading: "Loading your shop",
  offline: "You're offline. Your shop tools will appear when you reconnect.",
  offlineCached: "You're offline. Showing your shop as it was last loaded.",
  loadFailed: "Your shop tools could not load.",
  retry: "Try again",
  empty: "Your role has no shop tools yet. Ask the shop owner for access.",
  back: "Back",
  askAgent: "Ask the agent",
  askAgentIntro: "Or ask your agent to do one of these in chat:",
  noTools: "Nothing to run here yet. Use the button above to set it up.",
  needsConfirmation: "Asks you first",
  state: { ready: "Ready", needs_setup: "Needs setup", unavailable: "Unavailable" },
  entryTitle: "Your shop",
  entryBody: "Every tool your shop runs on, in one place.",
  surface: {
    catalogue: "Open catalogue",
    storefrontPreview: "View as customer",
    businessDashboard: "Today's dashboard",
    networkSync: "My network",
    suppliers: "Suppliers",
    imports: "Receipts & files",
    invoices: "Invoices",
    pos: "Make a sale",
    customers: "Customers",
    sync: "Sync status",
    payments: "Payments",
    logistics: "Deliveries",
    agent: "Agent & settings",
    runtime: "Runtime",
    reports: "Business summary",
    notifications: "Alerts",
    compliance: "Security & privacy",
    beta: "Beta programme",
    launch: "Launch checklist"
  }
};

const sw: typeof en = {
  title: "Duka lako",
  copyLink: "Nakili kiungo cha duka",
  copied: "Kiungo kimenakiliwa",
  share: "Shiriki duka",
  viewAsCustomer: "Tazama kama mteja",
  needsAttention: "Yanahitaji kushughulikiwa",
  fix: "Rekebisha",
  loading: "Duka lako linapakia",
  offline: "Uko nje ya mtandao. Zana za duka zitaonekana ukiunganishwa tena.",
  offlineCached: "Uko nje ya mtandao. Unaona duka lako kama lilivyopakiwa mara ya mwisho.",
  loadFailed: "Zana za duka lako hazikuweza kupakia.",
  retry: "Jaribu tena",
  empty: "Jukumu lako halina zana za duka bado. Muombe mmiliki wa duka ruhusa.",
  back: "Rudi",
  askAgent: "Muulize msaidizi",
  askAgentIntro: "Au muombe msaidizi wako afanye mojawapo ya haya kwenye chat:",
  noTools: "Hakuna cha kufanya hapa bado. Tumia kitufe hapo juu kukiweka.",
  needsConfirmation: "Atakuuliza kwanza",
  state: { ready: "Tayari", needs_setup: "Inahitaji kuwekwa", unavailable: "Haipatikani" },
  entryTitle: "Duka lako",
  entryBody: "Kila zana ya duka lako, mahali pamoja.",
  surface: {
    catalogue: "Fungua bidhaa",
    storefrontPreview: "Tazama kama mteja",
    businessDashboard: "Dashibodi ya leo",
    networkSync: "Mtandao wangu",
    suppliers: "Wasambazaji",
    imports: "Risiti na faili",
    invoices: "Ankara",
    pos: "Uza sasa",
    customers: "Wateja",
    sync: "Hali ya usawazishaji",
    payments: "Malipo",
    logistics: "Usafirishaji",
    agent: "Msaidizi na mipangilio",
    runtime: "Mfumo wa msaidizi",
    reports: "Muhtasari wa biashara",
    notifications: "Arifa",
    compliance: "Usalama na faragha",
    beta: "Programu ya majaribio",
    launch: "Orodha ya uzinduzi"
  }
};

export type ShopHubCopy = typeof en;
export type ShopHubLanguage = FulfillmentLanguage;
export type ShopHubSurfaceLabel = keyof ShopHubCopy["surface"];

/** Follows the device language, like the fulfillment and staff cards. */
export function shopHubLanguage(): ShopHubLanguage {
  return fulfillmentLanguage();
}

export function shopHubCopy(language: ShopHubLanguage = shopHubLanguage()): ShopHubCopy {
  return language === "sw" ? sw : en;
}
