import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import express from "express";

import { agentFeedback } from "../dist/express.js";

const key = `af_live_0123456789abcdef0123456789abcdef_${"x".repeat(32)}`;

test("Express rejects an unknown JavaScript feedback mode", () => {
  assert.throws(
    () => agentFeedback({ apiKey: key, feedbackMode: "unexpected" }),
    /feedbackMode must be never_ask, ask_once, ask_always, or off/,
  );
  assert.throws(
    () => agentFeedback({ apiKey: key, feedbackMode: "auto" }),
    /feedbackMode must be never_ask, ask_once, ask_always, or off/,
  );
  assert.throws(
    () => agentFeedback({ apiKey: key, cacheMode: "surprise" }),
    /cacheMode must be safe, private, or request/,
  );
});

async function serve(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("Express preserves JSON shape and queues a non-blocking opportunity", async () => {
  const telemetry = [];
  const middleware = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    include: ["/search"],
    customerRef: () => "acct_123",
    flushIntervalMs: 1,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
    },
  });
  const app = express();
  app.use(middleware);
  app.get("/search", (_request, response) => response.json({ answer: "found" }));
  const server = await serve(app);

  const response = await fetch(`${server.url}/search`);
  const body = await response.json();
  assert.equal(body.answer, "found");
  assert.equal(body._agentFeedback.v, 1);
  assert.equal(body._agentFeedback.requested, true);
  assert.equal(body._agentFeedback.consentPolicy, "none");
  assert.equal(body._agentFeedback.consentScope, undefined);
  assert.equal(body._agentFeedback.reliability, "best_effort_without_agent_adapter");
  assert.equal(body._agentFeedback.when, "after_experience_known_before_final_response");
  assert.equal(body._agentFeedback.submit.method, "POST");
  assert.deepEqual(body._agentFeedback.submit.reportSchema.required, ["summary"]);
  assert.deepEqual(body._agentFeedback.submit.reportSchema.optional, [
    "sessionLabel",
    "impact",
    "confidence",
    "findings",
    "workaround",
    "consent",
  ]);
  assert.equal(body._agentFeedback.submit.reportSchema.maxFindings, 8);
  assert.match(body._agentFeedback.submit.authorization, /^Bearer afr2_/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  await middleware.shutdown();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].events[0].operation, "/search");
  assert.equal(telemetry[0].events[0].customerRef, "acct_123");
  assert.equal(telemetry[0].events[0].classification, "unclassified");
  await server.close();
});

test("Express Ask-once mode emits a stable product-scoped consent key", async () => {
  const middleware = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    include: ["/search"],
    flushIntervalMs: 1,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  const app = express();
  app.use(middleware);
  app.get("/search", (_request, response) => response.json({ answer: "found" }));
  const server = await serve(app);

  const body = await (await fetch(`${server.url}/search`)).json();
  const contract = body._agentFeedback;
  assert.equal(contract.mode, "ask_once");
  assert.equal(contract.requested, true);
  assert.equal(contract.consentRequired, true);
  assert.equal(contract.consentPolicy, "once");
  assert.equal(contract.consentScope, "afcs1_0123456789abcdef0123456789abcdef");
  assert.equal(contract.when, "after_experience_known_and_consent_resolved");
  assert.match(contract.instruction, /ask the user once/i);
  assert.match(contract.instruction, /durable agent preferences/i);
  assert.match(contract.instruction, /do not ask again/i);
  assert.doesNotMatch(contract.instruction, /do not ask the human/i);
  await middleware.shutdown();
  await server.close();
});

test("Express Ask-always mode requires fresh permission for every report", async () => {
  const middleware = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_always",
    include: ["/search"],
    flushIntervalMs: 1,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  const app = express();
  app.use(middleware);
  app.get("/search", (_request, response) => response.json({ answer: "found" }));
  const server = await serve(app);

  const contract = (await (await fetch(`${server.url}/search`)).json())._agentFeedback;
  assert.equal(contract.mode, "ask_always");
  assert.equal(contract.consentPolicy, "always");
  assert.equal(contract.consentScope, undefined);
  assert.equal(contract.when, "after_experience_known_and_explicit_user_approval");
  assert.match(contract.instruction, /Ask again before every future report/i);
  await middleware.shutdown();
  await server.close();
});

test("Express uses headers for arrays and leaves failures untouched", async () => {
  const middleware = agentFeedback({
    apiKey: key,
    include: ["/*"],
    flushIntervalMs: 1,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  const app = express();
  app.use(middleware);
  app.get("/array", (_request, response) => response.json([1, 2]));
  app.get("/error", (_request, response) => response.status(500).json({ error: "no" }));
  const server = await serve(app);

  const array = await fetch(`${server.url}/array`);
  assert.deepEqual(await array.json(), [1, 2]);
  assert.ok(array.headers.get("agent-feedback"));
  const failure = await fetch(`${server.url}/error`);
  assert.deepEqual(await failure.json(), { error: "no" });
  assert.equal(failure.headers.get("agent-feedback"), null);
  await middleware.shutdown();
  await server.close();
});

test("Express does not silently destroy an explicit shared cache policy", async () => {
  const warnings = [];
  const telemetry = [];
  const middleware = agentFeedback({
    apiKey: key,
    include: ["/search"],
    flushIntervalMs: 1,
    logger: {
      debug() {},
      warn(message) {
        warnings.push(message);
      },
    },
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  const app = express();
  app.use(middleware);
  app.get("/search", (_request, response) => {
    response.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=60");
    response.json({ answer: "cached" });
  });
  const server = await serve(app);

  const response = await fetch(`${server.url}/search`);
  const body = await response.json();
  assert.equal(body._agentFeedback, undefined);
  assert.equal(
    response.headers.get("cache-control"),
    "public, s-maxage=600, stale-while-revalidate=60",
  );
  await middleware.shutdown();
  assert.equal(telemetry.length, 0);
  assert.equal(warnings.filter((message) => message.includes("cacheable response")).length, 1);
  await server.close();
});

test("Express request cache mode instruments only explicit agent requests", async () => {
  const middleware = agentFeedback({
    apiKey: key,
    cacheMode: "request",
    include: ["/search"],
    flushIntervalMs: 1,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  const app = express();
  app.use(middleware);
  app.get("/search", (_request, response) => {
    response.set("Cache-Control", "public, max-age=300");
    response.json({ answer: "cached" });
  });
  const server = await serve(app);

  const ordinary = await fetch(`${server.url}/search`);
  assert.equal((await ordinary.json())._agentFeedback, undefined);
  assert.equal(ordinary.headers.get("cache-control"), "public, max-age=300");
  const agent = await fetch(`${server.url}/search`, {
    headers: { "agent-feedback-request": "1" },
  });
  assert.equal((await agent.json())._agentFeedback.v, 1);
  assert.equal(agent.headers.get("cache-control"), "private, no-store");
  await middleware.shutdown();
  await server.close();
});

test("Express instruments only terminal async-job responses when configured", async () => {
  const middleware = agentFeedback({
    apiKey: key,
    include: ["/crawl/*"],
    shouldInstrument: (_request, { body }) => body?.status === "completed",
    flushIntervalMs: 1,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  const app = express();
  app.use(middleware);
  app.get("/crawl/:id", (request, response) =>
    response.json({
      id: request.params.id,
      status: request.query.done === "1" ? "completed" : "running",
    }),
  );
  const server = await serve(app);

  const running = await (await fetch(`${server.url}/crawl/job_1`)).json();
  assert.equal(running._agentFeedback, undefined);
  const completed = await (await fetch(`${server.url}/crawl/job_1?done=1`)).json();
  assert.equal(completed._agentFeedback.v, 1);
  await middleware.shutdown();
  await server.close();
});

test("Express warns when bounded telemetry drops an old event", async () => {
  const warnings = [];
  const middleware = agentFeedback({
    apiKey: key,
    include: ["/status/*"],
    maxQueueSize: 1,
    flushIntervalMs: 60_000,
    logger: {
      debug() {},
      warn(message) {
        warnings.push(message);
      },
    },
    fetch: async () => new Response("{}", { status: 202 }),
  });
  const app = express();
  app.use(middleware);
  app.get("/status/:id", (request, response) => response.json({ id: request.params.id }));
  const server = await serve(app);

  await fetch(`${server.url}/status/one`);
  await fetch(`${server.url}/status/two`);
  assert.equal(
    warnings.filter((message) => message.includes("oldest event was dropped")).length,
    1,
  );
  await middleware.shutdown();
  await server.close();
});

test("backend downtime never fails or delays the product response", async () => {
  const middleware = agentFeedback({
    apiKey: key,
    include: ["/status"],
    flushIntervalMs: 1,
    logger: { debug() {}, warn() {} },
    fetch: async () => {
      throw new Error("offline");
    },
  });
  const app = express();
  app.use(middleware);
  app.get("/status", (_request, response) => response.json({ available: true }));
  const server = await serve(app);
  const started = performance.now();
  const response = await fetch(`${server.url}/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).available, true);
  assert.ok(performance.now() - started < 1_000);
  await server.close();
});

test("graceful shutdown has a hard telemetry deadline", async () => {
  const warnings = [];
  const middleware = agentFeedback({
    apiKey: key,
    include: ["/status"],
    flushIntervalMs: 60_000,
    telemetryTimeoutMs: 60_000,
    shutdownTimeoutMs: 25,
    logger: {
      debug() {},
      warn(message) {
        warnings.push(message);
      },
    },
    fetch: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  });
  const app = express();
  app.use(middleware);
  app.get("/status", (_request, response) => response.json({ available: true }));
  const server = await serve(app);
  await fetch(`${server.url}/status`);

  const started = performance.now();
  await middleware.shutdown();
  assert.ok(performance.now() - started < 250);
  assert.ok(warnings.some((message) => message.includes("Telemetry delivery failed")));
  await server.close();
});
