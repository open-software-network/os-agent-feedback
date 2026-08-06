import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_EXPERIENCE_PROTOCOLS } from "../dist/experience-graph.js";
import { createProductExperienceGraph } from "../dist/product-graph.js";

const origin = "https://shop.example";
const journeyId = "j-product-test";
const catalog = [
  {
    id: "current",
    title: "Current Lamp",
    brand: "Fieldnote",
    category: "lighting",
    price: { amount: 200, currency: "USD" },
    summary: "The product being evaluated.",
    attributes: { features: ["dimmable"] },
    notSpecified: ["CRI"],
    sellerClaims: [
      {
        claim: "Perfect for precision work",
        attributedTo: "seller_marketing_copy",
        verified: false,
      },
    ],
  },
  {
    id: "alternative",
    title: "Alternative Lamp",
    brand: "Fieldnote",
    category: "lighting",
    price: { amount: 120, currency: "USD" },
    summary: "A fact-backed alternative.",
    attributes: { features: ["dimmable", "high CRI"] },
    notSpecified: [],
    sellerClaims: [],
  },
];

function evidence(kind, detail) {
  return { kind, detail };
}

const graph = createProductExperienceGraph({
  slug: "lamp",
  brand: "Fieldnote",
  catalog,
  initialState: () => ({ mode: undefined, dimensions: [] }),
  applyToken(state, token) {
    if (!token.startsWith("need-")) return false;
    const mode = token.slice("need-".length);
    if (!["fact", "seller", "hard", "soft", "unknown"].includes(mode)) return false;
    state.mode = mode;
    state.dimensions.push("need");
    return true;
  },
  expressedDimensions: (state) => [...new Set(state.dimensions)],
  hasDecisionInput: (state) => state.dimensions.length > 0,
  publicState: (state) => ({ mode: state.mode, expressedDimensions: state.dimensions }),
  nextQuestion(state) {
    if (state.mode) return null;
    return {
      dimension: "need",
      question: "What evidence applies?",
      whyItMatters: "The evidence kind changes the verdict.",
      choices: [
        { token: "need-fact", value: "fact", meaning: "Use catalog facts" },
        { token: "need-seller", value: "seller", meaning: "Only a seller claim exists" },
        { token: "need-hard", value: "hard", meaning: "There is a hard conflict" },
        { token: "need-soft", value: "soft", meaning: "There is a soft conflict" },
        { token: "need-unknown", value: "unknown", meaning: "No decisive evidence exists" },
      ],
    };
  },
  evaluate(state, item) {
    const base = {
      itemId: item.id,
      verdict: "suitable",
      matches: [],
      hardConflicts: [],
      softConflicts: [],
      unknownsThatMatter: [],
    };
    if (state.mode === "fact") {
      base.matches.push({
        dimension: "dimming",
        evidence: evidence("catalog_fact", "feature: dimmable"),
      });
    } else if (state.mode === "seller") {
      base.matches.push({
        dimension: "precision",
        evidence: evidence("seller_claim", "seller says precision-ready"),
      });
    } else if (state.mode === "hard") {
      base.hardConflicts.push({
        dimension: "budget",
        requested: 100,
        actual: item.price.amount,
        evidence: evidence("catalog_fact", "catalog price"),
      });
    } else if (state.mode === "soft") {
      base.softConflicts.push({
        dimension: "finish",
        requested: "black",
        actual: [],
        evidence: evidence("catalog_fact", "catalog colors"),
      });
    }
    return base;
  },
  alternatives(_state, _item, records) {
    return records.map((record) => ({
      itemId: record.id,
      utilityScore: record.id === "alternative" ? 10 : 0,
      matches:
        record.id === "alternative"
          ? [{ dimension: "price", evidence: evidence("catalog_fact", "catalog price: $120") }]
          : [],
      hardConflicts: [],
      softConflicts: [],
      unknownsThatMatter: [],
    }));
  },
});

function options(tokens = []) {
  return { origin, journeyId, itemId: "current", tokens, searchId: "search-product" };
}

test("product graph applies domain tokens and gates evaluation", () => {
  const parsed = graph.parseProductNeedTokens(["need-fact", "bad token", "missing"]);
  assert.equal(parsed.state.mode, "fact");
  assert.deepEqual(parsed.invalidTokens, ["bad token", "missing"]);

  const empty = graph.buildProductGraph(options());
  assert.equal(empty.protocol, AGENT_EXPERIENCE_PROTOCOLS.product);
  assert.equal(empty.stage, "decision_input_required");
  assert.equal(empty.evaluateFitUrl, null);
  assert.match(empty.nextQuestion.choices[0].url, /\/need-fact$/);

  const ready = graph.buildProductGraph(options(["need-fact"]));
  assert.match(ready.evaluateFitUrl, /\/need-fact\/evaluate-fit$/);
});

test("product fit derives suitable, partial, unsuitable, and unknown verdicts", () => {
  const suitable = graph.buildProductFit(options(["need-fact"]));
  const seller = graph.buildProductFit(options(["need-seller"]));
  const hard = graph.buildProductFit(options(["need-hard"]));
  const soft = graph.buildProductFit(options(["need-soft"]));
  const unknown = graph.buildProductFit(options(["need-unknown"]));

  assert.equal(suitable.protocol, AGENT_EXPERIENCE_PROTOCOLS.productFit);
  assert.equal(suitable.itemFit.verdict, "suitable");
  assert.equal(hard.itemFit.verdict, "unsuitable");
  assert.equal(soft.itemFit.verdict, "partial");
  assert.equal(unknown.itemFit.verdict, "unknown");
  assert.equal(seller.itemFit.verdict, "partial");
  assert.equal(seller.itemFit.matches[0].evidence.kind, "seller_claim");
  assert.equal(suitable.itemFit.matches[0].evidence.kind, "catalog_fact");
});

test("alternatives are exposed only after a non-suitable verdict", () => {
  const suitableFit = graph.buildProductFit(options(["need-fact"]));
  assert.equal(suitableFit.alternativesUrl, undefined);

  const refused = graph.buildProductAlternatives(options(["need-fact"]));
  assert.equal(refused.error, "alternatives_not_applicable");

  const partialFit = graph.buildProductFit(options(["need-soft"]));
  assert.match(partialFit.alternativesUrl, /\/alternatives$/);
  const alternatives = graph.buildProductAlternatives(options(["need-soft"]));
  assert.equal(alternatives.protocol, AGENT_EXPERIENCE_PROTOCOLS.productAlternatives);
  assert.equal(alternatives.alternativeCount, 1);
  assert.equal(alternatives.alternatives[0].itemId, "alternative");
  assert.equal(alternatives.alternatives[0].matches[0].evidence.kind, "catalog_fact");
});

test("product fit refuses a verdict before decision input", () => {
  const fit = graph.buildProductFit(options());
  assert.equal(fit.error, "decision_input_required");
  assert.equal(fit.itemFit, undefined);
});

test("product nodes map to telemetry payloads with their evaluate stages", async () => {
  const { experienceTelemetryForNode } = await import("../dist/experience-graph.js");
  const bare = graph.buildProductGraph({ origin, journeyId, itemId: "current", tokens: [] });
  assert.equal(experienceTelemetryForNode(bare).stage, "decision_input_required");
  const ready = graph.buildProductGraph({
    origin,
    journeyId,
    itemId: "current",
    tokens: ["need-fact"],
  });
  assert.equal(experienceTelemetryForNode(ready).stage, "ready_to_evaluate");
});
