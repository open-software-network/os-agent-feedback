import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createJourneyRegistry,
  resolveJourney,
} from "../examples/node-mcp/src/journey-registry.js";

const source = await readFile(
  new URL("../examples/node-express/src/index.js", import.meta.url),
  "utf8",
);
const mcpSource = await readFile(
  new URL("../examples/node-mcp/src/index.js", import.meta.url),
  "utf8",
);
const fastifySource = await readFile(
  new URL("../examples/node-fastify/src/index.js", import.meta.url),
  "utf8",
);
const pythonAsgiSource = await readFile(
  new URL("../examples/python-asgi/app.py", import.meta.url),
  "utf8",
);
const crawlSource = await readFile(
  new URL("../examples/icp-crawl-fastify/index.js", import.meta.url),
  "utf8",
);
const goDocs = await readFile(new URL("../docs/integrations/go-http.mdx", import.meta.url), "utf8");
const goExample = await readFile(new URL("../examples/go-http/main.go", import.meta.url), "utf8");

test("the hosted playground creates feedback opportunities without trusting caller identity", () => {
  assert.match(source, /include: \["\/api\/status", "\/api\/recommendation"\]/);
  assert.doesNotMatch(source, /customerRef:.*header/);
  assert.match(source, /sessionRef: experimentRefsEnabled/);
  assert.match(source, /EPODE_EXAMPLE_ENABLE_EXPERIMENT_REFS/);
  assert.match(source, /hosted playground is anonymous/);
  assert.match(source, /runtimeHint: \(request\) => request\.header\("user-agent"\)/);
  assert.match(source, /reliability/);
  assert.match(source, /speed/);
  assert.match(source, /cost/);
});

test("hosted HTTP and MCP examples support every feedback mode", () => {
  assert.match(source, /process\.env\.AGENT_FEEDBACK_MODE \|\| "never_ask"/);
  assert.match(source, /"off"/);
  assert.match(source, /feedbackMode,/);
  assert.match(mcpSource, /process\.env\.AGENT_FEEDBACK_MODE \|\| "never_ask"/);
  assert.match(mcpSource, /feedbackMode === "off"/);
  assert.match(mcpSource, /feedbackMode,/);
  assert.match(mcpSource, /record_product_feedback_consent/);
  assert.match(mcpSource, /Epode—not this client—remembers the decision/);
  assert.match(mcpSource, /Ask the exact returned question before each report/);
  assert.doesNotMatch(mcpSource, /customerRef: \(arguments_\) => arguments_\?\.experimentRef/);
  assert.match(mcpSource, /sessionRef: \(arguments_, context, result\) => resolveJourney/);
  assert.match(mcpSource, /request\.auth =/);
  assert.doesNotMatch(mcpSource, /Mcp-Session-Id|recordCompletion/);
  assert.match(mcpSource, /scope: "regional"/);
  assert.match(mcpSource, /checkedAt: new Date\(\)\.toISOString\(\)/);
});

test("Node MCP example resolves only canonical account-owned journeys", () => {
  const registry = createJourneyRegistry();
  const accountA = { http: { authInfo: { extra: { accountId: "account-a" } } } };
  const accountB = { http: { authInfo: { extra: { accountId: "account-b" } } } };
  const first = registry.create("account-a");
  const second = registry.create("account-a");
  const idempotent = registry.create("account-a", "stable-create");

  assert.notEqual(first, second);
  assert.equal(registry.create("account-a", "stable-create"), idempotent);
  assert.notEqual(registry.create("account-b", "stable-create"), idempotent);
  assert.notEqual(registry.create("account:a", "shared"), registry.create("account", "a:shared"));
  assert.equal(resolveJourney(registry, { journeyId: first }, accountA), first);
  assert.equal(
    resolveJourney(registry, { journeyId: first }, accountA),
    first,
    "cache/dedup reuse",
  );
  assert.equal(
    resolveJourney(registry, {}, accountA, { structuredContent: { journeyId: first } }),
    first,
  );
  assert.equal(
    resolveJourney(registry, { journeyId: second }, accountA, {
      structuredContent: { journeyId: first },
    }),
    first,
    "a product-owned completed result wins over a caller candidate",
  );
  for (const [candidate, context] of [
    [undefined, accountA],
    ["not-a-journey", accountA],
    ["journey_00000000-0000-0000-0000-000000000000", accountA],
    [first, accountB],
    [first, {}],
  ]) {
    assert.equal(resolveJourney(registry, { journeyId: candidate }, context), undefined);
  }
});

test("public examples use verified or deliberately anonymous customer identity", () => {
  assert.doesNotMatch(source, /customerRef:.*x-customer-ref/);
  assert.doesNotMatch(fastifySource, /customerRef:.*x-customer-ref/);
  assert.doesNotMatch(pythonAsgiSource, /customer_ref=.*x-customer-ref/);
  assert.match(pythonAsgiSource, /public example is anonymous/);
  assert.match(crawlSource, /Bearer demo-crawl-team-token/);
  assert.match(crawlSource, /accountRef: \(request\) => request\.productAuth\?\.accountId/);
  assert.match(crawlSource, /userRef: \(request\) => request\.productAuth\?\.userId/);
  assert.match(crawlSource, /anonymousRef: \(request\) => request\.productAuth\?\.anonymousId/);
  assert.match(
    crawlSource,
    /AGENT_FEEDBACK_MODE === "ask_once"[\s\S]{0,100}\(request\) => request\.productAuth\?\.accountId/,
  );
  assert.match(crawlSource, /sessionRef: \(request\) => request\.params\?\.id/);
  assert.doesNotMatch(crawlSource, /customerRef:.*x-team-id/);
});

test("runnable servers close cleanly before flushing feedback telemetry", () => {
  assert.match(source, /server\.close\(\(error\)/);
  assert.match(fastifySource, /const shutdown = async \(\) => app\.close\(\)/);
  assert.match(mcpSource, /server\.close\(\(error\)/);
  assert.match(pythonAsgiSource, /feedback_app\.shutdown\(\)/);
  assert.match(crawlSource, /const shutdown = async \(\) => app\.close\(\)/);
  assert.doesNotMatch(goDocs, /log\.Fatal\(http\.ListenAndServe/);
  assert.match(goDocs, /errors\.Join\(serveErr, serverErr, feedbackErr\)/);
  assert.match(goExample, /feedback\.Shutdown\(feedbackContext\)/);
  assert.ok(
    goExample.indexOf("feedback.Shutdown(feedbackContext)") <
      goExample.indexOf("log.Fatal(serveErr)"),
  );
});
