import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { agentFeedback } from "../dist/fastify.js";

const key = `af_live_1123456789abcdef0123456789abcdef_${"y".repeat(32)}`;

test("Fastify instruments JSON and agent-readable HTML", async () => {
  const telemetry = [];
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    include: ["/api/*", "/docs"],
    flushIntervalMs: 1,
    fetch: async (_url, init) => {
      telemetry.push(JSON.parse(init.body));
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/api/search", async () => ({ answer: "found" }));
  app.get("/docs", async (_request, reply) => {
    reply.type("text/html");
    return "<!doctype html><html><head><title>Docs</title></head><body>Useful docs</body></html>";
  });
  await app.ready();

  const json = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(json.statusCode, 200);
  assert.equal(json.json().answer, "found");
  assert.equal(json.json()._agentFeedback.v, 1);
  const html = await app.inject({ method: "GET", url: "/docs" });
  assert.match(html.body, /id="agent-feedback"/);
  assert.match(html.body, /submit_product_feedback/i);
  await plugin.shutdown();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].events.length, 2);
  await app.close();
});

test("Fastify Ask-once never awaits Epode and keeps consent_required through an outage", async () => {
  let rejectLookup;
  let consentLookups = 0;
  const pendingLookup = new Promise((_resolve, reject) => {
    rejectLookup = reject;
  });
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_unavailable",
    include: ["/api/search"],
    flushIntervalMs: 1,
    logger: { debug() {}, warn() {} },
    fetch: async (url) => {
      if (!String(url).endsWith("/api/v2/consent/state")) {
        return new Response("{}", { status: 202 });
      }
      consentLookups += 1;
      if (consentLookups === 1) return pendingLookup;
      throw new Error("Epode unavailable");
    },
  });
  await app.register(plugin);
  app.get("/api/search", async () => ({ answer: "found" }));
  await app.ready();

  const firstRequest = app.inject({ method: "GET", url: "/api/search" });
  const firstResult = await Promise.race([
    firstRequest,
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 250)),
  ]);
  assert.notEqual(firstResult, "timed_out", "the product response joined the consent lookup");
  assert.equal(firstResult.json()._agentFeedback.state, "consent_required");
  rejectLookup(new Error("Epode unavailable"));
  await new Promise((resolve) => setImmediate(resolve));

  const second = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(second.json()._agentFeedback.state, "consent_required");
  assert.equal(consentLookups, 2);
  await plugin.shutdown();
  await app.close();
});

test("Fastify request cache mode varies ordinary and agent responses", async () => {
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    include: ["/api/search"],
    cacheMode: "request",
    flushIntervalMs: 60_000,
    fetch: async () => new Response("{}", { status: 202 }),
  });
  await app.register(plugin);
  app.get("/api/search", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    reply.header("vary", "Accept-Encoding");
    return { answer: "cached" };
  });
  await app.ready();

  const ordinary = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(ordinary.json()._agentFeedback, undefined);
  assert.match(ordinary.headers.vary, /Accept-Encoding/);
  assert.match(ordinary.headers.vary, /Agent-Feedback-Request/);
  const agent = await app.inject({
    method: "GET",
    url: "/api/search",
    headers: { "agent-feedback-request": "1" },
  });
  assert.equal(agent.json()._agentFeedback.v, 1);
  assert.equal(agent.headers["cache-control"], "private, no-store");
  assert.match(agent.headers.vary, /Agent-Feedback-Request/);
  await plugin.flush();
  await app.close();
});

test("Fastify Ask-once does no consent work for ineligible responses", async () => {
  let consentLookups = 0;
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_ineligible",
    include: ["/error", "/shared", "/existing"],
    flushIntervalMs: 1,
    fetch: async (url) => {
      if (String(url).endsWith("/api/v2/consent/state")) consentLookups += 1;
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/error", async (_request, reply) => reply.code(503).send({ error: true }));
  app.get("/shared", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=60");
    return { answer: "cached" };
  });
  app.get("/existing", async () => ({
    answer: "owned",
    _agentFeedback: { state: "owned" },
  }));
  app.get("/excluded", async () => ({ answer: "excluded" }));
  await app.ready();

  for (const url of ["/error", "/shared", "/existing", "/excluded"]) {
    await app.inject({ method: "GET", url });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(consentLookups, 0);
  await plugin.shutdown();
  await app.close();
});

test("Fastify Ask-once can use a decision warmed into the local cache", async () => {
  let resolveLookup;
  let consentLookups = 0;
  const pendingLookup = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_cached",
    include: ["/api/search"],
    flushIntervalMs: 1,
    fetch: async (url) => {
      if (!String(url).endsWith("/api/v2/consent/state")) {
        return new Response("{}", { status: 202 });
      }
      consentLookups += 1;
      return pendingLookup;
    },
  });
  await app.register(plugin);
  app.get("/api/search", async () => ({ answer: "found" }));
  await app.ready();

  const first = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(first.json()._agentFeedback.state, "consent_required");
  resolveLookup(
    new Response('{"state":"approved"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  const second = await app.inject({ method: "GET", url: "/api/search" });
  assert.equal(second.json()._agentFeedback.state, "feedback_ready");
  assert.equal(second.json()._agentFeedback.configuredMode, "ask_once");
  assert.equal(consentLookups, 1);
  await plugin.shutdown();
  await app.close();
});

test("Fastify omits feedback and background work when JSON serialization ends as a 500", async () => {
  const requests = [];
  const app = Fastify();
  const plugin = agentFeedback({
    apiKey: key,
    endpoint: "https://feedback.test",
    feedbackMode: "ask_once",
    customerRef: () => "acct_circular",
    include: ["/api/circular"],
    flushIntervalMs: 1,
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body });
      return new Response("{}", { status: 202 });
    },
  });
  await app.register(plugin);
  app.get("/api/circular", async () => {
    const body = { answer: "found" };
    body.self = body;
    return body;
  });
  app.setErrorHandler((_error, _request, reply) => {
    reply.code(500).send({ error: "serialization failed" });
  });
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/api/circular" });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: "serialization failed" });
  assert.equal(response.headers["agent-feedback"], undefined);
  await plugin.shutdown();
  assert.deepEqual(requests, []);
  await app.close();
});
