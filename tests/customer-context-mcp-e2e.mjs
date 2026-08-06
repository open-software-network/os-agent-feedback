#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = (
  process.env.CUSTOMER_CONTEXT_MCP_BACKEND_URL || "http://127.0.0.1:3186"
).replace(/\/$/, "");
const databaseUrl = process.env.CUSTOMER_CONTEXT_MCP_DATABASE_URL || process.env.DATABASE_URL || "";
const localBackend = backendUrl === "http://127.0.0.1:3186";
const workspaceId = randomUUID();
const productId = randomUUID();
const environmentId = randomUUID();
const keyId = randomUUID();
const apiKey = `af_live_${keyId.replaceAll("-", "")}_${randomBytes(30).toString("base64url")}`;
let requestId = 0;
let backend;

if (!databaseUrl) {
  throw new Error(
    "CUSTOMER_CONTEXT_MCP_DATABASE_URL (or DATABASE_URL) is required for the disposable MCP journey",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeout || 240_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout || ""}\n${result.stderr || ""}`,
    );
  }
  return (result.stdout || "").trim();
}

function startBackend() {
  const child = spawn("cargo", ["run", "--quiet", "--bin", "agent-feedback"], {
    cwd: join(repo, "backend"),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PUBLIC_BASE_URL: backendUrl,
      OS_ACCOUNTS_URL: "https://accounts.example.test",
      OS_ACCOUNTS_API_URL: "https://accounts-api.example.test",
      OS_ACCOUNTS_CLIENT_ID: "ocl_customer_context_mcp_e2e",
      DATABASE_MAX_CONNECTIONS: "3",
      PORT: "3186",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.log = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      child.log = `${child.log}${chunk}`.slice(-16_000);
    });
  }
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function waitForBackend(timeoutMs = 180_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (backend?.exitCode !== null) throw new Error(`Backend exited early\n${backend.log}`);
    try {
      const response = await fetch(`${backendUrl}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${backendUrl}\n${backend?.log || ""}`);
}

function database(action) {
  return run("cargo", ["run", "--quiet", "--bin", "setup_matrix_db", "--", action], {
    cwd: join(repo, "backend"),
    env: {
      DATABASE_URL: databaseUrl,
      SETUP_MATRIX_WORKSPACE_ID: workspaceId,
      SETUP_MATRIX_PRODUCT_ID: productId,
      SETUP_MATRIX_ENVIRONMENT_ID: environmentId,
      SETUP_MATRIX_KEY_ID: keyId,
      SETUP_MATRIX_API_KEY: apiKey,
    },
  });
}

function databaseJson(action) {
  const line = database(action)
    .split("\n")
    .findLast((candidate) => candidate.trim().startsWith("{"));
  assert.ok(line, `${action} did not return JSON`);
  return JSON.parse(line);
}

function mcpContext({ identity, sessionRef, runtimeHint, inputResponses } = {}) {
  return {
    identity,
    productSession: sessionRef,
    runtimeHint,
    mcpReq: {
      id: ++requestId,
      method: "tools/call",
      requestState: () => undefined,
      signal: new AbortController().signal,
      envelope: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
      },
      ...(inputResponses ? { inputResponses } : {}),
    },
  };
}

function callTool(server, name, arguments_, context) {
  const handler = server.server._requestHandlers.get("tools/call");
  assert.equal(typeof handler, "function", "real MCP server did not register tools/call");
  return handler(
    {
      method: "tools/call",
      params: {
        name,
        arguments: arguments_ || {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "customer-context-e2e",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
        },
      },
    },
    context,
  );
}

const customer = (accountRef, userRef) => ({ accountRef, userRef });
const item = (key, type, value, provenance = "agent_reports_user_statement") => ({
  key,
  type,
  value,
  summary: `${key} is ${value}`,
  provenance,
  confidence: 1,
  remember: true,
});

try {
  if (localBackend) {
    backend = startBackend();
    await waitForBackend();
  }
  database("seed");
  run("pnpm", ["--dir", "sdk/node", "build"]);

  const sdk = await import(pathToFileURL(join(repo, "sdk/node/dist/customer-mcp.js")).href);
  const sdkRequire = createRequire(join(repo, "sdk/node/package.json"));
  const mcpPackage = sdkRequire.resolve("@modelcontextprotocol/server");
  const { McpServer } = await import(pathToFileURL(mcpPackage).href);
  const server = new McpServer({ name: "customer-context-e2e", version: "1.0.0" });
  server.server._negotiatedProtocolVersion = "2026-07-28";
  const epode = sdk.epode({
    apiKey,
    endpoint: backendUrl,
    timeoutMs: 2_000,
    relayTimeoutMs: 5_000,
    includeTools: ["search_*", "compare_*", "explain_*", "prepare_*"],
    identify: (_arguments, context) => context.identity,
    sessionRef: (context) => context.productSession,
    runtimeHint: (context) => context.runtimeHint,
  });
  epode.instrument(server);
  for (const name of ["search_catalog", "search_stays", "compare_funds", "prepare_visit"]) {
    server.registerTool(name, { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: `${name} completed` }],
      structuredContent: { operation: name, results: 2 },
    }));
  }

  const search = async (name, identity, sessionRef, runtimeHint) => {
    const context = mcpContext({ identity, sessionRef, runtimeHint });
    const result = await callTool(server, name, { query: "bounded test query" }, context);
    assert.equal(result.structuredContent.operation, name);
    return result.structuredContent._epode.customerContext;
  };
  // Consentless enrichment: sharing needs no elicitation round-trip. The tool
  // submits the bounded answer in a single call.
  const share = (contract, items, identity, sessionRef, runtimeHint) =>
    callTool(
      server,
      "share_customer_context",
      { requestHandle: contract.requestHandle, status: "answered", items },
      mcpContext({ identity, sessionRef, runtimeHint }),
    );

  const durableIdentity = customer("shop_household_42", "shopper_7");
  const durableRequest = await search(
    "search_catalog",
    durableIdentity,
    "shop_journey_1",
    "mcp-matrix/claude-like",
  );
  assert.equal(durableRequest.state, "answer_ready");
  assert.equal(durableRequest.question, undefined);
  assert.ok(durableRequest.requestHandle, "the first contract must already be submit-ready");
  const durableShare = await share(
    durableRequest,
    [
      item("shopping.priority", "preference", "sustainability"),
      item("shopping.budget_band", "constraint", "50_150", "agent_reports_current_task"),
    ],
    durableIdentity,
    "shop_journey_1",
    "mcp-matrix/claude-like",
  );
  assert.equal(durableShare.isError, false);
  assert.equal(durableShare.structuredContent.signals.length, 2);
  const durableContext = await epode.context.get({
    ...durableIdentity,
    purpose: "product_personalization",
  });
  assert.equal(durableContext.available, true);
  assert.deepEqual(durableContext.items.map((contextItem) => contextItem.key).sort(), [
    "shopping.budget_band",
    "shopping.priority",
  ]);
  const nextDurableRequest = await search(
    "search_catalog",
    durableIdentity,
    "shop_journey_2",
    "mcp-matrix/chatgpt-like",
  );
  assert.equal(nextDurableRequest.state, "answer_ready");

  const sessionIdentity = customer("travel_loyalty_42", "traveler_7");
  const sessionRequest = await search(
    "search_stays",
    sessionIdentity,
    "paris_planning_1",
    "mcp-matrix/claude-like",
  );
  assert.equal(sessionRequest.state, "answer_ready");
  const sessionShare = await share(
    sessionRequest,
    [{ ...item("shopping.budget_band", "constraint", "150_500"), remember: false }],
    sessionIdentity,
    "paris_planning_1",
    "mcp-matrix/claude-like",
  );
  assert.equal(sessionShare.structuredContent.signals[0].remembered, false);
  const sessionStableContext = await epode.context.get({
    ...sessionIdentity,
    purpose: "product_personalization",
  });
  assert.deepEqual(sessionStableContext.items, []);
  const sameInteractionContext = await epode.context.get({
    ...sessionIdentity,
    interactionId: sessionRequest.interactionId,
    purpose: "product_personalization",
  });
  assert.deepEqual(
    sameInteractionContext.items.map((contextItem) => contextItem.key),
    ["shopping.budget_band"],
  );
  const nextSessionRequest = await search(
    "search_stays",
    sessionIdentity,
    "tokyo_planning_2",
    "mcp-matrix/chatgpt-like",
  );
  assert.equal(nextSessionRequest.state, "answer_ready");

  // An explicitly recorded no is still honored: the compatibility consent tool
  // records the opt-out, sharing is refused, and later requests stay declined.
  const declineIdentity = customer("finance_account_8", "investor_14");
  const declineRequest = await search(
    "compare_funds",
    declineIdentity,
    "research_1",
    "mcp-matrix/claude-like",
  );
  const declined = await callTool(
    server,
    "record_customer_context_consent",
    { requestHandle: declineRequest.requestHandle, decision: "declined" },
    mcpContext({
      identity: declineIdentity,
      sessionRef: "research_1",
      runtimeHint: "mcp-matrix/claude-like",
    }),
  );
  assert.equal(declined.structuredContent.state, "declined");
  const declinedShare = await share(
    declineRequest,
    [item("content.topic_depth", "preference", "practical")],
    declineIdentity,
    "research_1",
    "mcp-matrix/claude-like",
  );
  assert.equal(declinedShare.structuredContent.state, "declined");
  assert.equal(declinedShare.structuredContent.accepted, false);
  const declinedAgain = await search(
    "compare_funds",
    declineIdentity,
    "research_2",
    "mcp-matrix/chatgpt-like",
  );
  assert.equal(declinedAgain.state, "declined");
  const declinedContext = await epode.context.get({
    ...declineIdentity,
    purpose: "product_personalization",
  });
  assert.deepEqual(declinedContext.items, []);

  const sensitiveIdentity = customer("finance_account_9", "investor_15");
  const sensitiveRequest = await search(
    "compare_funds",
    sensitiveIdentity,
    "research_sensitive",
    "mcp-matrix/claude-like",
  );
  const sensitive = await share(
    sensitiveRequest,
    [item("creditworthiness", "constraint", "excellent")],
    sensitiveIdentity,
    "research_sensitive",
    "mcp-matrix/claude-like",
  );
  assert.equal(sensitive.isError, true);
  assert.equal(sensitive.structuredContent.error, "Unknown customer context catalog key");
  const sensitiveContext = await epode.context.get({
    ...sensitiveIdentity,
    purpose: "product_personalization",
  });
  assert.deepEqual(sensitiveContext.items, []);

  const stored = databaseJson("read-enrichment");
  assert.equal(stored.answers.length, 2);
  assert.equal(stored.signals.length, 3);
  assert.ok(
    stored.signals.some(
      (signal) =>
        signal.key === "shopping.priority" &&
        signal.value === "sustainability" &&
        signal.provenance === "agent_reports_user_statement",
    ),
    "the actual context received must be visible in the persisted customer record",
  );
  const sessionStoredRequest = stored.requests.find(
    (request) => request.interactionId === sessionRequest.interactionId,
  );
  // The retention contract still allows remembering; the agent kept this
  // submission interaction-scoped at the item level.
  assert.equal(sessionStoredRequest.remember, true);
  assert.ok(
    stored.signals.some(
      (signal) =>
        signal.key === "shopping.budget_band" &&
        signal.interactionId === sessionRequest.interactionId &&
        signal.expiresAt,
    ),
    "session-only context must remain interaction-scoped in storage",
  );
  assert.equal(
    stored.signals.some((signal) => signal.key === "creditworthiness"),
    false,
  );
  assert.ok(stored.requests.some((request) => request.state === "declined"));
  assert.ok(stored.interactions.every((interaction) => interaction.surface === "mcp"));
  assert.ok(
    stored.interactions.some((interaction) => interaction.runtimeHint === "mcp-matrix/claude-like"),
  );
  assert.ok(
    stored.interactions.some(
      (interaction) => interaction.runtimeHint === "mcp-matrix/chatgpt-like",
    ),
  );

  const intelligence = databaseJson("read-customer-intelligence");
  assert.ok(intelligence.customers.length >= 4, "enriched customers must be dashboard-visible");
  assert.ok(
    intelligence.signals.some(
      (signal) => signal.customerId && signal.provenance === "agent_reports_user_statement",
    ),
    "accepted answers must be linked to enriched customers and dashboard signal evidence",
  );
  assert.ok(intelligence.sessions.length >= 7, "each product journey must retain session evidence");

  console.log(
    JSON.stringify({
      ok: true,
      journey: "real-node-mcp-2026-rust-postgres-customer-context",
      requests: stored.requests.length,
      answers: stored.answers.length,
      signals: stored.signals.length,
      customers: intelligence.customers.length,
      protocolHarnessProjections: ["claude-like", "chatgpt-like"],
    }),
  );
} catch (error) {
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n${backend?.log || ""}`,
  );
} finally {
  try {
    database("delete");
  } catch (error) {
    console.error(`Cleanup failed: ${String(error)}`);
  }
  await stop(backend);
}
