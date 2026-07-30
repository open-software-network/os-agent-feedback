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
  assert.match(html.body, /POST exactly one JSON feedback report/i);
  await plugin.shutdown();
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0].events.length, 2);
  await app.close();
});
