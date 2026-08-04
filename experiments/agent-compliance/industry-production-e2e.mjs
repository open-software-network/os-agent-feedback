#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { INDUSTRY_E2E_PRODUCTS } from "./industry-e2e-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const PRODUCTION_ENDPOINT = "https://api.epode.ai";
let requestSequence = 0;

function context({ identity, sessionRef, runtimeHint, inputResponses } = {}) {
  return {
    identity,
    productSession: sessionRef,
    runtimeHint,
    mcpReq: {
      id: ++requestSequence,
      method: "tools/call",
      requestState: () => undefined,
      signal: new AbortController().signal,
      envelope: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {
          elicitation: { form: {} },
        },
      },
      ...(inputResponses ? { inputResponses } : {}),
    },
  };
}

function callTool(server, name, arguments_, invocationContext) {
  const handler = server.server._requestHandlers.get("tools/call");
  assert.equal(typeof handler, "function", "MCP server did not register tools/call");
  return handler(
    {
      method: "tools/call",
      params: {
        name,
        arguments: arguments_ || {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "epode-industry-production-simulation",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
        },
      },
    },
    invocationContext,
  );
}

function contractFrom(result) {
  const contract = result?.structuredContent?._epode?.customerContext;
  assert.ok(contract, "business tool result did not include an Epode customer-context contract");
  return contract;
}

function identity(runId, slug, scenario, user = "user-1") {
  return {
    accountRef: `sim-${runId}-${slug}-${scenario}-account`,
    userRef: `sim-${runId}-${slug}-${scenario}-${user}`,
  };
}

function session(runId, slug, scenario, index) {
  return `sim-${runId}-${slug}-${scenario}-${index}`;
}

function runtime(index) {
  return [
    "simulation/claude-desktop",
    "simulation/chatgpt-desktop",
    "simulation/codex-cli",
  ][index % 3];
}

async function loadMcpDependencies() {
  const sdkUrl = pathToFileURL(join(repo, "sdk/node/dist/customer-mcp.js")).href;
  const sdk = await import(sdkUrl);
  const require = createRequire(join(repo, "sdk/node/package.json"));
  const packageEntry = require.resolve("@modelcontextprotocol/server");
  const { McpServer } = await import(pathToFileURL(packageEntry).href);
  return { epode: sdk.epode, McpServer };
}

function publicBusinessResult(product, query, contextItems = []) {
  return {
    product: product.productName,
    operation: product.actionTool,
    queryShape: Object.keys(query).sort(),
    resultCount: 2,
    personalizedWith: contextItems.map((entry) => entry.key),
  };
}

async function createServer({ product, apiKey, endpoint, dependencies, logger }) {
  const decisions = [];
  const customer = dependencies.epode({
    apiKey,
    endpoint,
    timeoutMs: 5_000,
    relayTimeoutMs: 10_000,
    includeTools: [product.actionTool],
    identify: (_arguments, invocationContext) => invocationContext.identity,
    sessionRef: (invocationContext) => invocationContext.productSession,
    runtimeHint: (invocationContext) => invocationContext.runtimeHint,
    logger,
  });
  const server = new dependencies.McpServer({
    name: `${product.slug}-production-simulation`,
    version: "1.0.0",
  });
  server.server._negotiatedProtocolVersion = "2026-07-28";
  customer.instrument(server);
  server.registerTool(product.actionTool, { inputSchema: {} }, async (query, invocationContext) => {
    const current = await customer.context.get({
      ...invocationContext.identity,
      purpose: "product_personalization",
    });
    const result = publicBusinessResult(product, query, current.available ? current.items : []);
    if (current.available && current.items.length) {
      const decision = await customer.personalization.decide({
        externalDecisionId: `sim-${product.slug}-${randomUUID()}`,
        contextRetrievalId: current.retrievalId,
        signalIds: current.items.map((entry) => entry.signalId),
        variant: product.variant,
      });
      if (decision.recorded) decisions.push(decision.decision);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  });
  return { server, customer, decisions };
}

async function share({ server, contract, choice, items, identity: customerIdentity, sessionRef, runtimeHint, status = "answered" }) {
  const arguments_ = {
    requestHandle: contract.requestHandle,
    status,
    items: status === "answered" ? items : [],
  };
  const initial = await callTool(
    server,
    "share_customer_context",
    arguments_,
    context({ identity: customerIdentity, sessionRef, runtimeHint }),
  );
  if (contract.state !== "consent_required") return initial;
  assert.equal(initial.resultType, "input_required");
  return callTool(
    server,
    "share_customer_context",
    arguments_,
    context({
      identity: customerIdentity,
      sessionRef,
      runtimeHint,
      inputResponses: {
        customer_context_permission: {
          action: choice === "dont_allow" ? "decline" : "accept",
          content: { choice },
        },
      },
    }),
  );
}

async function business({ server, product, identity: customerIdentity, sessionRef, runtimeHint }) {
  const result = await callTool(
    server,
    product.actionTool,
    product.query,
    context({ identity: customerIdentity, sessionRef, runtimeHint }),
  );
  assert.equal(result.structuredContent.operation, product.actionTool);
  return { result, contract: contractFrom(result) };
}

async function recordOutcome(customer, decision, suffix) {
  if (!decision) return null;
  const outcome = await customer.outcomes.track({
    externalOutcomeId: `sim-${suffix}-${randomUUID()}`,
    decisionId: decision.id,
    outcome: "completion",
  });
  assert.equal(outcome.recorded, true);
  return outcome.outcome.id;
}

export async function runIndustryProduct({ product, apiKey, endpoint, runId, dependencies, logger }) {
  const { server, customer, decisions } = await createServer({
    product,
    apiKey,
    endpoint,
    dependencies,
    logger,
  });
  const questions = [];
  const sessions = [];
  const customers = [];

  const rememberedIdentity = identity(runId, product.slug, "remembered");
  customers.push(rememberedIdentity.userRef);
  const rememberedSession1 = session(runId, product.slug, "remembered", 1);
  sessions.push(rememberedSession1);
  const rememberedFirst = await business({
    server,
    product,
    identity: rememberedIdentity,
    sessionRef: rememberedSession1,
    runtimeHint: runtime(0),
  });
  questions.push(rememberedFirst.contract.question);
  assert.equal(rememberedFirst.contract.state, "consent_required");
  const rememberedShare = await share({
    server,
    contract: rememberedFirst.contract,
    choice: "always_allow",
    items: product.rememberedItems,
    identity: rememberedIdentity,
    sessionRef: rememberedSession1,
    runtimeHint: runtime(0),
  });
  assert.equal(rememberedShare.isError, false);
  assert.equal(rememberedShare.structuredContent.signals.length, product.rememberedItems.length);

  const rememberedContext = await customer.context.get({
    ...rememberedIdentity,
    purpose: "product_personalization",
  });
  assert.equal(rememberedContext.available, true);
  assert.equal(rememberedContext.items.length, product.rememberedItems.length);
  const rememberedDecision = await customer.personalization.decide({
    externalDecisionId: `sim-${runId}-${product.slug}-remembered-first`,
    contextRetrievalId: rememberedContext.retrievalId,
    signalIds: rememberedContext.items.map((entry) => entry.signalId),
    variant: product.variant,
  });
  assert.equal(rememberedDecision.recorded, true);
  const firstOutcomeId = await recordOutcome(
    customer,
    rememberedDecision.decision,
    `${runId}-${product.slug}-remembered-first`,
  );

  const rememberedSession2 = session(runId, product.slug, "remembered", 2);
  sessions.push(rememberedSession2);
  const rememberedSecond = await business({
    server,
    product,
    identity: rememberedIdentity,
    sessionRef: rememberedSession2,
    runtimeHint: runtime(1),
  });
  assert.equal(rememberedSecond.contract.state, "answer_ready");
  const followup = await share({
    server,
    contract: rememberedSecond.contract,
    choice: "always_allow",
    items: product.followupItems,
    identity: rememberedIdentity,
    sessionRef: rememberedSession2,
    runtimeHint: runtime(1),
  });
  assert.equal(followup.isError, false);
  const rememberedAgain = await customer.context.get({
    ...rememberedIdentity,
    purpose: "product_personalization",
  });
  assert.equal(rememberedAgain.available, true);
  assert.ok(rememberedAgain.items.length >= product.rememberedItems.length);

  const sessionIdentity = identity(runId, product.slug, "session-only");
  customers.push(sessionIdentity.userRef);
  const sessionOnlyRef = session(runId, product.slug, "session-only", 1);
  sessions.push(sessionOnlyRef);
  const sessionOnlyBusiness = await business({
    server,
    product,
    identity: sessionIdentity,
    sessionRef: sessionOnlyRef,
    runtimeHint: runtime(2),
  });
  questions.push(sessionOnlyBusiness.contract.question);
  const sessionOnlyShare = await share({
    server,
    contract: sessionOnlyBusiness.contract,
    choice: "this_session_only",
    items: product.sessionItems,
    identity: sessionIdentity,
    sessionRef: sessionOnlyRef,
    runtimeHint: runtime(2),
  });
  assert.equal(sessionOnlyShare.isError, false);
  assert.ok(sessionOnlyShare.structuredContent.signals.every((entry) => entry.remembered === false));
  const stableAfterSession = await customer.context.get({
    ...sessionIdentity,
    purpose: "product_personalization",
  });
  assert.deepEqual(stableAfterSession.items, []);
  const interactionContext = await customer.context.get({
    ...sessionIdentity,
    interactionId: sessionOnlyBusiness.contract.interactionId,
    purpose: "product_personalization",
  });
  assert.equal(interactionContext.available, true);
  assert.equal(interactionContext.items.length, product.sessionItems.length);

  const declineIdentity = identity(runId, product.slug, "declined");
  customers.push(declineIdentity.userRef);
  const declineSession1 = session(runId, product.slug, "declined", 1);
  sessions.push(declineSession1);
  const declineBusiness = await business({
    server,
    product,
    identity: declineIdentity,
    sessionRef: declineSession1,
    runtimeHint: runtime(0),
  });
  questions.push(declineBusiness.contract.question);
  const declined = await share({
    server,
    contract: declineBusiness.contract,
    choice: "dont_allow",
    items: product.rememberedItems,
    identity: declineIdentity,
    sessionRef: declineSession1,
    runtimeHint: runtime(0),
  });
  assert.equal(declined.structuredContent.state, "declined");
  const declineSession2 = session(runId, product.slug, "declined", 2);
  sessions.push(declineSession2);
  const declineAgain = await business({
    server,
    product,
    identity: declineIdentity,
    sessionRef: declineSession2,
    runtimeHint: runtime(1),
  });
  assert.equal(declineAgain.contract.state, "declined");

  const noContextIdentity = identity(runId, product.slug, "no-context");
  customers.push(noContextIdentity.userRef);
  const noContextSession = session(runId, product.slug, "no-context", 1);
  sessions.push(noContextSession);
  const noContextBusiness = await business({
    server,
    product,
    identity: noContextIdentity,
    sessionRef: noContextSession,
    runtimeHint: runtime(1),
  });
  questions.push(noContextBusiness.contract.question);
  const noContext = await share({
    server,
    contract: noContextBusiness.contract,
    choice: "always_allow",
    items: [],
    status: "no_relevant_context",
    identity: noContextIdentity,
    sessionRef: noContextSession,
    runtimeHint: runtime(1),
  });
  assert.equal(noContext.isError, false);
  assert.equal(noContext.structuredContent.signals.length, 0);

  const rejectedIdentity = identity(runId, product.slug, "rejected");
  customers.push(rejectedIdentity.userRef);
  const rejectedSession = session(runId, product.slug, "rejected", 1);
  sessions.push(rejectedSession);
  const rejectedBusiness = await business({
    server,
    product,
    identity: rejectedIdentity,
    sessionRef: rejectedSession,
    runtimeHint: runtime(2),
  });
  questions.push(rejectedBusiness.contract.question);
  const rejected = await share({
    server,
    contract: rejectedBusiness.contract,
    choice: "always_allow",
    items: [product.rejectedItem],
    identity: rejectedIdentity,
    sessionRef: rejectedSession,
    runtimeHint: runtime(2),
  });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.structuredContent.error), /catalog|unknown|sensitive/i);
  const rejectedContext = await customer.context.get({
    ...rejectedIdentity,
    purpose: "product_personalization",
  });
  assert.deepEqual(rejectedContext.items, []);

  return {
    slug: product.slug,
    productName: product.productName,
    customerRefs: customers,
    sessionRefs: sessions,
    questionCount: questions.filter(Boolean).length,
    questions: [...new Set(questions.filter(Boolean))],
    answerItems: [...product.rememberedItems, ...product.followupItems, ...product.sessionItems].map(
      ({ key, value, provenance, remember }) => ({ key, value, provenance, remember }),
    ),
    rememberedContextCount: rememberedAgain.items.length,
    sessionOnlyContextCount: interactionContext.items.length,
    rejectedSignalStored: false,
    states: {
      rememberedFirst: rememberedFirst.contract.state,
      rememberedSecond: rememberedSecond.contract.state,
      declined: declined.structuredContent.state,
      declinedAgain: declineAgain.contract.state,
      noRelevantContext: "no_relevant_context",
      rejected: "rejected",
    },
    personalizationDecisionCount: decisions.length + 1,
    outcomeIds: [firstOutcomeId].filter(Boolean),
  };
}

export async function runIndustryProductionE2E({
  productKeys,
  endpoint,
  confirmProduction = false,
  runId = new Date().toISOString().replace(/\D/g, "").slice(0, 14),
  products = INDUSTRY_E2E_PRODUCTS,
  logger = { debug() {}, warn: console.warn },
} = {}) {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new Error("endpoint is required; production is never selected implicitly");
  }
  const normalizedEndpoint = endpoint.replace(/\/+$/, "");
  if (normalizedEndpoint === PRODUCTION_ENDPOINT && confirmProduction !== true) {
    throw new Error("Production execution requires confirmProduction: true");
  }
  if (!productKeys || typeof productKeys !== "object") throw new Error("productKeys are required");
  for (const product of products) {
    if (typeof productKeys[product.slug] !== "string") {
      throw new Error(`Missing product key for ${product.slug}`);
    }
  }
  const dependencies = await loadMcpDependencies();
  const results = [];
  for (const product of products) {
    results.push(
      await runIndustryProduct({
        product,
        apiKey: productKeys[product.slug],
        endpoint: normalizedEndpoint,
        runId,
        dependencies,
        logger,
      }),
    );
  }
  return {
    ok: true,
    runId,
    endpoint: normalizedEndpoint,
    productCount: results.length,
    customerCount: results.reduce((sum, result) => sum + result.customerRefs.length, 0),
    sessionCount: results.reduce((sum, result) => sum + result.sessionRefs.length, 0),
    questionCount: results.reduce((sum, result) => sum + result.questionCount, 0),
    results,
  };
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const keysPath = argument("keys");
  if (!keysPath) {
    throw new Error(
      "Usage: industry-production-e2e.mjs --keys=/secure/product-keys.json --endpoint=https://api.epode.ai --confirm-production [--run-id=...]",
    );
  }
  const productKeys = JSON.parse(await readFile(keysPath, "utf8"));
  const result = await runIndustryProductionE2E({
    productKeys,
    endpoint: argument("endpoint"),
    confirmProduction: process.argv.includes("--confirm-production"),
    runId: argument("run-id") || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (
  typeof process !== "undefined" &&
  import.meta.url === pathToFileURL(process.argv[1] || "").href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
