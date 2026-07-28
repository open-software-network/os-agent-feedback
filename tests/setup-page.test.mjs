import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardScript = await readFile(
  new URL("../backend/public/app.js", import.meta.url),
  "utf8",
);
const dashboardHtml = await readFile(
  new URL("../backend/public/app.html", import.meta.url),
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
  assert.match(dashboardHtml, /app\.js\?v=20260728-product-only/);
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
  assert.match(dashboardScript, /currentView === "setup" && dashboard\.currentEnvironment && !dashboard\.apiKeys\.length/);
  assert.doesNotMatch(dashboardScript, /Generate installation/);
  assert.doesNotMatch(dashboardScript, /data-create-key/);
  assert.doesNotMatch(dashboardScript, /Choose an integration and generate its installation first/);
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

test("legacy v2 data remains linked to its migrated product", () => {
  assert.match(productMigration, /CREATE TABLE products/);
  assert.match(productMigration, /CREATE TABLE product_environments/);
  assert.match(productMigration, /legacy-product/);
  assert.match(productMigration, /legacy-production/);
  assert.match(productMigration, /ALTER COLUMN environment_id SET NOT NULL/);
  assert.match(migratedProductLabel, /Existing product/);
});
