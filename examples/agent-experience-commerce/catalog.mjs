import { createLightingExperienceCatalog } from "@epode/node/experience-graph";

/** Single source of truth for human and agent representations. */
export const lightingCatalog = createLightingExperienceCatalog();

export function humanCatalogSummary() {
  return lightingCatalog.items.map((item) => ({
    id: item.id,
    title: item.title,
    brand: item.brand,
    price: item.price,
    purposes: item.matches?.purpose ?? [],
    colors: item.matches?.color ?? [],
  }));
}
