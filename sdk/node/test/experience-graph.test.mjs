import assert from "node:assert/strict";
import test from "node:test";
import { AgentFeedbackRuntime } from "../dist/core.js";
import {
  createExperienceGraph,
  createLightingExperienceCatalog,
  experienceTelemetryDetails,
  hasDecisionInput,
  isValidJourneyId,
  parseNeedTokens,
  productLinkClickTelemetryDetails,
} from "../dist/experience-graph.js";

const origin = "http://localhost:4311";
const journeyId = "j-00000000-0000-4000-8000-000000000000";
const graph = createExperienceGraph(createLightingExperienceCatalog());

test("journey ids and need tokens are tightly validated", () => {
  assert.equal(isValidJourneyId(journeyId), true);
  assert.equal(isValidJourneyId("journey_1"), false);
  const parsed = parseNeedTokens(graph.definition, [
    "consider-budget",
    "budget-hard-150",
    "purpose-coding",
    "color-prefer-orange",
    "not a token",
  ]);
  assert.deepEqual(parsed.invalidTokens, ["not a token"]);
  assert.equal(parsed.state.values.budget?.value, "150");
  assert.equal(parsed.state.values.budget?.strength, "hard");
  assert.equal(parsed.state.values.purpose?.value, "coding");
  assert.equal(parsed.state.values.color?.strength, "preference");
});

test("a product link click separates first-party identity from request traits", () => {
  const details = productLinkClickTelemetryDetails({
    operation: "/attributed-product-visit/petsmart",
    sessionRef: journeyId,
    anonymousRef: "s-first-party-browser",
    requestObservation: {
      clientIp: "203.0.113.10",
      method: "GET",
      userAgent: "Mozilla/5.0 Browser",
    },
  });
  assert.equal(details.surface, "http_html");
  assert.equal(details.customerLinkSource, "product_link_click");
  assert.equal(details.sessionRef, journeyId);
  assert.equal(details.anonymousRef, "s-first-party-browser");
  assert.deepEqual(details.requestObservation, {
    clientIp: "203.0.113.10",
    method: "GET",
    userAgent: "Mozilla/5.0 Browser",
  });
});

test("negotiation starts with generic dimensions and withholds results", () => {
  const node = graph.buildNegotiation({ origin, journeyId, tokens: [] });
  assert.equal(node.stage, "decision_input_required");
  assert.equal(node.nextQuestion?.dimension, "decision_anchor");
  assert.equal(node.resultsUrl, null);
  assert.equal(node.sufficiency.sufficientForResults, false);
  assert.ok(
    node.availableNeedEdges[0].choices.every((choice) => choice.token.startsWith("consider-")),
  );
});

test("purpose-unknown alone is not enough for ranked results", () => {
  const node = graph.buildNegotiation({
    origin,
    journeyId,
    tokens: ["purpose-unknown"],
  });
  assert.equal(node.stage, "decision_input_required");
  assert.equal(node.resultsUrl, null);
  assert.equal(hasDecisionInput(graph.definition, node.needState), false);
});

test("negotiation progressively captures budget, purpose, color, and priority", () => {
  let node = graph.buildNegotiation({ origin, journeyId, tokens: ["consider-budget"] });
  assert.equal(node.needState.requestedDimension, "budget");
  assert.equal(node.nextQuestion?.dimension, "budget");

  node = graph.buildNegotiation({
    origin,
    journeyId,
    tokens: ["budget-hard-150"],
  });
  assert.equal(node.stage, "express_more_or_decide");
  assert.match(node.resultsUrl ?? "", /\/agent-decide\//);
  assert.equal(node.needState.values.budget?.strength, "hard");

  node = graph.buildNegotiation({
    origin,
    journeyId,
    tokens: ["budget-hard-150", "purpose-coding", "color-prefer-orange", "priority-price"],
  });
  assert.equal(node.needState.values.purpose?.value, "coding");
  assert.equal(node.needState.values.color?.value, "orange");
  assert.equal(node.needState.values.priority?.value, "price");
  assert.ok(
    node.resultsUrl?.includes("budget-hard-150/purpose-coding/color-prefer-orange/priority-price"),
  );
});

test("decision support refuses results before one decision input exists", () => {
  const decision = graph.buildDecision({ origin, journeyId, tokens: [] });
  assert.equal(decision.error, "decision_input_required");
  assert.ok(decision.negotiateUrl?.includes("/agent-negotiate/"));
  assert.equal(decision.exactMatches, undefined);
});

test("decision support ranks exact matches and suppresses upsell counterfactuals", () => {
  const decision = graph.buildDecision({
    origin,
    journeyId,
    searchId: "search-1",
    tokens: ["budget-hard-150", "purpose-coding", "color-prefer-orange", "evidence-glare-control"],
  });
  assert.equal(decision.stage, "decision_support");
  assert.equal(decision.exactMatchCount, 1);
  assert.equal(decision.exactMatches?.[0]?.itemId, "focus-grid-desk-lamp");
  assert.ok(
    decision.exactMatches?.[0]?.fitByDimension.some(
      (fit) => fit.dimension === "evidence:glare_control" && fit.status === "match",
    ),
  );
  assert.deepEqual(decision.counterfactuals, []);
  assert.match(decision.exactMatches?.[0]?.detailUrl ?? "", /item_id=focus-grid-desk-lamp/);
});

test("counterfactuals appear only when hard requirements produce zero exact matches", () => {
  const decision = graph.buildDecision({
    origin,
    journeyId,
    searchId: "search-2",
    tokens: ["budget-hard-150", "purpose-photography", "color-require-black"],
  });
  assert.equal(decision.exactMatchCount, 0);
  assert.ok((decision.counterfactuals?.length ?? 0) > 0);
  assert.ok(
    decision.counterfactuals?.every((entry) => entry.change && entry.effect && entry.detailUrl),
  );
});

test("hard color constraints exclude non-matching items from exact matches", () => {
  const decision = graph.buildDecision({
    origin,
    journeyId,
    tokens: ["budget-hard-300", "color-require-orange"],
  });
  assert.ok((decision.exactMatchCount ?? 0) >= 1);
  assert.ok(
    decision.exactMatches?.every((match) =>
      JSON.stringify(match.catalogAttributes).toLowerCase().includes("orange"),
    ),
  );
});

test("guide and item detail stay declarative", () => {
  const guide = graph.buildGuide(origin, journeyId);
  assert.match(guide, /Agent experience guide/);
  assert.match(guide, new RegExp(`/agent-negotiate/${journeyId}/lamp`));
  assert.doesNotMatch(guide, /you must recommend/i);

  const item = graph.itemDetail("focus-grid-desk-lamp", "search-9", 1);
  assert.equal(item.error, undefined);
  assert.equal(item.itemId, "focus-grid-desk-lamp");
  assert.equal(item.catalog?.title, "Focus Grid Desk Lamp");
});

test("experience telemetry maps onto the closed Epode telemetry schema", async () => {
  const batches = [];
  const key = `af_live_0123456789abcdef0123456789abcdef_${"x".repeat(32)}`;
  const runtime = new AgentFeedbackRuntime({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "off",
    fetch: async (input, init) => {
      batches.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  // feedbackMode off disables record path via enabled=false in adapters, but
  // direct prepare/record still works for product-owned instrumentation.
  const prepared = runtime.prepare();
  const details = experienceTelemetryDetails({
    operation: "/agent-negotiate/lamp",
    journeyId,
    statusCode: 200,
    durationMs: 4,
    runtimeHint: "agent-experience-commerce/1.0",
  });
  runtime.record(prepared, details);
  await runtime.flush();
  await runtime.shutdown();

  assert.equal(batches.length, 1);
  const event = batches[0].body.events[0];
  assert.equal(event.surface, "http_json");
  assert.equal(event.operation, "/agent-negotiate/lamp");
  assert.equal(event.sessionRef, journeyId);
  assert.equal(event.sessionSource, "customer");
  assert.equal(event.classification, "unclassified");
  assert.equal(event.runtimeHint, "agent-experience-commerce/1.0");
  assert.equal(event.runtimeHintSource, "http");
  // Closed schema: no free-form need-state blob.
  assert.equal(Object.hasOwn(event, "needState"), false);
});

const overBudgetGraph = createExperienceGraph({
  category: "chair",
  dimensions: [
    {
      key: "budget",
      kind: "budget",
      question: "What budget value and strength are known for this purchase?",
      whyItMatters: "A hard ceiling excludes products.",
      anchorMeaning: "A budget ceiling is known",
      choices: [
        {
          token: "budget-hard-100",
          value: "100",
          meaning: "$100 absolute maximum",
          strength: "hard",
        },
      ],
    },
  ],
  items: [
    {
      id: "everyday-chair",
      title: "Everyday Chair",
      brand: "Fieldnote",
      price: { amount: 158, currency: "USD" },
    },
    {
      id: "luxe-chair",
      title: "Luxe Chair",
      brand: "Fieldnote",
      price: { amount: 250, currency: "USD" },
    },
  ],
});

test("experienceTelemetryForNode maps decision quality into the aggregate-safe payload", async () => {
  const { experienceTelemetryForNode } = await import("../dist/experience-graph.js");
  const node = overBudgetGraph.buildDecision({
    origin,
    journeyId,
    tokens: ["budget-hard-100"],
    searchId: "search-experience",
  });
  const payload = experienceTelemetryForNode(node);
  assert.equal(payload.stage, "decision_support");
  assert.deepEqual(payload.needState.expressedDimensions, ["budget"]);
  assert.equal(payload.needState.unknownDimensions, undefined);
  assert.equal(payload.decision.exactMatchCount, 0);
  assert.equal(payload.decision.nearMissCount, 2);
  assert.equal(payload.decision.violatedHardConstraints.length, 2);
  for (const violation of payload.decision.violatedHardConstraints) {
    assert.equal(violation.dimension, "budget");
    assert.ok(violation.itemId);
    assert.ok(violation.requested.length <= 120);
    assert.ok(violation.actual.length <= 120);
  }
  const [counterfactual] = payload.decision.counterfactuals;
  assert.match(counterfactual.change, /raise_budget_from_100_to_158/);
  assert.equal(counterfactual.delta, 58);
});

test("experienceTelemetryForNode reports explicit unknowns without leaking values", async () => {
  const { experienceTelemetryForNode } = await import("../dist/experience-graph.js");
  const node = graph.buildNegotiation({ origin, journeyId, tokens: ["purpose-unknown"] });
  const payload = experienceTelemetryForNode(node);
  assert.equal(payload.stage, "decision_input_required");
  assert.deepEqual(payload.needState.unknownDimensions, ["purpose"]);
  assert.equal(payload.needState.expressedDimensions, undefined);
  assert.equal(payload.decision, undefined);
});

test("experienceTelemetryForNode keeps only numeric search positions", async () => {
  const { experienceTelemetryForNode } = await import("../dist/experience-graph.js");
  const ranked = experienceTelemetryForNode(
    graph.itemDetail("halo-portable-lamp", "search-9", "2"),
  );
  assert.deepEqual(ranked.search, { searchId: "search-9", resultPosition: 2 });
  const nearMiss = experienceTelemetryForNode(
    graph.itemDetail("halo-portable-lamp", "search-9", "near-1"),
  );
  assert.deepEqual(nearMiss.search, { searchId: "search-9" });
  assert.equal(experienceTelemetryForNode(null), undefined);
  assert.equal(experienceTelemetryForNode({}), undefined);
});

test("experience payloads ride telemetry events end to end", async () => {
  const batches = [];
  const runtime = new AgentFeedbackRuntime({
    apiKey: "af_live_0123456789abcdef0123456789abcdef_secretsecretsecretsecretsecretse",
    endpoint: "https://collector.example",
    feedbackMode: "never_ask",
    fetch: async (input, init) => {
      batches.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  const { experienceTelemetryForNode } = await import("../dist/experience-graph.js");
  const node = overBudgetGraph.buildDecision({
    origin,
    journeyId,
    tokens: ["budget-hard-100"],
    searchId: "search-experience",
  });
  runtime.record(
    runtime.prepare(),
    experienceTelemetryDetails({
      operation: node.operation,
      journeyId,
      statusCode: 200,
      experience: experienceTelemetryForNode(node),
    }),
  );
  await runtime.flush();
  await runtime.shutdown();
  assert.equal(batches.length, 1);
  const event = batches[0].body.events[0];
  assert.equal(event.experience.decision.exactMatchCount, 0);
  assert.equal(event.experience.decision.counterfactuals[0].delta, 58);
  assert.deepEqual(event.experience.needState.expressedDimensions, ["budget"]);
});
