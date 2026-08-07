import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EXPERIENCE_PROTOCOLS,
  buildDomainDecisionNode,
  buildDomainItemNode,
  buildDomainNegotiationNode,
  parseDomainNeedTokens,
} from "../dist/experience-graph.js";

const origin = "https://shop.example";
const journeyId = "j-domain-test";
const catalog = [
  {
    id: "cheap-red",
    title: "Cheap Red Chair",
    brand: "Fieldnote",
    category: "chairs",
    price: { amount: 80, currency: "USD" },
    summary: "A compact red chair.",
    attributes: { colors: ["red"] },
    notSpecified: ["weight capacity"],
    sellerClaims: [
      {
        claim: "Exceptionally comfortable",
        attributedTo: "seller_marketing_copy",
        verified: false,
      },
    ],
  },
  {
    id: "blue-premium",
    title: "Blue Premium Chair",
    brand: "Fieldnote",
    category: "chairs",
    price: { amount: 180, currency: "USD" },
    summary: "A premium blue chair.",
    attributes: { colors: ["blue"] },
    notSpecified: [],
    sellerClaims: [],
  },
];

const domain = {
  slug: "chair",
  brand: "Fieldnote",
  entryLabel: "Chairs",
  tagline: "Useful seats.",
  catalog,
  initialState: () => ({ budget: undefined, color: undefined, dimensions: [] }),
  applyToken(state, token) {
    if (token === "budget-hard-100") {
      state.budget = 100;
      state.dimensions.push("budget");
      return true;
    }
    if (token === "color-red" || token === "color-green") {
      state.color = token.slice("color-".length);
      state.dimensions.push("color");
      return true;
    }
    if (token === "purpose-unknown") {
      state.dimensions.push("purpose_unknown");
      return true;
    }
    return false;
  },
  expressedDimensions: (state) => [...new Set(state.dimensions)],
  hasDecisionInput: (state) =>
    state.dimensions.some((dimension) => dimension !== "purpose_unknown"),
  publicState: (state) => ({
    budget: state.budget,
    color: state.color,
    expressedDimensions: [...new Set(state.dimensions)],
  }),
  nextQuestion(state) {
    if (!state.budget && !state.color) {
      return {
        dimension: "decision_anchor",
        question: "What is known?",
        whyItMatters: "A real input is required.",
        choices: [
          { token: "budget-hard-100", value: "budget", meaning: "$100 maximum", strength: "hard" },
          { token: "color-red", value: "red", meaning: "Must be red", strength: "hard" },
        ],
        unknownToken: "purpose-unknown",
      };
    }
    return null;
  },
  edgeGroups(state) {
    return state.color
      ? []
      : [
          {
            dimension: "color",
            whyItMatters: "Color may exclude products.",
            choices: [
              { token: "color-red", value: "red", meaning: "Must be red", strength: "hard" },
              { token: "color-green", value: "green", meaning: "Must be green", strength: "hard" },
            ],
          },
        ];
  },
  evaluate(state) {
    const entries = catalog.map((item) => {
      const violations = [];
      if (state.budget && item.price.amount > state.budget) {
        violations.push({
          dimension: "budget",
          requested: state.budget,
          actual: item.price.amount,
        });
      }
      if (state.color && !item.attributes.colors.includes(state.color)) {
        violations.push({
          dimension: "color",
          requested: state.color,
          actual: item.attributes.colors,
        });
      }
      return {
        itemId: item.id,
        utilityScore: item.id === "cheap-red" ? 10 : 5,
        fitByDimension: [],
        violatedHardConstraints: violations,
      };
    });
    return {
      exact: entries,
      nearMisses: [],
      counterfactuals: [
        { change: "allow_red", effect: "Cheap Red Chair becomes eligible", itemId: "cheap-red" },
      ],
    };
  },
};

test("programmable domain tokens apply and invalid tokens stay visible", () => {
  const parsed = parseDomainNeedTokens(domain, ["budget-hard-100", "bad token", "missing-token"]);
  assert.equal(parsed.state.budget, 100);
  assert.deepEqual(parsed.invalidTokens, ["bad token", "missing-token"]);
});

test("domain negotiation gates ranked results and supplies exact one-hop URLs", () => {
  const empty = buildDomainNegotiationNode(domain, origin, journeyId, []);
  assert.equal(empty.protocol, AGENT_EXPERIENCE_PROTOCOLS.negotiation);
  assert.equal(empty.stage, "decision_input_required");
  assert.equal(empty.resultsUrl, null);
  assert.match(empty.nextQuestion.choices[0].url, /\/budget-hard-100$/);

  const unknown = buildDomainNegotiationNode(domain, origin, journeyId, ["purpose-unknown"]);
  assert.equal(unknown.resultsUrl, null);

  const ready = buildDomainNegotiationNode(domain, origin, journeyId, ["budget-hard-100"]);
  assert.match(ready.resultsUrl, /\/agent-decide\/j-domain-test\/chair\/budget-hard-100$/);
});

test("domain decisions enforce exact and near-miss separation", () => {
  const node = buildDomainDecisionNode(domain, origin, journeyId, ["budget-hard-100"], "search-1");
  assert.equal(node.protocol, AGENT_EXPERIENCE_PROTOCOLS.decision);
  assert.equal(node.exactMatchCount, 1);
  assert.equal(node.exactMatches[0].itemId, "cheap-red");
  assert.equal(node.nearMissCount, 1);
  assert.equal(node.nearMisses[0].itemId, "blue-premium");
  assert.deepEqual(node.counterfactuals, []);
});

test("domain counterfactuals appear only when hard requirements yield zero exact matches", () => {
  const failed = buildDomainDecisionNode(domain, origin, journeyId, ["color-green"], "search-2");
  assert.equal(failed.exactMatchCount, 0);
  assert.equal(failed.counterfactuals.length, 1);
  assert.match(failed.counterfactuals[0].detailUrl, /counterfactual-1/);
});

test("domain item nodes expose v1 item protocol and catalog provenance", () => {
  const node = buildDomainItemNode(domain, origin, "cheap-red", "search-3", 1);
  assert.equal(node.protocol, AGENT_EXPERIENCE_PROTOCOLS.item);
  assert.equal(node.catalog.notSpecified[0], "weight capacity");
  assert.equal(node.sellerClaims[0].verified, false);
});
