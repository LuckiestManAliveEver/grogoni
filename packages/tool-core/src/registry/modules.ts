import type { LocalizedText, ShopModuleId } from "../contracts/runtime.js";

export type ShopCategoryId =
  "catalog" | "orders" | "customers" | "payments" | "delivery" | "channels" | "agent" | "insights";

/** Glyph ids the web app maps to its own icon set; never a URL or markup. */
export type ShopModuleIcon =
  | "box"
  | "supplier"
  | "receipt"
  | "bag"
  | "chat"
  | "network"
  | "wallet"
  | "truck"
  | "plug"
  | "agent"
  | "chart";

/**
 * Setup checks the API resolves per business (services/api/src/cp2/domains/shop-hub). Only the id
 * and copy live here: tool-core is a pure package the web bundle also imports, so it never reads
 * shop data itself.
 */
export type ShopSetupCheckId =
  "catalog_products" | "delivery_corridors" | "channels_linked" | "agent_runtime";

export type ShopSetupState = "ready" | "needs_setup" | "unavailable";

export interface ShopSetupCheckDefinition {
  id: ShopSetupCheckId;
  needsSetup: LocalizedText;
  unavailable: LocalizedText;
}

export interface ShopCategoryDefinition {
  id: ShopCategoryId;
  label: LocalizedText;
}

export interface ShopModuleDefinition {
  id: ShopModuleId;
  category: ShopCategoryId;
  icon: ShopModuleIcon;
  label: LocalizedText;
  description: LocalizedText;
  /** A role without this permission never sees the module, whatever tools it holds. */
  viewPermission: string;
  setupCheck: ShopSetupCheckId | null;
}

/** Display order of the hub's sections. */
export const shopCategories: readonly ShopCategoryDefinition[] = [
  { id: "catalog", label: { en: "Catalogue", sw: "Bidhaa" } },
  { id: "orders", label: { en: "Orders", sw: "Oda" } },
  { id: "customers", label: { en: "Customers & chats", sw: "Wateja na mazungumzo" } },
  { id: "payments", label: { en: "Payments", sw: "Malipo" } },
  { id: "delivery", label: { en: "Delivery", sw: "Usafirishaji" } },
  { id: "channels", label: { en: "Channels", sw: "Njia za mauzo" } },
  { id: "agent", label: { en: "Agent", sw: "Msaidizi" } },
  { id: "insights", label: { en: "Insights", sw: "Takwimu" } }
];

/**
 * The canonical Shop Hub modules. Tools join a module through their own `hub.module`
 * (registry/index.ts); modules with no tools yet (channels, agent) still appear so their setup
 * state is visible.
 */
export const shopModuleRegistry: Record<ShopModuleId, ShopModuleDefinition> = {
  catalog: {
    id: "catalog",
    category: "catalog",
    icon: "box",
    label: { en: "Catalogue", sw: "Bidhaa" },
    description: { en: "Products, prices and stock", sw: "Bidhaa, bei na stoki" },
    viewPermission: "product:read",
    setupCheck: "catalog_products"
  },
  suppliers: {
    id: "suppliers",
    category: "catalog",
    icon: "supplier",
    label: { en: "Suppliers", sw: "Wasambazaji" },
    description: {
      en: "Suppliers and what you buy from them",
      sw: "Wasambazaji na unachonunua kutoka kwao"
    },
    viewPermission: "supplier:read",
    setupCheck: null
  },
  receipts: {
    id: "receipts",
    category: "catalog",
    icon: "receipt",
    label: { en: "Receipts & imports", sw: "Risiti na uingizaji" },
    description: {
      en: "Scan receipts and import supplier files",
      sw: "Changanua risiti na uingize faili za wasambazaji"
    },
    viewPermission: "import:read",
    setupCheck: null
  },
  orders: {
    id: "orders",
    category: "orders",
    icon: "bag",
    label: { en: "Orders & sales", sw: "Oda na mauzo" },
    description: { en: "Invoices, sales and their history", sw: "Ankara, mauzo na historia yake" },
    viewPermission: "invoice:read",
    setupCheck: null
  },
  customers: {
    id: "customers",
    category: "customers",
    icon: "chat",
    label: { en: "Customers", sw: "Wateja" },
    description: { en: "Contacts, notes and messages", sw: "Mawasiliano, maelezo na ujumbe" },
    viewPermission: "customer:read",
    setupCheck: null
  },
  network: {
    id: "network",
    category: "customers",
    icon: "network",
    label: { en: "My network", sw: "Mtandao wangu" },
    description: {
      en: "Linked contacts and shop-to-shop routes",
      sw: "Mawasiliano yaliyounganishwa na njia kati ya maduka"
    },
    viewPermission: "business:read",
    setupCheck: null
  },
  payments: {
    id: "payments",
    category: "payments",
    icon: "wallet",
    label: { en: "Payments", sw: "Malipo" },
    description: {
      en: "Record payments and track balances",
      sw: "Rekodi malipo na fuatilia madeni"
    },
    viewPermission: "payment:read",
    // Payments are recorded manually today; there is no provider connection to check yet.
    setupCheck: null
  },
  delivery: {
    id: "delivery",
    category: "delivery",
    icon: "truck",
    label: { en: "Delivery", sw: "Usafirishaji" },
    description: {
      en: "Routes, corridors and delivery status",
      sw: "Njia, korido na hali ya usafirishaji"
    },
    viewPermission: "logistics:read",
    setupCheck: "delivery_corridors"
  },
  channels: {
    id: "channels",
    category: "channels",
    icon: "plug",
    label: { en: "Channels", sw: "Njia za mauzo" },
    description: {
      en: "Where customers reach your shop",
      sw: "Mahali wateja wanapofikia duka lako"
    },
    viewPermission: "business:read",
    setupCheck: "channels_linked"
  },
  agent: {
    id: "agent",
    category: "agent",
    icon: "agent",
    label: { en: "Agent", sw: "Msaidizi" },
    description: {
      en: "How your agent replies and runs",
      sw: "Jinsi msaidizi wako anavyojibu na kufanya kazi"
    },
    viewPermission: "business:read",
    setupCheck: "agent_runtime"
  },
  insights: {
    id: "insights",
    category: "insights",
    icon: "chart",
    label: { en: "Insights", sw: "Takwimu" },
    description: {
      en: "Sales summary, alerts and security review",
      sw: "Muhtasari wa mauzo, arifa na ukaguzi wa usalama"
    },
    viewPermission: "notification:read",
    setupCheck: null
  }
};

export const shopSetupChecks: Record<ShopSetupCheckId, ShopSetupCheckDefinition> = {
  catalog_products: {
    id: "catalog_products",
    needsSetup: {
      en: "Add your first product so customers can order.",
      sw: "Ongeza bidhaa yako ya kwanza ili wateja waweze kuagiza."
    },
    unavailable: {
      en: "Your catalogue can't be checked right now.",
      sw: "Bidhaa zako haziwezi kukaguliwa sasa hivi."
    }
  },
  delivery_corridors: {
    id: "delivery_corridors",
    needsSetup: {
      en: "Draw your first delivery corridor.",
      sw: "Chora korido yako ya kwanza ya usafirishaji."
    },
    unavailable: {
      en: "Delivery planning isn't available yet.",
      sw: "Upangaji wa usafirishaji haupatikani bado."
    }
  },
  channels_linked: {
    id: "channels_linked",
    needsSetup: {
      en: "Connect a channel so customers can reach you outside Grogoni.",
      sw: "Unganisha njia ili wateja wakufikie nje ya Grogoni."
    },
    unavailable: {
      en: "No outside channels are available yet.",
      sw: "Hakuna njia za nje zinazopatikana bado."
    }
  },
  agent_runtime: {
    id: "agent_runtime",
    needsSetup: {
      en: "Finish setting up your agent so it can reply.",
      sw: "Maliza kuweka msaidizi wako ili aweze kujibu."
    },
    unavailable: {
      en: "Your agent can't run right now.",
      sw: "Msaidizi wako hawezi kufanya kazi sasa hivi."
    }
  }
};
