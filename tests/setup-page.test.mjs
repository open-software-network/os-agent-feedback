import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
const landingHtml = await readFile(
  new URL("../backend/public/index.html", import.meta.url),
  "utf8",
);
const productDeletionMigration = await readFile(
  new URL("../backend/migrations/0012_product_deletion.sql", import.meta.url),
  "utf8",
);
const consentModesMigration = await readFile(
  new URL("../backend/migrations/0014_feedback_consent_modes.sql", import.meta.url),
  "utf8",
);
const neverAskMigration = await readFile(
  new URL("../backend/migrations/0015_never_ask_mode.sql", import.meta.url),
  "utf8",
);
const dropLegacyDataMigration = await readFile(
  new URL("../backend/migrations/0016_drop_legacy_prototype_data.sql", import.meta.url),
  "utf8",
);
const backendMain = await readFile(new URL("../backend/src/main.rs", import.meta.url), "utf8");
const backendStore = await readFile(new URL("../backend/src/store.rs", import.meta.url), "utf8");
const backendModels = await readFile(new URL("../backend/src/models.rs", import.meta.url), "utf8");
const backendOpenApi = JSON.parse(
  await readFile(new URL("../backend/openapi.json", import.meta.url), "utf8"),
);

function assertOpenApiOperation(path, method, operationId) {
  const operation = backendOpenApi.paths?.[path]?.[method.toLowerCase()];
  assert.ok(operation, `expected ${method.toUpperCase()} ${path} in backend/openapi.json`);
  assert.equal(operation.operationId, operationId);
}

test("the root URL is the canonical signed-in app", () => {
  assert.match(backendMain, /\.route\("\/", get\(root_page\)\)/);
  assert.doesNotMatch(backendMain, /\.route\("\/app"/);
  assert.match(backendMain, /format!\("\/\?view=team&team=\{workspace_id\}"\)/);
  assert.match(dashboardScript, /location\.assign\("\/auth\/start"\)/);
  assert.doesNotMatch(backendMain, /"\/app"\.into\(\)/);
});

test("failed authentication clears stale sessions and presents a retry state", () => {
  assert.match(backendMain, /struct RootPageQuery/);
  assert.match(backendMain, /query\.auth\.as_deref\(\) == Some\("failed"\)/);
  assert.match(backendMain, /id=\\"auth-error\\" class=\\"auth-error\\" hidden/);
  const failureStart = backendMain.indexOf("fn auth_failure");
  const failureEnd = backendMain.indexOf("fn append_cookie", failureStart);
  const failure = backendMain.slice(failureStart, failureEnd);
  assert.match(failure, /clear_cookie\(ACCESS_COOKIE/);
  assert.match(failure, /clear_cookie\(REFRESH_COOKIE/);
  assert.match(landingHtml, /id="auth-error" class="auth-error" hidden/);
});

test("dashboard action notices are ephemeral fixed toasts", () => {
  assert.match(dashboardScript, /const setNotice = \(message, timeoutMs = 2800, tone = "info"\)/);
  assert.match(dashboardScript, /noticeTimer\?\.unref\?\.\(\)/);
  assert.match(dashboardStyles, /\.notice \{ position:fixed;/);
  assert.match(dashboardStyles, /\.notice-error/);
  assert.match(dashboardStyles, /@keyframes toast-in/);
  assert.match(dashboardHtml, /aria-live="polite" aria-atomic="true"/);
});

test("products exist before integration setup without an environment picker", () => {
  assert.match(dashboardHtml, /id="product-scope"/);
  assert.match(dashboardHtml, /app\.js\?v=20260731-privacy/);
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

test("collection policy distinguishes Epode-managed once and per-report consent", () => {
  assert.match(dashboardScript, /Never ask — submit autonomously/);
  assert.doesNotMatch(dashboardScript, />Auto —/);
  assert.match(dashboardScript, /Ask once — Epode remembers the answer/);
  assert.match(dashboardScript, /Ask every time — request permission for each report/);
  assert.match(dashboardScript, /never shown to the agent/);
  assert.match(dashboardScript, /Silence or ambiguity never becomes approval/);
  assert.match(backendStore, /"never_ask", "ask_once", "ask_always", "off"/);
  assert.match(neverAskMigration, /SET feedback_mode = 'never_ask'/);
  assert.match(neverAskMigration, /SET DEFAULT 'never_ask'/);
  assert.match(neverAskMigration, /'never_ask', 'ask_once', 'ask_always', 'off'/);
  assert.doesNotMatch(neverAskMigration, /'ask'/);
  assert.match(consentModesMigration, /SET feedback_mode = 'ask_always'/);
  assert.match(
    dashboardScript,
    /AGENT_FEEDBACK_MODE=\$\{dashboard\.currentEnvironment\?\.feedbackMode/,
  );
  assert.doesNotMatch(
    dashboardScript,
    /<p class="eyebrow">RETENTION<\/p>|Data lifetime|Retention period|day retention/,
  );
  assert.match(dashboardScript, /retentionDays: dashboard\.currentEnvironment\.retentionDays/);
});

test("setup offers one guided install with a manual fallback", () => {
  assert.match(dashboardScript, /Use a coding agent/);
  assert.match(dashboardScript, /Manual setup/);
  assert.match(dashboardScript, /Copy setup prompt/);
  assert.match(dashboardScript, /never the product key/);
  assert.match(dashboardScript, /Send one real interaction/);
});

test("setup explains the real customer-agent coverage path", () => {
  assert.match(dashboardScript, /Customer-agent coverage: native MCP/);
  assert.match(dashboardScript, /No separate Epode install is required/);
  assert.match(dashboardScript, /CUSTOMER COVERAGE/);
  assert.match(
    dashboardScript,
    /Your company-side integration is complete without another install/,
  );
  assert.match(dashboardScript, /optionally share Epode Companion once/);
  assert.match(dashboardScript, /reliable Codex and Claude Code handling/);
  assert.match(dashboardScript, /codex plugin marketplace add open-software-network\/os-epode/);
  assert.match(
    dashboardScript,
    /there is no Epode account, key, or per-product setup for the user/,
  );
});

test("setup links to the public Mintlify documentation", () => {
  assert.match(dashboardScript, /https:\/\/docs\.epode\.ai/);
  assert.match(dashboardScript, /Read the integration docs/);
});

test("installation is ready without a setup generation step", () => {
  assert.match(dashboardScript, /Installation ready/);
  assert.match(dashboardScript, /Default product key/);
  assert.match(
    dashboardScript,
    /!dashboard\.apiKeys\.some\(\(key\) => keyKind\(key\) === "write"\)/,
  );
  assert.doesNotMatch(dashboardScript, /Generate installation/);
  assert.doesNotMatch(dashboardScript, /data-create-key/);
  assert.doesNotMatch(dashboardScript, /Choose an integration and generate its installation first/);
});

test("setup warns about legacy keys and keeps rotation visible", () => {
  assert.match(dashboardScript, /function isLegacyKeyPrefix\(prefix\)/);
  assert.match(dashboardScript, /if \(!prefix\) return false/);
  assert.match(dashboardScript, /\/\^af_\(live\|read\)_\[0-9a-f\]\{8\}\$\//);
  assert.match(dashboardScript, /class="secret-callout warning"/);
  assert.match(dashboardStyles, /\.secret-callout\.warning/);
  assert.match(dashboardHtml, /styles\.css\?v=20260731-coverage/);
  assert.match(dashboardScript, /legacy key and cannot produce valid afr2 capabilities/i);
  assert.match(dashboardScript, /V2 integrations will fail boot validation/);
  assert.match(dashboardScript, /current key will keep working for one hour/);
  assert.match(
    dashboardScript,
    /update the <code>AGENT_FEEDBACK_KEY<\/code> server environment variable/,
  );
  assert.match(dashboardScript, /Create new key[\s\S]*<details class="existing-connections">/);
  assert.doesNotMatch(
    dashboardScript,
    /<details class="existing-connections">[\s\S]*Create new key/,
  );
});

test("rotating a key uses the atomic overlap endpoint", () => {
  assert.match(
    dashboardScript,
    /const rotated = dashboard\.apiKeys\.find\(\(key\) => key\.id === target\.dataset\.revokeKey\)/,
  );
  assert.match(dashboardScript, /const kind = keyKind\(rotated\)/);
  assert.match(
    dashboardScript,
    /api\/settings\/api-keys\/\$\{target\.dataset\.revokeKey\}\/rotate/,
  );
  assert.doesNotMatch(dashboardScript, /target\.dataset\.revokeKey\}.*method: "DELETE"/);
  assert.match(dashboardScript, /within one hour/);
});

test("key rows surface kind, expiry, and last-used", () => {
  assert.match(dashboardScript, /function keyKind\(key\)/);
  assert.match(dashboardScript, /class="key-kind \$\{esc\(keyKind\(key\)\)\}"/);
  assert.match(dashboardScript, /expires \$\{key\.expiresAt \? date\(key\.expiresAt\) : "never"\}/);
  assert.match(
    dashboardScript,
    /key\.lastUsedAt \? `last used \$\{date\(key\.lastUsedAt\)\}` : "never used"/,
  );
  assert.match(dashboardStyles, /\.key-kind/);
  assert.match(dashboardStyles, /\.key-kind\.read/);
});

test("read keys are created with a 90-day default expiry and an explicit never option", () => {
  assert.match(dashboardScript, /id="read-key-form"/);
  assert.match(dashboardScript, /<option value="7776000" selected>90 days<\/option>/);
  assert.match(dashboardScript, /<option value="never">Never<\/option>/);
  assert.match(dashboardScript, /kind: "read"/);
  assert.match(
    dashboardScript,
    /if \(expiresIn !== "never"\) payload\.expiresInSeconds = Number\(expiresIn\)/,
  );
  assert.match(dashboardScript, /Save this read key now/);
  assert.match(
    dashboardScript,
    /rememberSetupSecret\(dashboard\.currentEnvironment\.id, body\.secret, "read"\)/,
  );
});

test("read keys ship per-client MCP config snippets, not a server env variable", () => {
  assert.match(dashboardScript, /function readKeyClientSnippets\(\)/);
  assert.match(dashboardScript, /data-read-client/);
  assert.match(dashboardScript, /AGENT_FEEDBACK_READ_KEY/);
  assert.match(dashboardScript, /"mcpServers"/);
  assert.match(dashboardScript, /"type": "http"/);
  assert.match(dashboardScript, /\\\$\{env:AGENT_FEEDBACK_READ_KEY\}/);
  assert.match(dashboardScript, /promptString/);
  assert.match(dashboardScript, /"servers"/);
  assert.match(dashboardScript, /\\\$\{input:epode-read-key\}/);
});

test("new products receive their product key automatically", () => {
  assert.match(backendMain, /create_product_with_default_key/);
  assert.match(backendStore, /'Default product key'[\s\S]*'write'/);
  assert.match(backendMain, /Json\(ProductCreatedResponse \{[\s\S]*api_key,[\s\S]*secret,/);
  assert.match(backendStore, /None => None/);
  assert.doesNotMatch(backendMain, /\/api\/products\/\{product_id\}\/environments/);
  assert.doesNotMatch(backendModels, /CreateEnvironmentInput/);
});

test("owners and admins can rename teams and products without replacing their IDs", () => {
  assertOpenApiOperation("/api/team", "patch", "rename_team_handler");
  assertOpenApiOperation("/api/products/{product_id}", "patch", "rename_product_handler");
  assert.match(backendMain, /\.routes\(routes!\(rename_team_handler\)\)/);
  assert.match(
    backendMain,
    /\.routes\(routes!\(rename_product_handler, delete_product_handler\)\)/,
  );
  assert.match(backendMain, /async fn rename_team_handler[\s\S]*require_workspace_editor/);
  assert.match(backendMain, /async fn rename_product_handler[\s\S]*require_workspace_editor/);
  assert.match(backendStore, /pub(?:\(crate\))? async fn rename_workspace/);
  assert.match(backendStore, /UPDATE workspaces SET name = \$1, slug = \$2/);
  assert.match(backendStore, /pub(?:\(crate\))? async fn rename_product/);
  assert.match(backendStore, /UPDATE products SET name = \$1, slug = \$2/);
  assert.match(dashboardScript, /data-rename-team/);
  assert.match(dashboardScript, /data-rename-product/);
});

test("owners and admins can permanently delete a product with exact-name confirmation", () => {
  assertOpenApiOperation("/api/products/{product_id}", "delete", "delete_product_handler");
  assert.match(
    backendMain,
    /\.routes\(routes!\(rename_product_handler, delete_product_handler\)\)/,
  );
  assert.match(backendMain, /async fn delete_product_handler[\s\S]*require_workspace_editor/);
  assert.match(backendStore, /pub(?:\(crate\))? async fn delete_product/);
  assert.match(backendStore, /input\.confirmation\.trim\(\) != product\.name/);
  assert.match(
    backendStore,
    /DELETE FROM products WHERE id = \$1 AND workspace_id = \$2 RETURNING \*/,
  );
  assert.equal((productDeletionMigration.match(/ON DELETE CASCADE/g) || []).length, 3);
  assert.match(dashboardScript, /data-delete-product/);
  assert.match(dashboardScript, /permanently delete this product and all of its data/);
  assert.match(dashboardScript, /method: "DELETE"/);
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
  assert.match(dashboardScript, /Telemetry and Ask once state refreshes run in the background/);
  assert.match(dashboardScript, /never delay the product response/);
  assert.match(dashboardScript, /MCP 2026-07-28 is stateless/);
  assert.match(dashboardScript, /createMcpInstrumentation/);
  assert.match(dashboardScript, /context\.http\?\.authInfo\?\.extra\?\.accountId/);
  assert.match(dashboardScript, /createMcpHandler/);
  assert.match(dashboardScript, /server\/discover/);
  assert.match(dashboardScript, /Mcp-Method/);
  assert.match(dashboardScript, /Mcp-Name/);
});

test("every enabled setup choice has a fresh executable E2E example", async () => {
  const expected = {
    mcp: ["node-mcp", "manual-mcp"],
    api: [
      "node-express",
      "node-fastify",
      "python-asgi",
      "python-wsgi",
      "go",
      "rust",
      "manual-http",
    ],
    website: [
      "node-express",
      "node-fastify",
      "python-asgi",
      "python-wsgi",
      "go",
      "rust",
      "manual-http",
    ],
  };
  for (const [surface, integrations] of Object.entries(expected)) {
    const start = dashboardScript.indexOf(`  ${surface}: [`);
    const end = dashboardScript.indexOf("  ],", start);
    const block = dashboardScript.slice(start, end);
    assert.ok(start >= 0 && end > start, `missing ${surface} setup block`);
    assert.deepEqual(
      [...block.matchAll(/\["([^"]+)"/g)].map((match) => match[1]),
      integrations,
    );
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
  await Promise.all(
    fixtures.map((fixture) => access(new URL(`../examples/${fixture}`, import.meta.url))),
  );
  assert.match(
    await readFile(new URL("setup-matrix-e2e.mjs", import.meta.url), "utf8"),
    /expected\.size, 64/,
  );
});

test("legacy prototype records and UI are removed", () => {
  for (const table of ["feedback_receipts", "feedback", "agent_events", "agent_sessions"]) {
    assert.match(dropLegacyDataMigration, new RegExp(`DROP TABLE IF EXISTS ${table}`));
  }
  assert.doesNotMatch(
    dashboardScript,
    /legacyFeedback|legacySessions|legacyEvents|data-toggle-legacy/,
  );
  assert.doesNotMatch(backendModels, /legacy_feedback|legacy_sessions|legacy_events/);
  assert.doesNotMatch(
    backendMain,
    /\.route\("\/api\/v1\/|V1_WRITES_ENABLED|async fn start_session_handler/,
  );
});
