import assert from "node:assert/strict";
import test from "node:test";

import { createMcpInstrumentation, instrumentMcp } from "../dist/mcp.js";

const key = `af_live_2123456789abcdef0123456789abcdef_${"z".repeat(32)}`;

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
    tools.get("progress").handler({}, {}),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 50)),
  ]);
  assert.notEqual(progress, "timed_out");
  assert.equal(consentLookups, 0);

  const outcome = await Promise.race([
    tools.get("finish").handler({}, {}),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 50)),
  ]);
  assert.notEqual(outcome, "timed_out");
  assert.equal(outcome.structuredContent._agentFeedback.state, "consent_required");
  assert.equal(consentLookups, 1);
  resolveLookup(
    new Response('{"state":"approved"}', {
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

  await tools.get("start_session").handler({}, {});
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

  const result = await tools.get("create_payment").handler({}, {});
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
        const result = await tools.get("report_product_feedback").handler({
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
        const result = await tools.get("record_product_feedback_consent").handler({
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
