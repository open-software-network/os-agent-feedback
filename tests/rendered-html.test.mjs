import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Epode product contract", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Epode — product feedback from customer agents/i);
  assert.match(html, /Did your product actually work for your customer/i);
  assert.match(html, /agentFeedback/);
  assert.match(html, /Node, Python, Go, Rust/i);
  assert.match(html, /language-neutral protocol/i);
  assert.match(html, /helped_with_friction/);
  assert.match(html, /strength/);
  assert.doesNotMatch(html, /OS Accounts|Open Software Account/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Building your site/i);
});

test("links to the canonical app origin", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /https:\/\/app\.epode\.ai\/auth\/start/);
  assert.doesNotMatch(html, /agent-feedback-api-production\.up\.railway\.app/);
});
