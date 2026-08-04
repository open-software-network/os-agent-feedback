import assert from "node:assert/strict";
import test from "node:test";

import { startShopwiseMcpServer } from "./mcp-server.js";

const protocolVersion = "2025-11-25";

const realisticContext = () => ({
  size: "10",
  width: "wide",
  colors: { preferred: ["Black", "Graphite"], excluded: ["Neon Lime"] },
  useCase: "Daily Road Running",
  budget: { currency: "USD", max: 140 },
  features: { required: ["Roomy Toe Box"], excluded: ["Trail Outsole"] },
  brands: { preferred: [], excluded: ["Northstar"] },
});

async function post(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const event = raw
    .split(/\r?\n/)
    .findLast((line) => line.startsWith("data:"));
  const payload = JSON.parse(event ? event.slice(5).trim() : raw);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(response.headers.get("mcp-session-id"), null, "the server must be stateless");
  return payload;
}

test("Shopwise initializes, lists exactly one tool, and searches over stateless HTTP MCP", async (t) => {
  const running = startShopwiseMcpServer({ port: 0, host: "127.0.0.1" });
  t.after(() => running.close());
  await new Promise((resolve) => {
    if (running.server.listening) resolve();
    else running.server.once("listening", resolve);
  });
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;

  const initialized = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "shopwise-transport-test", version: "1.0.0" },
    },
  });
  assert.equal(initialized.result.protocolVersion, protocolVersion);
  assert.equal(initialized.result.serverInfo.name, "shopwise-ecommerce");

  const listed = await post(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["search_catalog"],
  );
  assert.equal(listed.result.tools[0].inputSchema.properties.shopperContext.type, "object");

  const received = realisticContext();
  const called = await post(
    url,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_catalog", arguments: { shopperContext: received } },
    },
    { "x-shopwise-session-id": "transport-session-1" },
  );
  assert.notEqual(called.result.isError, true);
  assert.deepEqual(called.result.structuredContent.receivedContext, received);
  assert.deepEqual(
    called.result.structuredContent.matches.map((match) => match.id),
    ["harbor-run-2e"],
  );
  assert.deepEqual(called.result.structuredContent.dataUse, {
    personalization: "task_context_only",
    scope: "current_tool_call",
    retention: "none",
    expiresInSeconds: 0,
    savedToProfile: false,
    assistantMemoryImported: false,
    identityMode: "not_provided",
  });
  assert.equal("contextId" in called.result.structuredContent.contextReceipt, false);

  const incognito = await post(
    url,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_catalog", arguments: { shopperContext: realisticContext() } },
    },
    {
      "x-shopwise-session-id": "incognito-transport-session",
      "x-shopwise-incognito": "true",
    },
  );
  assert.equal(incognito.result.structuredContent.dataUse.identityMode, "incognito");
  assert.equal(incognito.result.structuredContent.dataUse.retention, "none");
  assert.equal("contextId" in incognito.result.structuredContent.contextReceipt, false);

  for (const [id, signal] of [[5, "false"], [6, "unknown"]]) {
    const unspecified = await post(
      url,
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "search_catalog", arguments: { shopperContext: realisticContext() } },
      },
      { "x-shopwise-incognito": signal },
    );
    assert.equal(unspecified.result.structuredContent.dataUse.identityMode, "not_provided");
  }
});

test("HTTP MCP rejects unsupported context and never adds profile/import tools", async (t) => {
  const running = startShopwiseMcpServer({ port: 0, host: "127.0.0.1" });
  t.after(() => running.close());
  await new Promise((resolve) => {
    if (running.server.listening) resolve();
    else running.server.once("listening", resolve);
  });
  const address = running.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/mcp`;

  const listed = await post(url, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/list",
    params: {},
  });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ["search_catalog"],
  );

  const rejected = await post(url, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "search_catalog",
      arguments: {
        shopperContext: { ...realisticContext(), medicalHistory: "must not cross boundary" },
      },
    },
  });
  assert.equal(rejected.result.isError, true);
  assert.match(JSON.stringify(rejected.result), /additional properties|Invalid arguments/);
});
