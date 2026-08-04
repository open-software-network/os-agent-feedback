import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const examples = [
  "mvp-retail-express",
  "mvp-travel-mcp",
  "mvp-media-fastify",
  "mvp-b2b-python",
  "mvp-anonymous-express",
];

test("the thin MVP ships five realistic company-owned examples", async () => {
  for (const name of examples) {
    await access(new URL(`../examples/${name}/README.md`, import.meta.url));
  }
  const retail = await read("examples/mvp-retail-express/index.js");
  assert.match(retail, /anonymousRef: request\.visitorId/);
  assert.match(retail, /accountRef: request\.customer\?\.accountId/);
  assert.match(retail, /customer\.context\.get/);
  assert.match(retail, /customer\.personalization\.decide/);
  assert.match(retail, /customer\.outcomes\.track/);
  assert.match(retail, /outcome: "conversion"/);

  const travel = await read("examples/mvp-travel-mcp/index.js");
  assert.match(travel, /customer\.instrument\(server\)/);
  assert.match(travel, /context\.http\?\.authInfo\?\.extra\?\.userId/);

  const media = await read("examples/mvp-media-fastify/index.js");
  assert.match(media, /outcome: "engagement"/);
  assert.match(media, /"\/agent-home"/);
  assert.match(media, /Content-Security-Policy/);

  const anonymous = await read("examples/mvp-anonymous-express/index.js");
  assert.match(anonymous, /purpose: "targeted_advertising"/);
  assert.match(anonymous, /interest\.topic:outdoor_travel/);
  assert.match(anonymous, /timingSafeEqual/);
  assert.match(anonymous, /"\/api\/ephemeral-discover"/);
  assert.match(anonymous, /customer\.contextFor\(request\)/);
  assert.match(anonymous, /sessionRef: \(request\) => request\.journeyId/);
  assert.match(anonymous, /runtimeHint: \(\) => "anonymous-express\/1\.0"/);

  const python = await read("examples/mvp-b2b-python/app.py");
  assert.match(python, /\/_epode\/v1\/enrichment\/answers/);
  assert.match(python, /"accountRef": "b2b_workspace_42"/);
  assert.match(python, /"outcome": "completion"/);
});

test("new JavaScript and Python examples are syntactically valid", async () => {
  for (const name of examples.filter((entry) => entry !== "mvp-b2b-python")) {
    execFileSync(process.execPath, [
      "--check",
      new URL(`../examples/${name}/index.js`, import.meta.url).pathname,
    ]);
  }
  for (const name of ["mvp-retail-express", "mvp-anonymous-express"]) {
    execFileSync(process.execPath, [
      "--check",
      new URL(`../examples/${name}/cookie-secret.js`, import.meta.url).pathname,
    ]);
  }
  execFileSync("python3", [
    "-m",
    "py_compile",
    new URL("../examples/mvp-b2b-python/app.py", import.meta.url).pathname,
  ]);
});

test("the Node contract uses exact backend paths and purpose-scoped types", async () => {
  const source = await read("sdk/node/src/customer.ts");
  for (const path of [
    "/api/v2/enrichment/requests",
    "/api/v2/enrichment/requests/inspect",
    "/api/v2/enrichment/consent/decisions",
    "/api/v2/enrichment/answers",
    "/api/v2/customer-context",
    "/api/v2/personalization/decisions",
    "/api/v2/personalization/outcomes",
  ]) {
    assert.ok(source.includes(path), `SDK omits ${path}`);
  }
  assert.match(source, /"product_personalization" \| "targeted_advertising"/);
  assert.match(source, /"http_json" \| "html" \| "mcp"/);
  assert.match(source, /"agent_reports_user_statement"/);
  assert.match(source, /"agent_reports_current_task"/);
  assert.match(source, /"agent_inference"/);
  assert.match(source, /EPODE_API_KEY/);
});

test("the published Node package identity and customer entrypoints match the quickstart", async () => {
  const manifest = JSON.parse(await read("sdk/node/package.json"));
  assert.equal(manifest.name, "@epode/node");
  assert.equal(manifest.version, "0.4.0");
  for (const entrypoint of [
    ".",
    "./express",
    "./fastify",
    "./mcp",
    "./customer",
    "./customer/express",
    "./customer/fastify",
    "./customer/mcp",
  ]) {
    assert.ok(manifest.exports[entrypoint], `missing package export ${entrypoint}`);
  }
});

test("agent writes stay same-origin and never receive the company key", async () => {
  const [customer, expressAdapter, fastifyAdapter] = await Promise.all([
    read("sdk/node/src/customer.ts"),
    read("sdk/node/src/customer-express.ts"),
    read("sdk/node/src/customer-fastify.ts"),
  ]);
  assert.match(customer, /"\/_epode\/v1\/enrichment\/consent"/);
  assert.match(customer, /"\/_epode\/v1\/enrichment\/answers"/);
  assert.match(customer, /authorization: `Bearer \$\{handle\}`/);
  assert.doesNotMatch(
    `${expressAdapter}\n${fastifyAdapter}`,
    /authorization:\s*`Bearer \$\{[^}]*apiKey/,
  );
});

test("company HTTP adapters protect relays and instrument only bounded HTML strings", async () => {
  const [customer, expressAdapter, fastifyAdapter, expressDocs, fastifyDocs] = await Promise.all([
    read("sdk/node/src/customer.ts"),
    read("sdk/node/src/customer-express.ts"),
    read("sdk/node/src/customer-fastify.ts"),
    read("docs/integrations/node-express.mdx"),
    read("docs/integrations/node-fastify.mdx"),
  ]);
  assert.match(customer, /epode-customer-context/);
  assert.match(customer, /maximumBytes = 512 \* 1024/);
  assert.match(expressAdapter, /authenticate\?: RequestHandler/);
  assert.match(
    fastifyAdapter,
    /if \(isRelay\(request\) \|\| !matches\(request, options\)\) return/,
  );
  assert.match(expressDocs, /authenticate: authenticateProductRequest/);
  assert.match(fastifyDocs, /authenticate: authenticateProductRequest/);
  assert.match(`${expressDocs}\n${fastifyDocs}`, /base64url/);
});

test("public cookie examples fail closed outside explicit local demo mode", async () => {
  const retail = await import(
    new URL("../examples/mvp-retail-express/cookie-secret.js", import.meta.url)
  );
  const anonymous = await import(
    new URL("../examples/mvp-anonymous-express/cookie-secret.js", import.meta.url)
  );
  for (const [module, key] of [
    [retail, "RETAIL_COOKIE_SECRET"],
    [anonymous, "VISITOR_COOKIE_SECRET"],
  ]) {
    assert.throws(() => module.requiredCookieSecret({}), /is required/);
    assert.throws(() => module.requiredCookieSecret({ [key]: "too-short" }), /at least 32 bytes/);
    assert.equal(module.requiredCookieSecret({ [key]: "x".repeat(32) }), "x".repeat(32));
    assert.match(module.requiredCookieSecret({ LOCAL_DEMO: "true" }), /local-demo/);
  }
});

test("the MCP SDK owns best-effort inline elicitation and otherwise shares nothing", async () => {
  const source = await read("sdk/node/src/customer-mcp.ts");
  assert.match(source, /"record_customer_context_consent"/);
  assert.match(source, /"share_customer_context"/);
  assert.match(source, /permissionMode: "best_effort_mcp_elicitation"/);
  assert.match(source, /resultType: "input_required"/);
  assert.match(source, /inputResponses\?\.customer_context_permission/);
  assert.match(source, /"this_session_only"/);
  assert.match(source, /"canceled", "cancelled", "incomplete"/);
  assert.match(source, /result\.isError === true/);
  assert.match(source, /surface: "mcp"/);
  assert.match(source, /reason: "form_elicitation_unavailable"/);
  assert.doesNotMatch(source, /fallbackTool/);
  assert.doesNotMatch(source, /Ask the exact question once, then use/);
});
