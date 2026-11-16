import type { ShareableCatalogueSummary } from "@grogoni/shared-types";
import data from "./seed-catalogue-data.generated.json" with { type: "json" };

/** Bundled global data: available in Node and Supabase Edge without filesystem access or a shop. */
export const seedCatalogue = data;
export const seedCatalogueSourceId = `dataset:${data.id}`;

export function seedCatalogueSummary(): ShareableCatalogueSummary {
  return {
    businessId: seedCatalogueSourceId,
    grogoniId: data.id,
    businessName: data.name,
    productCount: data.products.length,
    updatedAt: data.generatedAt,
    sourceKind: "seed",
    datasetVersion: data.version
  };
}

export function seedCatalogueMatches(search: string): boolean {
  return [
    data.id,
    data.name,
    data.country,
    "global shared starter seed catalogue catalog Kenyan KES",
    ...data.products.flatMap((product) => [
      product.name,
      product.category ?? "",
      product.department
    ])
  ].some((value) => value.toLowerCase().includes(search));
}
