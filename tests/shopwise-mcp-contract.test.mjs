import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SHOPWISE_HARNESS_BOUNDARIES,
  ShopwiseMcpError,
  ShopwiseMcpExample,
} from "../examples/customer-context-scenarios/shopwise-mcp.js";

const realisticContext = () => ({
  size: "10",
  width: "wide",
  colors: { preferred: ["Black", "Graphite"], excluded: ["Neon Lime"] },
  useCase: "Daily Road Running",
  budget: { currency: "USD", max: 140 },
  features: {
    required: ["Roomy Toe Box"],
    excluded: ["Trail Outsole"],
  },
  brands: { preferred: [], excluded: ["Northstar"] },
});

test("Shopwise exposes one atomic business tool with full bounded context", () => {
  const server = new ShopwiseMcpExample();
  const tools = server.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search_catalog"],
  );
  assert.equal(
    tools.some((tool) => tool.name === "share_customer_context"),
    false,
  );
  assert.equal(
    tools.some((tool) => tool.name === "begin_task"),
    false,
  );
  assert.equal(SHOPWISE_HARNESS_BOUNDARIES.shareCustomerContextRequired, false);

  const shopper = tools[0].inputSchema.properties.shopperContext;
  assert.deepEqual(shopper.required, ["size", "width", "colors", "useCase", "budget", "features"]);
  assert.equal(shopper.additionalProperties, false);
  assert.equal(shopper.properties.colors.properties.excluded.type, "array");
  assert.equal(shopper.properties.features.properties.excluded.type, "array");
});

test("one search call returns results, exact receipts, and explicit data-use state", () => {
  const server = new ShopwiseMcpExample();
  const receivedContext = realisticContext();
  const result = server.callTool(
    "search_catalog",
    { shopperContext: receivedContext },
    { sessionId: "fresh-session" },
  ).structuredContent;

  assert.equal(server.auditTrail().length, 1);
  assert.deepEqual(result.receivedContext, receivedContext);
  assert.deepEqual(result.appliedContext, {
    size: "10",
    width: "wide",
    colors: { preferred: ["black", "graphite"], excluded: ["neon lime"] },
    useCase: "daily road running",
    budget: { currency: "USD", max: 140 },
    features: { required: ["roomy toe box"], excluded: ["trail outsole"] },
    brands: { preferred: [], excluded: ["northstar"] },
  });
  assert.deepEqual(
    result.matches.map((item) => item.id),
    ["harbor-run-2e"],
  );
  assert.equal(result.contextReceipt.usedEveryAcceptedField, true);
  assert.deepEqual(result.contextReceipt.ignoredFields, []);
  assert.deepEqual(result.dataUse, {
    personalization: "task_context_only",
    scope: "current_tool_call",
    retention: "none",
    expiresInSeconds: 0,
    savedToProfile: false,
    assistantMemoryImported: false,
    identityMode: "standard",
  });
});

test("the single call exposes per-field match traces and applies exclusions", () => {
  const server = new ShopwiseMcpExample();
  const searched = server.callTool(
    "search_catalog",
    { shopperContext: realisticContext() },
    { sessionId: "shopping-session" },
  ).structuredContent;

  const canyon = searched.matchTrace.find((item) => item.productId === "canyon-cloud-wide");
  assert.equal(canyon.checks.size, true);
  assert.equal(canyon.checks.width, true);
  assert.equal(canyon.checks.excludedFeatures, false);
  const northstar = searched.matchTrace.find((item) => item.productId === "northstar-flash");
  assert.equal(northstar.checks.color, false);
  assert.equal(northstar.checks.excludedBrand, false);
});

test("unsupported context fails instead of enabling an agent to claim it was used", () => {
  const server = new ShopwiseMcpExample();
  assert.throws(
    () =>
      server.callTool(
        "search_catalog",
        { shopperContext: { ...realisticContext(), medicalHistory: "never transmit" } },
        { sessionId: "fresh-session" },
      ),
    (error) =>
      error instanceof ShopwiseMcpError &&
      error.code === "UNSUPPORTED_CONTEXT" &&
      /medicalHistory/.test(error.message),
  );
});

test("fresh and incognito calls retain no reusable cross-session context", () => {
  const server = new ShopwiseMcpExample();
  const standard = server.callTool(
    "search_catalog",
    { shopperContext: realisticContext() },
    { sessionId: "standard-1" },
  ).structuredContent;
  const incognito = server.callTool(
    "search_catalog",
    { shopperContext: realisticContext() },
    { sessionId: "incognito-1", incognito: true },
  ).structuredContent;

  assert.equal(standard.dataUse.identityMode, "standard");
  assert.equal(incognito.dataUse.identityMode, "incognito");
  assert.equal(standard.dataUse.retention, "none");
  assert.equal(incognito.dataUse.retention, "none");
  assert.equal("contextId" in standard.contextReceipt, false);
  assert.deepEqual(
    server.auditTrail().map((event) => event.sessionId),
    ["standard-1", "incognito-1"],
  );
});

test("a denied host tool call sends nothing to the Shopwise server", () => {
  const server = new ShopwiseMcpExample();
  const harnessDecision = "deny";
  if (harnessDecision !== "deny") {
    server.callTool(
      "search_catalog",
      { shopperContext: realisticContext() },
      { sessionId: "denied-session" },
    );
  }
  assert.deepEqual(server.auditTrail(), []);
  assert.equal(SHOPWISE_HARNESS_BOUNDARIES.toolApproval, "host_owned");
});

test("one server call caps server-triggered host approval opportunities at one", async () => {
  const server = new ShopwiseMcpExample();
  const readme = await readFile(
    new URL("../examples/customer-context-scenarios/README.md", import.meta.url),
    "utf8",
  );
  assert.equal(server.listTools().length, 1);
  server.callTool(
    "search_catalog",
    { shopperContext: realisticContext() },
    { sessionId: "single-approval-opportunity" },
  );
  assert.equal(server.auditTrail().length, 1);
  assert.match(readme, /Possible host approvals/);
  assert.match(readme, /Hardened `search_catalog\(\{ shopperContext \}\)` \| one/);
  assert.match(SHOPWISE_HARNESS_BOUNDARIES.approvalCadence, /per tool call/);
});
