import assert from "node:assert/strict";
import test from "node:test";

import { inputRequired, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createMcpInstrumentation, instrumentMcp } from "../dist/mcp.js";

const key = `af_live_2123456789abcdef0123456789abcdef_${"z".repeat(32)}`;

let realMcpRequestId = 0;

function realMcpContext(accountId) {
  return {
    mcpReq: {
      id: ++realMcpRequestId,
      method: "tools/call",
      requestState: () => undefined,
      signal: new AbortController().signal,
    },
    ...(accountId
      ? {
          http: {
            authInfo: {
              token: "test-token",
              clientId: "test-client",
              scopes: [],
              extra: { accountId },
            },
          },
        }
      : {}),
  };
}

async function invokeRealMcpHandler(server, method, params, context = realMcpContext()) {
  const handler = server.server._requestHandlers.get(method);
  assert.equal(typeof handler, "function", `real MCP v2 did not register ${method}`);
  return handler({ method, params }, context);
}

function callRealMcpTool(server, name, arguments_ = {}, context = realMcpContext()) {
  return invokeRealMcpHandler(server, "tools/call", { name, arguments: arguments_ }, context);
}

function feedbackFromTextContent(result) {
  for (const block of result.content || []) {
    if (block?.type !== "text") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed?._agentFeedback) return parsed._agentFeedback;
    } catch {
      // Ordinary product and instruction text is not expected to be JSON.
    }
  }
  return undefined;
}

function callMockTool(tools, name, arguments_ = {}, context = {}) {
  const tool = tools.get(name);
  assert.ok(tool, `mock MCP tool ${name} was not registered`);
  return tool.configuration.inputSchema === undefined
    ? tool.handler(context)
    : tool.handler(arguments_, context);
}

test("real MCP v2 keeps authenticated ctx for schema-less callbacks and Epode extractors", async () => {
  const server = new McpServer({ name: "schema-less-context", version: "1.0.0" });
  const telemetry = [];
  const consentLookups = [];
  const warnings = [];
  const extractorCalls = [];
  const predicateCalls = [];
  let businessContext;
  let businessArgumentCount;
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    flushIntervalMs: 60_000,
    customerRef: (arguments_, context) => {
      extractorCalls.push({ arguments_, context });
      return context.http?.authInfo?.extra?.accountId;
    },
    shouldRequestFeedback: (input) => {
      predicateCalls.push(input);
      return true;
    },
    logger: {
      debug() {},
      warn(message) {
        warnings.push(message);
      },
    },
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/v2/consent/state")) {
        consentLookups.push(JSON.parse(init.body));
        return new Response('{"state":"unknown","revision":0}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.registerTool("authenticated_status", {}, async (...receivedArguments) => {
    businessContext = receivedArguments[0];
    businessArgumentCount = receivedArguments.length;
    return {
      content: [{ type: "text", text: "authenticated" }],
      structuredContent: { status: "ok" },
    };
  });

  const context = realMcpContext("acct_authenticated");
  const result = await callRealMcpTool(server, "authenticated_status", { ignored: true }, context);
  await new Promise((resolve) => setImmediate(resolve));
  await feedback.shutdown();

  assert.equal(server._registeredTools.authenticated_status.handler.length, 1);
  assert.equal(businessArgumentCount, 1);
  assert.equal(businessContext, context);
  assert.ok(extractorCalls.length > 0);
  assert.ok(extractorCalls.every((call) => call.context === context));
  assert.ok(extractorCalls.every((call) => assert.deepEqual(call.arguments_, {}) === undefined));
  assert.deepEqual(predicateCalls[0].arguments, {});
  assert.equal(predicateCalls[0].context, context);
  assert.equal(result.structuredContent._agentFeedback.mode, "ask_once");
  assert.equal(result.structuredContent._agentFeedback.state, "consent_required");
  assert.equal(consentLookups.length, 1);
  assert.equal(telemetry[0].events[0].customerRef, "acct_authenticated");
  assert.ok(!warnings.some((message) => /could not resolve customerRef/.test(message)));
});

test("real MCP v2 preserves business output schemas and exposes feedback as JSON TextContent", async (t) => {
  const scenarios = [
    {
      name: "strict object output",
      outputSchema: z.strictObject({ answer: z.string() }),
      structuredContent: { answer: "strict" },
      feedbackMode: "never_ask",
    },
    {
      name: "ordinary object output",
      outputSchema: z.object({ answer: z.string() }),
      structuredContent: { answer: "ordinary" },
      feedbackMode: "ask_always",
    },
    {
      name: "primitive output",
      outputSchema: z.string(),
      structuredContent: "business-value",
      feedbackMode: "never_ask",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const server = new McpServer({ name: "output-schema", version: "1.0.0" });
      const telemetry = [];
      const feedback = createMcpInstrumentation({
        apiKey: key,
        endpoint: "https://feedback.test",
        feedbackMode: scenario.feedbackMode,
        flushIntervalMs: 60_000,
        fetch: async (_url, init) => {
          telemetry.push(JSON.parse(init.body));
          return new Response("{}", { status: 202 });
        },
      });
      feedback.instrument(server);
      server.registerTool(
        "search",
        {
          inputSchema: z.object({ query: z.string() }),
          outputSchema: scenario.outputSchema,
        },
        async () => ({ structuredContent: scenario.structuredContent }),
      );

      const listed = await invokeRealMcpHandler(server, "tools/list", {});
      const advertised = listed.tools.find((tool) => tool.name === "search").outputSchema;
      const result = await callRealMcpTool(server, "search", { query: "epode" });
      await feedback.shutdown();

      assert.equal(result.isError, undefined);
      assert.deepEqual(
        result.structuredContent,
        typeof scenario.structuredContent === "string"
          ? { result: scenario.structuredContent }
          : scenario.structuredContent,
      );
      assert.equal(result.structuredContent?._agentFeedback, undefined);
      const contract = feedbackFromTextContent(result);
      assert.equal(contract.mode, scenario.feedbackMode);
      assert.equal(contract.reliability, "protocol_tool");
      assert.equal(Object.hasOwn(advertised.properties || {}, "_agentFeedback"), false);
      assert.equal(telemetry[0].events[0].statusCode, 200);
      if (typeof scenario.structuredContent === "string") {
        assert.equal(result.content[0].text, JSON.stringify(scenario.structuredContent));
      }
    });
  }
});

test("real MCP v2 retains schema-less feedback compatibility and strict-schema tool errors", async () => {
  const server = new McpServer({ name: "result-shapes", version: "1.0.0" });
  const telemetry = [];
  let errorContext;
  let errorArgumentCount;
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.registerTool("without_output_schema", {}, async () => ({
    content: [{ type: "text", text: "done" }],
    structuredContent: { answer: "done" },
  }));
  server.registerTool(
    "strict_error",
    { outputSchema: z.strictObject({ answer: z.string() }) },
    async (...receivedArguments) => {
      errorContext = receivedArguments[0];
      errorArgumentCount = receivedArguments.length;
      return {
        isError: true,
        content: [{ type: "text", text: "denied" }],
        structuredContent: { code: "denied" },
      };
    },
  );

  const ordinary = await callRealMcpTool(server, "without_output_schema");
  const expectedErrorContext = realMcpContext("acct_error");
  const error = await callRealMcpTool(server, "strict_error", {}, expectedErrorContext);
  await feedback.shutdown();

  assert.equal(ordinary.structuredContent.answer, "done");
  assert.equal(ordinary.structuredContent._agentFeedback.reportTool, "report_product_feedback");
  assert.equal(error.isError, true);
  assert.equal(errorArgumentCount, 1);
  assert.equal(errorContext, expectedErrorContext);
  assert.deepEqual(error.structuredContent, { code: "denied" });
  assert.equal(feedbackFromTextContent(error).reportTool, "report_product_feedback");
  assert.deepEqual(
    telemetry[0].events.map((event) => event.statusCode),
    [200, 500],
  );
});

test("real MCP v2 leaves input_required untouched until a complete result", async () => {
  const server = new McpServer({ name: "input-required", version: "1.0.0" });
  const requests = [];
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_multi_round",
    flushIntervalMs: 60_000,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith("/api/v2/consent/state")) {
        return new Response('{"state":"unknown","revision":0}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.server._negotiatedProtocolVersion = "2026-07-28";
  const intermediate = inputRequired({ requestState: "signed-round-state" });
  let round = 0;
  server.registerTool(
    "confirm_then_finish",
    {
      inputSchema: z.object({ action: z.string() }),
      outputSchema: z.strictObject({ completed: z.boolean() }),
    },
    async () => {
      round += 1;
      return round === 1
        ? intermediate
        : {
            content: [{ type: "text", text: "complete" }],
            structuredContent: { completed: true },
          };
    },
  );

  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const callCompleteTool = () =>
    invokeRealMcpHandler(
      server,
      "tools/call",
      {
        name: "confirm_then_finish",
        arguments: { action: "deploy" },
        _meta: modernMeta,
      },
      realMcpContext(),
    );
  const first = await callCompleteTool();
  assert.equal(first, intermediate);
  assert.deepEqual(first, {
    resultType: "input_required",
    requestState: "signed-round-state",
  });
  assert.deepEqual(requests, []);

  const second = await callCompleteTool();
  await new Promise((resolve) => setImmediate(resolve));
  await feedback.shutdown();
  assert.deepEqual(second.structuredContent, { completed: true });
  assert.equal(feedbackFromTextContent(second).state, "consent_required");
  assert.equal(
    requests.filter((request) => request.url.endsWith("/api/v2/consent/state")).length,
    1,
  );
  assert.equal(requests.flatMap((request) => request.body.events || []).filter(Boolean).length, 1);
});

test("MCP off mode leaves the server tool surface completely untouched", async () => {
  const tools = [];
  const server = {
    registerTool(name, configuration, handler) {
      tools.push({ name, configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({ apiKey: key, feedbackMode: "off" });
  feedback.instrument(server);
  server.registerTool("search", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search"],
  );
  await feedback.shutdown();
});

function createFailureHarness(fetch) {
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    flushIntervalMs: 60_000,
    fetch,
  });
  feedback.instrument(server);
  return { feedback, tools };
}

test("MCP instrumentation decorates business tools and registers structured feedback reporting", async () => {
  const tools = new Map();
  const telemetry = [];
  const reports = [];
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const instrumentation = instrumentMcp(server, {
    apiKey: key,
    endpoint: "https://feedback.test",
    flushIntervalMs: 1,
    sessionRef: (_arguments, context) => context.sessionId,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/v2/telemetry/batches")) {
        telemetry.push(JSON.parse(init.body));
        return new Response("{}", { status: 202 });
      }
      reports.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ accepted: true, interactionId: "interaction" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  server.registerTool("search", {}, async () => ({
    content: [{ type: "text", text: "found" }],
    structuredContent: { answer: "found" },
  }));

  const result = await callMockTool(tools, "search", {}, { sessionId: "mcp_session_1" });
  assert.equal(result.structuredContent.answer, "found");
  assert.equal(result.structuredContent._agentFeedback.reportTool, "report_product_feedback");
  assert.equal(result.structuredContent._agentFeedback.reliability, "protocol_tool");
  assert.match(result.structuredContent._agentFeedback.feedbackHandle, /^afr2_/);
  const feedbackHandle = result.structuredContent._agentFeedback.feedbackHandle;
  const report = await callMockTool(tools, "report_product_feedback", {
    feedbackHandle,
    summary: "The search result completed the task with useful context.",
    impact: "helped",
    findings: [
      { kind: "strength", topic: "relevance", detail: "The top result answered the question." },
    ],
  });
  assert.equal(report.structuredContent.accepted, true);
  assert.match(report.content[0].text, /routine background success out of the final answer/);
  assert.deepEqual(reports, [
    {
      summary: "The search result completed the task with useful context.",
      impact: "helped",
      findings: [
        { kind: "strength", topic: "relevance", detail: "The top result answered the question." },
      ],
    },
  ]);
  await instrumentation.shutdown();
  assert.equal(telemetry[0].events[0].classification, "confirmed");
  assert.equal(telemetry[0].events[0].confirmationMethod, "mcp");
  assert.equal(telemetry[0].events[0].sessionSource, "mcp");
});

test("stateless MCP factories share one process-level telemetry queue", async () => {
  const telemetry = [];
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });

  for (const suffix of ["one", "two"]) {
    const tools = new Map();
    const server = {
      registerTool(name, configuration, handler) {
        tools.set(name, { configuration, handler });
        return { remove() {} };
      },
    };
    feedback.instrument(server);
    server.registerTool(`search_${suffix}`, {}, async () => ({
      content: [{ type: "text", text: suffix }],
      structuredContent: { answer: suffix },
    }));
    await callMockTool(tools, `search_${suffix}`);
  }

  await feedback.shutdown();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].events.length, 2);
  assert.deepEqual(
    telemetry[0].events.map((event) => event.operation),
    ["search_one", "search_two"],
  );
});

test("MCP keeps full journey telemetry while requesting feedback only at outcome boundaries", async () => {
  const tools = new Map();
  const telemetry = [];
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    includeTools: ["browser_*"],
    feedbackTools: ["browser_extract", "browser_close"],
    sessionRef: (arguments_) => arguments_.sessionId,
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  const browserInputSchema = z.object({ sessionId: z.string() });
  server.registerTool("browser_navigate", { inputSchema: browserInputSchema }, async () => ({
    content: [{ type: "text", text: "navigated" }],
    structuredContent: { ok: true },
  }));
  server.registerTool("browser_extract", { inputSchema: browserInputSchema }, async () => ({
    content: [{ type: "text", text: "extracted" }],
    structuredContent: { result: "answer" },
  }));
  server.registerTool("browser_act", { inputSchema: browserInputSchema }, async () => {
    throw new Error("page crashed");
  });
  server.registerTool("admin_health", {}, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));

  const navigate = await callMockTool(tools, "browser_navigate", { sessionId: "bb_session_1" });
  assert.equal(navigate.structuredContent._agentFeedback, undefined);
  const extract = await callMockTool(tools, "browser_extract", { sessionId: "bb_session_1" });
  assert.equal(extract.structuredContent._agentFeedback.reportTool, "report_product_feedback");
  await assert.rejects(
    callMockTool(tools, "browser_act", { sessionId: "bb_session_1" }),
    /page crashed/,
  );
  await callMockTool(tools, "admin_health");
  await feedback.flush();

  const events = telemetry.flatMap((batch) => batch.events);
  assert.deepEqual(
    events.map((event) => event.operation),
    ["browser_navigate", "browser_extract", "browser_act"],
  );
  assert.deepEqual(
    events.map((event) => event.statusCode),
    [200, 200, 500],
  );
  assert.ok(events.every((event) => event.sessionRef === "bb_session_1"));
  await feedback.shutdown();
});

test("MCP outcome feedback never waits for a remote Ask-once lookup", async () => {
  const tools = new Map();
  let resolveLookup;
  let consentLookups = 0;
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_nonblocking",
    feedbackTools: ["finish"],
    consentTimeoutMs: 25,
    flushIntervalMs: 60_000,
    logger: { debug() {}, warn() {} },
    fetch: async (url) => {
      if (String(url).endsWith("/api/v2/consent/state")) {
        consentLookups += 1;
        return new Promise((resolve) => {
          resolveLookup = resolve;
        });
      }
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.registerTool("progress", {}, async () => ({
    content: [{ type: "text", text: "working" }],
    structuredContent: { progress: 50 },
  }));
  server.registerTool("finish", {}, async () => ({
    content: [{ type: "text", text: "done" }],
    structuredContent: { result: "done" },
  }));

  const progress = await Promise.race([
    callMockTool(tools, "progress"),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 50)),
  ]);
  assert.notEqual(progress, "timed_out");
  assert.equal(consentLookups, 0);

  const outcome = await Promise.race([
    callMockTool(tools, "finish"),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 50)),
  ]);
  assert.notEqual(outcome, "timed_out");
  assert.equal(outcome.structuredContent._agentFeedback.state, "consent_required");
  assert.equal(consentLookups, 1);
  resolveLookup(
    new Response('{"state":"approved","revision":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await feedback.shutdown();
});

test("MCP can group a session-creation call by an identifier returned in its result", async () => {
  const calls = [];
  const tools = new Map();
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    flushIntervalMs: 60_000,
    sessionRef: (arguments_, _context, result) =>
      arguments_?.sessionId || result?.structuredContent?.sessionId,
    fetch: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  feedback.instrument(server);
  server.registerTool("start_session", {}, async () => ({
    content: [{ type: "text", text: "started" }],
    structuredContent: { sessionId: "browser_session_42" },
  }));

  await callMockTool(tools, "start_session");
  await feedback.shutdown();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.events[0].sessionRef, "browser_session_42");
});

test("MCP tool errors remain eligible for bounded outcome feedback", async () => {
  const tools = new Map();
  const telemetry = [];
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    flushIntervalMs: 1,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/v2/telemetry/batches")) {
        telemetry.push(JSON.parse(init.body));
      }
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.registerTool("create_payment", {}, async () => ({
    isError: true,
    content: [{ type: "text", text: "Price is not enabled." }],
    structuredContent: { code: "price_restricted" },
  }));

  const result = await callMockTool(tools, "create_payment");
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, "price_restricted");
  assert.equal(result.structuredContent._agentFeedback.reportTool, "report_product_feedback");
  assert.match(result.structuredContent._agentFeedback.feedbackHandle, /^afr2_/);
  await feedback.shutdown();
  assert.equal(telemetry[0].events[0].statusCode, 500);
  assert.equal(telemetry[0].events[0].classification, "confirmed");
});

test("MCP Ask-always uses a question-only tool before revealing report submission", async () => {
  const tools = new Map();
  const reports = [];
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_always",
    flushIntervalMs: 60_000,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/v2/consent/decisions")) {
        const handle = init.headers.authorization;
        return new Response(
          JSON.stringify({
            state: "approved",
            feedback: {
              state: "feedback_ready",
              submit: { authorization: handle },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).endsWith("/api/v2/reports")) {
        reports.push(JSON.parse(init.body));
        return new Response('{"accepted":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.registerTool("search", {}, async () => ({
    content: [{ type: "text", text: "found" }],
    structuredContent: { answer: "found" },
  }));

  const result = await callMockTool(tools, "search");
  const contract = result.structuredContent._agentFeedback;
  assert.equal(contract.required, false);
  assert.equal(contract.state, "consent_required");
  assert.equal(contract.consentRequired, true);
  assert.equal(contract.consentPolicy, "always");
  assert.equal(contract.reportTool, undefined);
  assert.equal(contract.consentTool, "record_product_feedback_consent");
  assert.equal(contract.when, "after_experience_known_and_explicit_user_approval");
  assert.match(contract.instruction, /^First complete the user's product task\./);
  assert.match(contract.instruction, /after the product answer/);
  assert.match(result.content.at(-1).text, /record_product_feedback_consent/);

  const decision = await callMockTool(tools, "record_product_feedback_consent", {
    feedbackHandle: contract.feedbackHandle,
    decision: "approved",
  });
  assert.equal(decision.structuredContent.state, "approved");
  assert.deepEqual(reports, []);

  const approved = await callMockTool(tools, "report_product_feedback", {
    feedbackHandle: decision.structuredContent.feedbackHandle,
    summary: "The search result completed the task with useful context.",
    impact: "helped",
  });
  assert.equal(approved.structuredContent.accepted, true);
  assert.deepEqual(reports, [
    {
      summary: "The search result completed the task with useful context.",
      impact: "helped",
    },
  ]);
  await feedback.shutdown();
});

test("MCP Ask-once lets Epode own approval and never exposes report fields early", async () => {
  const tools = new Map();
  const reports = [];
  const server = {
    registerTool(name, configuration, handler) {
      tools.set(name, { configuration, handler });
      return { remove() {} };
    },
  };
  const feedback = createMcpInstrumentation({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_mcp_ask_once",
    flushIntervalMs: 60_000,
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/v2/consent/state")) {
        return new Response('{"state":"unknown","revision":0}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/v2/consent/decisions")) {
        return new Response(
          JSON.stringify({
            state: "approved",
            feedback: {
              state: "feedback_ready",
              submit: { authorization: init.headers.authorization },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).endsWith("/api/v2/reports")) {
        reports.push(JSON.parse(init.body));
        return new Response('{"accepted":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);
  server.registerTool("search", {}, async () => ({
    content: [{ type: "text", text: "found" }],
    structuredContent: { answer: "found" },
  }));

  const result = await callMockTool(tools, "search");
  const contract = result.structuredContent._agentFeedback;
  assert.equal(contract.mode, "ask_once");
  assert.equal(contract.state, "consent_required");
  assert.equal(contract.consentPolicy, "once");
  assert.equal(contract.when, "after_experience_known_and_consent_resolved");
  assert.equal(contract.reportSchema, undefined);
  assert.equal(contract.reportTool, undefined);
  assert.match(contract.instruction, /^First complete the user's product task\./);
  assert.match(contract.question, /future uses without asking again/);

  const decision = await callMockTool(tools, "record_product_feedback_consent", {
    feedbackHandle: contract.feedbackHandle,
    decision: "approved",
  });
  const approved = await callMockTool(tools, "report_product_feedback", {
    feedbackHandle: decision.structuredContent.feedbackHandle,
    summary: "The stored consent allowed this structured report.",
    impact: "helped",
  });
  assert.equal(approved.structuredContent.accepted, true);
  assert.deepEqual(reports, [
    {
      summary: "The stored consent allowed this structured report.",
      impact: "helped",
    },
  ]);
  await feedback.shutdown();
});

test("MCP Ask-once projects remembered consent management without contradictory actions", async (t) => {
  for (const rememberedState of ["approved", "declined"]) {
    await t.test(rememberedState, async () => {
      const tools = new Map();
      const server = {
        registerTool(name, configuration, handler) {
          tools.set(name, { configuration, handler });
          return { remove() {} };
        },
      };
      const feedback = createMcpInstrumentation({
        apiKey: key,
        endpoint: "https://feedback.test",
        feedbackMode: "ask_once",
        customerRef: () => `acct_mcp_${rememberedState}`,
        flushIntervalMs: 60_000,
        fetch: async (url) => {
          if (String(url).endsWith("/api/v2/consent/state")) {
            return new Response(JSON.stringify({ state: rememberedState, revision: 1 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response("{}", { status: 202 });
        },
      });
      feedback.instrument(server);
      server.registerTool("search", {}, async () => ({
        content: [{ type: "text", text: "found" }],
        structuredContent: { answer: "found" },
      }));

      // The first result stays non-blocking and starts the consent cache warmup.
      await callMockTool(tools, "search");
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await callMockTool(tools, "search");
      const contract = result.structuredContent._agentFeedback;

      assert.equal(contract.manageConsent.current, rememberedState);
      assert.equal(contract.manageConsent.consentTool, "record_product_feedback_consent");
      assert.match(contract.manageConsent.feedbackHandle, /^afr2_/);
      assert.deepEqual(contract.manageConsent.decisionSchema, {
        decision: ["approved", "declined"],
      });
      if (rememberedState === "approved") {
        assert.equal(contract.state, "feedback_ready");
        assert.equal(contract.reportTool, "report_product_feedback");
      } else {
        assert.equal(contract.state, "feedback_disabled");
        assert.equal(contract.reportTool, undefined);
        assert.equal(contract.feedbackHandle, undefined);
        assert.doesNotMatch(result.content.at(-1).text, /report_product_feedback|undefined/);
        assert.match(result.content.at(-1).text, /Do not ask or submit feedback/);
      }
      await feedback.shutdown();
    });
  }
});

test("MCP report failures expose one bounded, status-specific retry decision", async (t) => {
  const scenarios = [
    {
      name: "400 validation gets one minimal retry",
      status: 400,
      retryable: true,
      guidance: /exactly once with only feedbackHandle and a concise summary/,
    },
    {
      name: "404 endpoint mismatch is terminal",
      status: 404,
      retryable: false,
      guidance: /endpoint is unavailable.*Do not retry/,
    },
    {
      name: "409 environment mismatch is terminal",
      status: 409,
      retryable: false,
      guidance: /different product environment.*Do not retry/,
    },
    {
      name: "410 disabled feedback is terminal",
      status: 410,
      retryable: false,
      guidance: /collection is disabled.*Do not retry/,
    },
    {
      name: "429 throttling gets one same-arguments retry",
      status: 429,
      retryable: true,
      guidance: /exactly once with the same arguments/,
    },
    {
      name: "5xx failure gets one same-arguments retry",
      status: 500,
      retryable: true,
      guidance: /exactly once with the same arguments/,
    },
    {
      name: "transport failure gets one same-arguments retry",
      transportError: true,
      retryable: true,
      guidance: /exactly once with the same arguments/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { feedback, tools } = createFailureHarness(async () => {
        if (scenario.transportError) throw new Error("untrusted transport detail");
        return new Response('{"error":"untrusted backend detail"}', {
          status: scenario.status,
          headers: { "content-type": "application/json" },
        });
      });
      try {
        const result = await callMockTool(tools, "report_product_feedback", {
          feedbackHandle: `afr2_${"a".repeat(96)}`,
          summary: "The product returned a useful result.",
          impact: "helped",
        });

        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.retryable, scenario.retryable);
        assert.match(result.content[0].text, scenario.guidance);
        assert.doesNotMatch(result.content[0].text, /untrusted (?:backend|transport) detail/);
      } finally {
        await feedback.shutdown();
      }
    });
  }
});

test("MCP consent failures expose one bounded, status-specific retry decision", async (t) => {
  const scenarios = [
    { name: "400 invalid request is terminal", status: 400, retryable: false },
    { name: "404 endpoint mismatch is terminal", status: 404, retryable: false },
    { name: "409 inapplicable consent is terminal", status: 409, retryable: false },
    { name: "410 disabled feedback is terminal", status: 410, retryable: false },
    { name: "429 throttling gets one retry", status: 429, retryable: true },
    { name: "5xx failure gets one retry", status: 503, retryable: true },
    { name: "transport failure gets one retry", transportError: true, retryable: true },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const { feedback, tools } = createFailureHarness(async () => {
        if (scenario.transportError) throw new Error("untrusted transport detail");
        return new Response('{"error":"untrusted backend detail"}', {
          status: scenario.status,
          headers: { "content-type": "application/json" },
        });
      });
      try {
        const result = await callMockTool(tools, "record_product_feedback_consent", {
          feedbackHandle: `afr2_${"b".repeat(96)}`,
          decision: "approved",
        });

        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.retryable, scenario.retryable);
        if (scenario.retryable) {
          assert.match(result.content[0].text, /exactly once with the same arguments/);
        } else {
          assert.match(result.content[0].text, /[Dd]o not retry/);
        }
        assert.match(result.content[0].text, /never assume approval|Do not assume approval/);
        assert.doesNotMatch(result.content[0].text, /untrusted (?:backend|transport) detail/);
      } finally {
        await feedback.shutdown();
      }
    });
  }
});
