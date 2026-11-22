import { shopCategories, type ShopCategory } from "@grogoni/shared-types";

/** How each shop directory category reads to a buyer or an owner. */
export const shopCategoryLabels: Record<ShopCategory, string> = {
  groceries: "Groceries",
  fresh_produce: "Fruit and vegetables",
  butchery: "Butchery",
  bakery: "Bakery",
  restaurant: "Restaurant and food",
  pharmacy: "Pharmacy",
  beauty: "Beauty and salon",
  fashion: "Clothes and shoes",
  electronics: "Electronics",
  phones_airtime: "Phones and airtime",
  hardware: "Hardware",
  agrovet: "Agrovet",
  stationery: "Stationery and books",
  household: "Household goods",
  services: "Services",
  other: "Other"
};

export { shopCategories };
export type { ShopCategory };

/** A buyer's shop directory filters; empty fields mean "any". */
export interface ShopDirectoryFilter {
  category?: ShopCategory;
  place?: string;
}

/** The /public/storefronts query for a directory filter. */
export function storefrontSearchPath(filter: ShopDirectoryFilter = {}, limit = 24): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (filter.category) query.set("category", filter.category);
  // Spaces collapse as they do in a saved place, so "Westlands  Nairobi" still matches.
  const place = filter.place?.replace(/\s+/gu, " ").trim();
  if (place) query.set("place", place);
  return `/public/storefronts?${query.toString()}`;
}
