import type { ProductInteraction } from "@/lib/api/dashboard";

/**
 * Experience-graph activity derived from closed-schema journey telemetry.
 *
 * Operations are the only graph signal Epode stores: `/agent-guide`,
 * `/agent-negotiate/<category>`, `/agent-decide/<category>`, and `/agent-item`.
 * Need state never leaves the product, so per-category funnels are computed
 * from hop counts and decision status codes only. Category-less hops (guide,
 * item detail) are attributed through the journey's session linkage.
 */
export type JourneyDimensionActivity = {
  category: string;
  journeys: number;
  negotiations: number;
  decisions: number;
  decided: number;
  counterfactuals: number;
  itemViews: number;
  guides: number;
  lastSeenAt: string;
};

const NEGOTIATE_PREFIX = "/agent-negotiate/";
const DECIDE_PREFIX = "/agent-decide/";

function categoryFromOperation(operation: string, prefix: string): string | null {
  if (!operation.startsWith(prefix)) return null;
  const category = operation.slice(prefix.length).split("/")[0]?.trim() ?? "";
  return category || null;
}

export function summarizeExperienceActivity(
  interactions: ProductInteraction[],
): JourneyDimensionActivity[] {
  const byCategory = new Map<string, JourneyDimensionActivity>();
  const sessionCategories = new Map<string, Set<string>>();

  function bucket(category: string): JourneyDimensionActivity {
    const existing = byCategory.get(category);
    if (existing) return existing;
    const created: JourneyDimensionActivity = {
      category,
      journeys: 0,
      negotiations: 0,
      decisions: 0,
      decided: 0,
      counterfactuals: 0,
      itemViews: 0,
      guides: 0,
      lastSeenAt: "",
    };
    byCategory.set(category, created);
    return created;
  }

  function touch(entry: JourneyDimensionActivity, occurredAt: string, sessionId: string | null) {
    if (occurredAt > entry.lastSeenAt) entry.lastSeenAt = occurredAt;
    if (sessionId) {
      const categories = sessionCategories.get(sessionId) ?? new Set<string>();
      categories.add(entry.category);
      sessionCategories.set(sessionId, categories);
    }
  }

  for (const interaction of interactions) {
    const negotiated = categoryFromOperation(interaction.operation, NEGOTIATE_PREFIX);
    const decided = categoryFromOperation(interaction.operation, DECIDE_PREFIX);
    if (negotiated) {
      const entry = bucket(negotiated);
      entry.negotiations += 1;
      touch(entry, interaction.occurredAt, interaction.sessionId);
    } else if (decided) {
      const entry = bucket(decided);
      entry.decisions += 1;
      if (interaction.statusCode === 422) entry.counterfactuals += 1;
      else if (
        interaction.statusCode !== null &&
        interaction.statusCode >= 200 &&
        interaction.statusCode < 300
      ) {
        entry.decided += 1;
      }
      touch(entry, interaction.occurredAt, interaction.sessionId);
    }
  }

  for (const interaction of interactions) {
    const categories = interaction.sessionId
      ? sessionCategories.get(interaction.sessionId)
      : undefined;
    if (!categories || categories.size !== 1) continue;
    const category = [...categories][0];
    const entry = byCategory.get(category);
    if (!entry) continue;
    if (interaction.operation === "/agent-guide") {
      entry.guides += 1;
      touch(entry, interaction.occurredAt, interaction.sessionId);
    } else if (interaction.operation === "/agent-item") {
      entry.itemViews += 1;
      touch(entry, interaction.occurredAt, interaction.sessionId);
    }
  }

  for (const entry of byCategory.values()) {
    entry.journeys = [...sessionCategories.values()].filter((categories) =>
      categories.has(entry.category),
    ).length;
  }

  return [...byCategory.values()].sort(
    (left, right) =>
      right.journeys - left.journeys || right.lastSeenAt.localeCompare(left.lastSeenAt),
  );
}

/** Convert a graph category slug into a valid context-field key body. */
export function contextKeyForCategory(category: string): string {
  const slug = category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `session.${slug || "need"}`;
}
