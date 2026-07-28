import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import test from "node:test";

const dashboardScript = await readFile(
  new URL("../backend/public/app.js", import.meta.url),
  "utf8",
);
const dashboardHtml = await readFile(
  new URL("../backend/public/app.html", import.meta.url),
  "utf8",
);
const dashboardStyles = await readFile(
  new URL("../backend/public/styles.css", import.meta.url),
  "utf8",
);
const productMigration = await readFile(
  new URL("../backend/migrations/0008_products_and_environments.sql", import.meta.url),
  "utf8",
);
const migratedProductLabel = await readFile(
  new URL("../backend/migrations/0009_label_migrated_products.sql", import.meta.url),
  "utf8",
);
const backendMain = await readFile(
  new URL("../backend/src/main.rs", import.meta.url),
  "utf8",
);
const backendStore = await readFile(
  new URL("../backend/src/store.rs", import.meta.url),
  "utf8",
);
const backendModels = await readFile(
  new URL("../backend/src/models.rs", import.meta.url),
  "utf8",
);

test("products exist before integration setup without an environment picker", () => {
  assert.match(dashboardHtml, /id="product-scope"/);
  assert.match(dashboardHtml, /app\.js\?v=20260728-simple-invites/);
  assert.match(dashboardScript, /Create your first product/);
  assert.match(dashboardScript, /id="product-select"/);
  assert.match(dashboardScript, /\+ New product/);
  assert.doesNotMatch(dashboardScript, /id="environment-select"/);
  assert.doesNotMatch(dashboardScript, /data-new-environment/);
  assert.doesNotMatch(dashboardScript, /First environment/);
  assert.doesNotMatch(dashboardScript, /id="setup-connection-name"/);
  assert.doesNotMatch(dashboardScript, /id="setup-environment"/);
});

test("setup starts with the selected product integration", () => {
  assert.match(dashboardScript, /Choose how your product is served/);
  assert.match(dashboardScript, /MCP server/);
  assert.match(dashboardScript, /HTTP API/);
  assert.match(dashboardScript, /Server-rendered website/);
  assert.match(dashboardScript, /Static site or CMS/);
  assert.match(dashboardScript, /setupStackOptions\[setupSurface\]/);
  assert.doesNotMatch(dashboardScript, /Run backend contract test/);
});

test("setup offers one guided install with a manual fallback", () => {
  assert.match(dashboardScript, /Use a coding agent/);
  assert.match(dashboardScript, /Manual setup/);
  assert.match(dashboardScript, /Copy setup prompt/);
  assert.match(dashboardScript, /never the product key/);
  assert.match(dashboardScript, /Send one real interaction/);
});

test("installation is ready without a setup generation step", () => {
  assert.match(dashboardScript, /Installation ready/);
  assert.match(dashboardScript, /Default product key/);
  assert.match(dashboardScript, /currentView === "setup" && dashboard\.currentRole !== "member" && dashboard\.currentEnvironment && !dashboard\.apiKeys\.length/);
  assert.doesNotMatch(dashboardScript, /Generate installation/);
  assert.doesNotMatch(dashboardScript, /data-create-key/);
  assert.doesNotMatch(dashboardScript, /Choose an integration and generate its installation first/);
});

test("setup warns about legacy keys and keeps rotation visible", () => {
  assert.match(dashboardScript, /function isLegacyKeyPrefix\(prefix\)/);
  assert.match(dashboardScript, /if \(!prefix\) return false/);
  assert.match(dashboardScript, /\/\^af_live_\[0-9a-f\]\{8\}\$\//);
  assert.match(dashboardScript, /class="secret-callout warning"/);
  assert.match(dashboardStyles, /\.secret-callout\.warning/);
  assert.match(dashboardHtml, /styles\.css\?v=20260728-simple-invites/);
  assert.match(dashboardScript, /legacy key and cannot produce valid afr2 capabilities/i);
  assert.match(dashboardScript, /V2 integrations will fail boot validation/);
  assert.match(dashboardScript, /The current key stops working immediately/);
  assert.match(dashboardScript, /update the <code>AGENT_FEEDBACK_KEY<\/code> server environment variable/);
  assert.match(dashboardScript, /Create new key[\s\S]*<details class="existing-connections">/);
  assert.doesNotMatch(dashboardScript, /<details class="existing-connections">[\s\S]*Create new key/);
});

test("new products receive their product key automatically", () => {
  const defaultKeyCreations = backendMain.match(/Some\("Default product key"\.into\(\)\),\s+None,/g) || [];
  assert.equal(defaultKeyCreations.length, 1);
  assert.match(backendMain, /"apiKey": api_key/);
  assert.match(backendMain, /"secret": secret/);
  assert.match(backendStore, /None => None/);
  assert.doesNotMatch(backendMain, /\/api\/products\/\{product_id\}\/environments/);
  assert.doesNotMatch(backendModels, /CreateEnvironmentInput/);
});

test("routes stay in code and key expiration stays out of onboarding", () => {
  assert.doesNotMatch(dashboardScript, /id="setup-route"/);
  assert.doesNotMatch(dashboardScript, /id="api-key-expiration"/);
  assert.match(dashboardScript, /include: \["\$\{route\}"\]/);
  assert.match(dashboardScript, /environmentId: dashboard\.currentEnvironment\.id/);
});

test("setup verifies the connection with data from its own product key", () => {
  assert.match(dashboardScript, /entry\.apiKeyId === apiKeyId/);
  assert.match(dashboardScript, /Waiting for the first interaction/);
  assert.match(dashboardScript, /Waiting for agent feedback/);
  assert.match(dashboardScript, /setupConnectionId = body\.apiKey\.id/);
});

test("setup communicates the HTTP and MCP evidence models separately", () => {
  assert.match(dashboardScript, /confirmed agent interaction/);
  assert.match(dashboardScript, /becomes confirmed when its receipt returns/);
  assert.match(dashboardScript, /product response never waits for Agent Feedback/i);
});

test("every enabled setup choice has a fresh executable E2E example", async () => {
  const expected = {
    mcp: ["node-mcp", "manual-mcp"],
    api: ["node-express", "node-fastify", "python-asgi", "python-wsgi", "go", "rust", "manual-http"],
    website: ["node-express", "node-fastify", "python-asgi", "python-wsgi", "go", "rust", "manual-http"],
  };
  for (const [surface, integrations] of Object.entries(expected)) {
    const start = dashboardScript.indexOf(`  ${surface}: [`);
    const end = dashboardScript.indexOf("  ],", start);
    const block = dashboardScript.slice(start, end);
    assert.ok(start >= 0 && end > start, `missing ${surface} setup block`);
    assert.deepEqual([...block.matchAll(/\["([^"]+)"/g)].map((match) => match[1]), integrations);
  }
  const fixtures = [
    "setup-matrix-node-express/index.js",
    "setup-matrix-node-fastify/index.js",
    "setup-matrix-python-asgi/app.py",
    "setup-matrix-python-wsgi/app.py",
    "setup-matrix-go/main.go",
    "setup-matrix-rust/src/main.rs",
    "setup-matrix-manual-http/server.py",
    "setup-matrix-node-mcp/index.js",
    "setup-matrix-manual-mcp/server.py",
  ];
  await Promise.all(fixtures.map((fixture) => access(new URL(`../examples/${fixture}`, import.meta.url))));
  assert.match(await readFile(new URL("setup-matrix-e2e.mjs", import.meta.url), "utf8"), /expected\.size, 16/);
});

test("legacy v2 data remains linked to its migrated product", () => {
  assert.match(productMigration, /CREATE TABLE products/);
  assert.match(productMigration, /CREATE TABLE product_environments/);
  assert.match(productMigration, /legacy-product/);
  assert.match(productMigration, /legacy-production/);
  assert.match(productMigration, /ALTER COLUMN environment_id SET NOT NULL/);
  assert.match(migratedProductLabel, /Existing product/);
});
