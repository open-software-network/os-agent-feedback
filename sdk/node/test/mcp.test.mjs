import assert from "node:assert/strict";
import test from "node:test";

import { createMcpInstrumentation, instrumentMcp } from "../dist/mcp.js";

const key = `af_live_2123456789abcdef0123456789abcdef_${"z".repeat(32)}`;

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

  const result = await tools.get("search").handler({}, { sessionId: "mcp_session_1" });
  assert.equal(result.structuredContent.answer, "found");
  assert.equal(result.structuredContent._agentFeedback.reportTool, "report_product_feedback");
  assert.equal(result.structuredContent._agentFeedback.reliability, "protocol_tool");
  assert.match(result.structuredContent._agentFeedback.feedbackHandle, /^afr2_/);
  const feedbackHandle = result.structuredContent._agentFeedback.feedbackHandle;
  const report = await tools.get("report_product_feedback").handler({
    feedbackHandle,
    summary: "The search result completed the task with useful context.",
    impact: "helped",
    findings: [
      { kind: "strength", topic: "relevance", detail: "The top result answered the question." },
    ],
  });
  assert.equal(report.structuredContent.accepted, true);
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
    await tools.get(`search_${suffix}`).handler({}, {});
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
  server.registerTool("browser_navigate", {}, async () => ({
    content: [{ type: "text", text: "navigated" }],
    structuredContent: { ok: true },
  }));
  server.registerTool("browser_extract", {}, async () => ({
    content: [{ type: "text", text: "extracted" }],
    structuredContent: { result: "answer" },
  }));
  server.registerTool("browser_act", {}, async () => {
    throw new Error("page crashed");
  });
  server.registerTool("admin_health", {}, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));

  const navigate = await tools.get("browser_navigate").handler({ sessionId: "bb_session_1" }, {});
  assert.equal(navigate.structuredContent._agentFeedback, undefined);
  const extract = await tools.get("browser_extract").handler({ sessionId: "bb_session_1" }, {});
  assert.equal(extract.structuredContent._agentFeedback.reportTool, "report_product_feedback");
  await assert.rejects(
    tools.get("browser_act").handler({ sessionId: "bb_session_1" }, {}),
    /page crashed/,
  );
  await tools.get("admin_health").handler({}, {});
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

  await tools.get("start_session").handler({}, {});
  await feedback.shutdown();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.events[0].sessionRef, "browser_session_42");
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

  const result = await tools.get("search").handler({}, {});
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

  const decision = await tools.get("record_product_feedback_consent").handler({
    feedbackHandle: contract.feedbackHandle,
    decision: "approved",
  });
  assert.equal(decision.structuredContent.state, "approved");
  assert.deepEqual(reports, []);

  const approved = await tools.get("report_product_feedback").handler({
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
        return new Response('{"state":"unknown"}', {
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

  const result = await tools.get("search").handler({}, {});
  const contract = result.structuredContent._agentFeedback;
  assert.equal(contract.mode, "ask_once");
  assert.equal(contract.state, "consent_required");
  assert.equal(contract.consentPolicy, "once");
  assert.equal(contract.when, "after_experience_known_and_consent_resolved");
  assert.equal(contract.reportSchema, undefined);
  assert.equal(contract.reportTool, undefined);
  assert.match(contract.instruction, /^First complete the user's product task\./);
  assert.match(contract.question, /future uses without asking again/);

  const decision = await tools.get("record_product_feedback_consent").handler({
    feedbackHandle: contract.feedbackHandle,
    decision: "approved",
  });
  const approved = await tools.get("report_product_feedback").handler({
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

test("MCP gives agents a safe minimal retry after backend report validation fails", async () => {
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
    fetch: async (url) => {
      if (String(url).endsWith("/api/v2/reports")) {
        return new Response('{"error":"untrusted backend detail"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 202 });
    },
  });
  feedback.instrument(server);

  const result = await tools.get("report_product_feedback").handler({
    feedbackHandle: `afr2_${"a".repeat(96)}`,
    summary: "The product returned a useful result.",
    impact: "helped",
  });

  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /Retry this tool once with only feedbackHandle and a concise summary/,
  );
  assert.doesNotMatch(result.content[0].text, /untrusted backend detail/);
  await feedback.shutdown();
});
