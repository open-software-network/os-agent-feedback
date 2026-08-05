import { createLightingExperienceCatalog } from "@epode/node/experience-graph";
import { createProductExperienceGraph } from "@epode/node/product-graph";

/** Single source of truth for human and agent representations. */
export const lightingCatalog = createLightingExperienceCatalog();

const PURPOSES = ["coding", "reading", "writing", "photography", "conversation", "relaxing"];
const BUDGETS = [100, 150, 200, 250, 300];
const CAPABILITIES = ["dimmable", "portable", "adjustable", "glare-control", "high-cri"];
const FINISHES = ["orange", "neutral", "black", "white"];

export const productCatalog = lightingCatalog.items.map((item) => ({
  id: item.id,
  title: item.title,
  brand: item.brand || "Fieldnote Supply",
  category: item.category || lightingCatalog.category,
  price: {
    amount: item.price?.amount ?? 0,
    currency: item.price?.currency || "USD",
  },
  summary: `${item.title} from ${item.brand || "Fieldnote Supply"}.`,
  attributes: {
    features: Array.isArray(item.attributes?.features) ? item.attributes.features : [],
    purposes: item.matches?.purpose ?? [],
    colors: item.matches?.color ?? [],
  },
  notSpecified: item.id === "forma-one-table-lamp" ? ["CRI", "bulb replaceability"] : [],
  sellerClaims:
    item.id === "forma-one-table-lamp"
      ? [
          {
            claim: "A beautifully balanced light for any room",
            attributedTo: "seller_marketing_copy",
            verified: false,
          },
        ]
      : [],
}));

function tokenChoice(token, value, meaning, strength) {
  return { token, value, meaning, ...(strength ? { strength } : {}) };
}

function productAnchorQuestion() {
  return {
    dimension: "decision_anchor",
    question: "Which kind of task-relevant input is known for evaluating this lamp?",
    whyItMatters: "A fit verdict requires at least one real need, constraint, or preference.",
    choices: [
      tokenChoice("consider-purpose", "purpose", "What the lamp will be used for"),
      tokenChoice("consider-budget", "budget", "A budget ceiling or target"),
      tokenChoice("consider-capability", "capability", "A capability the lamp must have"),
      tokenChoice("consider-finish", "finish", "An appearance requirement or preference"),
      tokenChoice("consider-evidence", "evidence", "How much catalog evidence the verdict requires"),
    ],
  };
}

function productQuestion(state, item) {
  const requested = state.expressedDimensions.length ? undefined : state.requestedDimension;
  if (!state.expressedDimensions.length && !requested) return productAnchorQuestion();
  if (requested === "purpose" || (!requested && !state.purpose && !state.purposeUnknown)) {
    return {
      dimension: "purpose",
      question: "What will this lamp be used for?",
      whyItMatters: "Purpose is checked against explicit catalog use cases.",
      choices: PURPOSES.map((purpose) =>
        tokenChoice(`purpose-${purpose}`, purpose, `Used for ${purpose}`),
      ),
      unknownToken: "purpose-unknown",
    };
  }
  if (requested === "budget" || (!requested && !state.budget)) {
    return {
      dimension: "budget",
      question: "What budget value and strength are known for this purchase?",
      whyItMatters: `This product costs $${item.price.amount}; a hard ceiling and a target produce different verdicts.`,
      choices: BUDGETS.flatMap((amount) => [
        tokenChoice(`budget-hard-${amount}`, `hard_${amount}`, `$${amount} absolute maximum`, "hard"),
        tokenChoice(`budget-target-${amount}`, `target_${amount}`, `$${amount} preferred target`, "target"),
      ]),
    };
  }
  if (requested === "capability") {
    return {
      dimension: "capability",
      question: "Which capability must this lamp have?",
      whyItMatters: "Capabilities are checked against catalog facts, with missing evidence kept unknown.",
      choices: CAPABILITIES.map((capability) =>
        tokenChoice(`capability-${capability}`, capability.replaceAll("-", "_"), `Must have ${capability}`),
      ),
    };
  }
  if (requested === "finish") {
    return {
      dimension: "finish",
      question: "Is finish a requirement or a preference?",
      whyItMatters: "Strength distinguishes an exclusion from a tradeoff.",
      choices: FINISHES.flatMap((finish) => [
        tokenChoice(`finish-require-${finish}`, `require_${finish}`, `Require ${finish}`, "hard"),
        tokenChoice(`finish-prefer-${finish}`, `prefer_${finish}`, `Prefer ${finish}`, "preference"),
      ]),
    };
  }
  if (requested === "evidence") {
    return {
      dimension: "evidence",
      question: "Should the verdict rely only on catalog facts?",
      whyItMatters: "Seller claims remain attributed and cannot establish a suitable verdict.",
      choices: [
        tokenChoice("evidence-catalog-facts", "catalog_facts_only", "Use catalog facts only"),
      ],
    };
  }
  return null;
}

function includesFact(item, attribute, value) {
  const wanted = value.replaceAll("_", "-").toLowerCase();
  return (item.attributes[attribute] ?? []).some((candidate) => {
    const normalized = candidate.toLowerCase().replaceAll("_", "-");
    return normalized.includes(wanted) || wanted.includes(normalized);
  });
}

function productFit(state, item) {
  const matches = [];
  const hardConflicts = [];
  const softConflicts = [];
  const unknownsThatMatter = [];
  const catalogEvidence = (detail) => ({ kind: "catalog_fact", detail });

  if (state.purpose) {
    const purposes = item.attributes.purposes ?? [];
    if (purposes.includes(state.purpose)) {
      matches.push({ dimension: "purpose", evidence: catalogEvidence(`catalog purpose: ${state.purpose}`) });
    } else {
      hardConflicts.push({
        dimension: "purpose",
        requested: state.purpose,
        actual: purposes,
        evidence: catalogEvidence(`catalog purposes: ${purposes.join(", ") || "none"}`),
      });
    }
  }

  if (state.budget) {
    if (item.price.amount <= state.budget.amount) {
      matches.push({
        dimension: "budget",
        evidence: catalogEvidence(`catalog price $${item.price.amount} within $${state.budget.amount}`),
      });
    } else {
      const conflict = {
        dimension: "budget",
        requested: `max $${state.budget.amount}`,
        actual: item.price.amount,
        evidence: catalogEvidence(`catalog price: $${item.price.amount}`),
      };
      (state.budget.strength === "hard" ? hardConflicts : softConflicts).push(conflict);
    }
  }

  for (const capability of state.capabilities) {
    if (includesFact(item, "features", capability)) {
      matches.push({
        dimension: `capability:${capability}`,
        evidence: catalogEvidence(`catalog feature: ${capability.replaceAll("_", " ")}`),
      });
    } else if (item.notSpecified.some((field) => field.toLowerCase().includes(capability.split("_")[0]))) {
      unknownsThatMatter.push({
        dimension: `capability:${capability}`,
        whyItMatters: `${capability.replaceAll("_", " ")} is not specified in the catalog`,
        evidence: { kind: "unknown", detail: "catalog field not specified" },
      });
    } else {
      hardConflicts.push({
        dimension: `capability:${capability}`,
        requested: capability,
        actual: item.attributes.features ?? [],
        evidence: catalogEvidence("required feature absent from catalog features"),
      });
    }
  }

  if (state.finish) {
    const match = includesFact(item, "colors", state.finish.value);
    if (match) {
      matches.push({ dimension: "finish", evidence: catalogEvidence(`catalog color: ${state.finish.value}`) });
    } else {
      const conflict = {
        dimension: "finish",
        requested: state.finish.value,
        actual: item.attributes.colors ?? [],
        evidence: catalogEvidence("catalog colors"),
      };
      (state.finish.strength === "hard" ? hardConflicts : softConflicts).push(conflict);
    }
  }

  if (state.evidenceThreshold === "catalog_facts_only" && item.sellerClaims.length) {
    unknownsThatMatter.push({
      dimension: "seller_claims",
      whyItMatters: "Seller marketing claims were excluded from the fact-backed verdict.",
      evidence: { kind: "seller_claim", detail: item.sellerClaims[0].claim },
    });
  }

  return {
    itemId: item.id,
    verdict: "unknown",
    matches,
    hardConflicts,
    softConflicts,
    unknownsThatMatter,
  };
}

export const productGraph = createProductExperienceGraph({
  slug: lightingCatalog.category,
  brand: "Fieldnote Supply",
  catalog: productCatalog,
  initialState: () => ({
    requestedDimension: undefined,
    purpose: undefined,
    purposeUnknown: false,
    budget: undefined,
    capabilities: [],
    finish: undefined,
    evidenceThreshold: undefined,
    expressedDimensions: [],
  }),
  applyToken(state, token) {
    const considered = token.match(/^consider-(purpose|budget|capability|finish|evidence)$/);
    if (considered) {
      state.requestedDimension = considered[1];
      return true;
    }
    if (token === "purpose-unknown") {
      state.purposeUnknown = true;
      state.expressedDimensions.push("purpose_unknown");
      return true;
    }
    const purpose = token.match(/^purpose-([a-z0-9-]+)$/);
    if (purpose) {
      state.purpose = purpose[1].replaceAll("-", "_");
      state.expressedDimensions.push("purpose");
      return true;
    }
    const budget = token.match(/^budget-(hard|target)-(\d+)$/);
    if (budget && BUDGETS.includes(Number(budget[2]))) {
      state.budget = { strength: budget[1], amount: Number(budget[2]) };
      state.expressedDimensions.push("budget");
      return true;
    }
    const capability = token.match(/^capability-([a-z0-9-]+)$/);
    if (capability && CAPABILITIES.includes(capability[1])) {
      state.capabilities.push(capability[1].replaceAll("-", "_"));
      state.capabilities = [...new Set(state.capabilities)];
      state.expressedDimensions.push("capability");
      return true;
    }
    const finish = token.match(/^finish-(require|prefer)-([a-z0-9-]+)$/);
    if (finish && FINISHES.includes(finish[2])) {
      state.finish = { strength: finish[1] === "require" ? "hard" : "preference", value: finish[2] };
      state.expressedDimensions.push("finish");
      return true;
    }
    if (token === "evidence-catalog-facts") {
      state.evidenceThreshold = "catalog_facts_only";
      state.expressedDimensions.push("evidence");
      return true;
    }
    return false;
  },
  expressedDimensions: (state) => [...new Set(state.expressedDimensions)],
  hasDecisionInput: (state) =>
    state.expressedDimensions.some((dimension) => dimension !== "purpose_unknown"),
  publicState: (state) => ({
    requestedDimension: state.requestedDimension,
    purpose: state.purpose,
    purposeKnown: Boolean(state.purpose),
    budget: state.budget,
    capabilitiesRequired: state.capabilities,
    finish: state.finish,
    evidenceThreshold: state.evidenceThreshold,
    expressedDimensions: [...new Set(state.expressedDimensions)],
  }),
  nextQuestion: productQuestion,
  edgeGroups: (state) =>
    state.expressedDimensions.length ? [] : [{ ...productAnchorQuestion(), whyItMatters: productAnchorQuestion().whyItMatters }],
  evaluate: productFit,
  alternatives(state, current, catalog) {
    return catalog
      .filter((candidate) => candidate.id !== current.id)
      .map((candidate) => {
        const fit = productFit(state, candidate);
        return {
          itemId: candidate.id,
          utilityScore:
            fit.matches.length * 4 -
            fit.softConflicts.length * 2 -
            fit.hardConflicts.length * 8 -
            fit.unknownsThatMatter.length,
          matches: fit.matches,
          hardConflicts: fit.hardConflicts,
          softConflicts: fit.softConflicts,
          unknownsThatMatter: fit.unknownsThatMatter,
        };
      });
  },
});

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
