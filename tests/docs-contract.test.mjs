import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const docsConfig = JSON.parse(await read("docs/docs.json"));
const dashboard = await read("backend/public/app.js");
const mintIgnore = await read("docs/.mintignore");

const httpIntegrations = [
  {
    id: "node-express",
    page: "docs/integrations/node-express.mdx",
    required: ["@epode/node/express", "agentFeedback({", "include:", "agent-feedback-doctor"],
  },
  {
    id: "node-fastify",
    page: "docs/integrations/node-fastify.mdx",
    required: [
      "@epode/node/fastify",
      "app.register(agentFeedback({",
      "include:",
      "agent-feedback-doctor",
    ],
  },
  {
    id: "python-asgi",
    page: "docs/integrations/python-asgi.mdx",
    required: ["agent_feedback", "AgentFeedbackASGI", "api_key=", "include="],
  },
  {
    id: "python-wsgi",
    page: "docs/integrations/python-wsgi.mdx",
    required: ["agent_feedback", "AgentFeedbackWSGI", "app.wsgi_app", "Agent-Feedback"],
  },
  {
    id: "go",
    page: "docs/integrations/go-http.mdx",
    required: [
      "github.com/open-software-network/os-epode/sdk/go",
      "agentfeedback.New",
      "feedback.Middleware",
      "feedback.Shutdown",
    ],
  },
  {
    id: "rust",
    page: "docs/integrations/rust-axum.mdx",
    required: ["agent-feedback-rust-0.4.0.tar.gz", "AgentFeedbackLayer::new", ".include", "Tokio"],
  },
  {
    id: "manual-http",
    page: "docs/integrations/manual-http.mdx",
    required: [
      "agent-feedback-protocol-v1-0.4.0.zip",
      "HMAC-SHA256",
      "_agentFeedback",
      "Cache-Control",
      "/api/v2/consent/state",
      "requiredAction.submitDecision",
      "consent-decision.schema.json",
    ],
  },
];

const mcpIntegrations = [
  {
    id: "node-mcp",
    page: "docs/integrations/node-mcp.mdx",
    required: [
      "createMcpInstrumentation",
      "createMcpHandler",
      "feedback.instrument(server)",
      "record_product_feedback_consent",
      "report_product_feedback",
      "consent_required",
      "feedback_ready",
      "2026-07-28",
    ],
  },
  {
    id: "manual-mcp",
    page: "docs/integrations/manual-mcp.mdx",
    required: [
      "server/discover",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
      "record_product_feedback_consent",
      "report_product_feedback",
      "consent_required",
      "feedback_ready",
    ],
  },
];

function navigationPages(value, pages = []) {
  if (Array.isArray(value)) {
    for (const child of value) navigationPages(child, pages);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "pages" && Array.isArray(child)) {
        for (const page of child) {
          if (typeof page === "string") pages.push(page);
          else navigationPages(page, pages);
        }
      } else {
        navigationPages(child, pages);
      }
    }
  }
  return pages;
}

test("Mintlify navigation exposes the complete new-customer journey", async () => {
  const pages = new Set(navigationPages(docsConfig.navigation));
  for (const integration of [...httpIntegrations, ...mcpIntegrations]) {
    assert.ok(
      pages.has(integration.page.replace(/^docs\//, "").replace(/\.mdx$/, "")),
      `${integration.id} is missing from navigation`,
    );
  }
  for (const required of [
    "index",
    "quickstart",
    "concepts/customer-enrichment",
    "concepts/reliability",
    "concepts/feedback-modes",
    "guides/verify",
    "guides/real-world-patterns",
    "guides/troubleshooting",
    "reference/privacy-security",
    "reference/customer-context",
  ]) {
    assert.ok(pages.has(required), `${required} is missing from navigation`);
  }
  assert.ok(
    ![...pages].some((page) => page === "api" || page.startsWith("api/")),
    "Mintlify reserves the /api path",
  );
});

test("real-world guidance covers the initial ICP outcome boundaries", async () => {
  const content = await read("docs/guides/real-world-patterns.mdx");
  for (const pattern of [
    "Search or retrieval API",
    "Async crawl or export",
    "Browser automation MCP",
    "Documentation MCP",
    "Email, payments, or issue MCP",
  ]) {
    assert.ok(content.includes(pattern), `real-world guidance omits ${pattern}`);
  }
  assert.match(content, /Agent-Feedback-Request: 1/);
  assert.match(content, /feedbackTools/);
  assert.match(content, /verified API or OAuth context/);
  assert.match(content, /Static site or hosted docs/);
  assert.match(content, /static docs trusted-edge proxy/);
});

test("static-site guidance requires a trusted edge and ships an executable proxy", async () => {
  const content = await read("docs/integrations/static-edge.mdx");
  for (const expected of [
    "createStaticDocsProxy",
    "@epode/node/edge",
    "DOCS_UPSTREAM_ORIGIN",
    "Agent-Feedback-Request: 1",
    "private, no-store",
    "never in `wrangler.jsonc`",
    "advanced-only",
    "never attach it as a hostname-wide",
    "return 404",
    "return 405 without",
  ]) {
    assert.ok(content.includes(expected), `static edge docs omit ${expected}`);
  }
  const example = await read("examples/static-docs-edge/worker.js");
  assert.match(example, /createStaticDocsProxy/);
  assert.match(example, /env\.AGENT_FEEDBACK_KEY/);
  assert.match(example, /dedicated public docs routes/);
  assert.match(example, /second fail-closed boundary/);
  assert.doesNotMatch(example, /af_live_/);
  assert.ok(navigationPages(docsConfig.navigation).includes("integrations/static-edge"));
  assert.match(dashboard, /"static-edge"/);
});

test("Mintlify excludes internal engineering notes from publishing", () => {
  assert.match(mintIgnore, /^agents\/$/m);
  assert.match(mintIgnore, /^mcp-client-config\.md$/m);
  const pages = navigationPages(docsConfig.navigation);
  assert.ok(!pages.some((page) => page.startsWith("agents/") || page === "mcp-client-config"));
});

test("all fourteen HTTP and website setup permutations have copyable, current instructions", async () => {
  for (const integration of httpIntegrations) {
    const content = await read(integration.page);
    for (const expected of integration.required)
      assert.ok(content.includes(expected), `${integration.id} docs omit ${expected}`);
    assert.match(
      content,
      /AGENT_FEEDBACK_KEY|api_key=/,
      `${integration.id} docs omit product-key setup`,
    );
    assert.match(
      content,
      /server-rendered|HTML|html/i,
      `${integration.id} docs omit website behavior`,
    );
    assert.match(
      content,
      /runnable .*example/i,
      `${integration.id} docs do not link a runnable example`,
    );
    assert.match(
      content,
      /Epode Companion.*\/integrations\/companion|\[Epode Companion\]\(\/integrations\/companion\)/i,
      `${integration.id} docs omit the shared HTTP customer-agent path`,
    );
    assert.ok(
      dashboard.includes(`"${integration.id}"`),
      `${integration.id} is not selectable in product Setup`,
    );
  }
  assert.equal(httpIntegrations.length * 2, 14);
});

test("both MCP setup permutations document the stateless 2026 feedback-tool contract", async () => {
  for (const integration of mcpIntegrations) {
    const content = await read(integration.page);
    for (const expected of integration.required)
      assert.ok(content.includes(expected), `${integration.id} docs omit ${expected}`);
    assert.match(content, /stateless/i);
    assert.match(content, /Never ask is the most reliable mode/i);
    assert.match(content, /verify the exact client versions/i);
    assert.match(content, /runnable .*example/i);
    assert.ok(
      dashboard.includes(`"${integration.id}"`),
      `${integration.id} is not selectable in product Setup`,
    );
  }
  assert.equal(mcpIntegrations.length, 2);
});

test("Node MCP setup authenticates before dispatch and keeps hosted installs reproducible", async () => {
  const content = await read("docs/integrations/node-mcp.mdx");
  for (const expected of [
    "requireBearerAuth",
    "productTokenVerifier",
    "requiredScopes",
    "verifiedField",
    'accountRef: (_args, context) => verifiedField(context, "accountId")',
    'userRef: (_args, context) => verifiedField(context, "userId")',
    'anonymousRef: (_args, context) => verifiedField(context, "visitorId")',
    'customerRef: (_args, context) => verifiedField(context, "accountId")',
    'sessionRef: (_args, context) => verifiedField(context, "journeyId")',
    "standalone JSON text block",
    "outputSchema",
    ".epode/artifacts/agent-feedback-node-0.4.0.tgz",
    "shasum -a 256 -c -",
  ]) {
    assert.ok(content.includes(expected), `Node MCP docs omit ${expected}`);
  }
  assert.ok(
    content.indexOf('app.use("/mcp", requireBearerAuth') < content.indexOf('app.all("/mcp"'),
    "Node MCP docs must authenticate before forwarding /mcp",
  );
  assert.doesNotMatch(content, /sessionRef:[\s\S]{0,160}\bargs\.[A-Za-z_$]/);
  assert.match(content, /npm ci.*cache is cleared/i);

  assert.match(
    dashboard,
    /npm install @modelcontextprotocol\/server @modelcontextprotocol\/node @modelcontextprotocol\/express zod/,
  );
  assert.ok(
    dashboard.indexOf('app.use("/mcp", requireBearerAuth') < dashboard.indexOf('app.all("/mcp"'),
    "legacy setup must authenticate before forwarding /mcp",
  );
  assert.match(dashboard, /record_product_feedback_consent/);
  assert.match(dashboard, /report_product_feedback/);
  assert.match(dashboard, /standalone JSON content block/);
  assert.match(dashboard, /feedbackMode: env\.AGENT_FEEDBACK_MODE/);
  assert.match(dashboard, /epode_artifact="\.epode\/artifacts\/agent-feedback-node-[0-9.]+\.tgz"/);
  assert.doesNotMatch(
    dashboard,
    /nodeDownload = verifiedDownload\("agent-feedback-node-[0-9.]+\.tgz"/,
  );
});

test("Fastify guidance authenticates before reading identity and uses product-proven journeys", async () => {
  const content = await read("docs/integrations/node-fastify.mdx");
  assert.ok(
    content.indexOf('app.addHook("preHandler", authenticateProductRequest)') <
      content.indexOf("await app.register(agentFeedback"),
  );
  assert.match(content, /authorize the selected tenant/i);
  assert.match(content, /sessionRef: request => request\.authorizedCrawl\?\.id/);
  assert.doesNotMatch(content, /sessionRef: request => request\.(?:headers|params|query|body)/);
  assert.match(content, /never accept an arbitrary grouping handle/i);
});

test("customer-intelligence setup uses only verified or product-owned correlation context", async () => {
  const pages = await Promise.all(
    [
      "docs/quickstart.mdx",
      "docs/integrations/node-express.mdx",
      "docs/integrations/node-fastify.mdx",
      "docs/integrations/node-mcp.mdx",
      "docs/integrations/python-asgi.mdx",
      "docs/integrations/python-wsgi.mdx",
      "docs/integrations/go-http.mdx",
      "docs/integrations/rust-axum.mdx",
      "docs/integrations/manual-http.mdx",
      "docs/integrations/manual-mcp.mdx",
      "docs/integrations/static-edge.mdx",
    ].map(read),
  );
  const joined = pages.join("\n");
  for (const field of ["accountRef", "userRef", "anonymousRef", "customerRef", "sessionRef"]) {
    assert.match(joined, new RegExp(field));
  }
  assert.match(joined, /customerRef[\s\S]{0,180}(?:exact|identical)[\s\S]{0,80}accountRef/i);
  assert.match(joined, /server\/product state[\s\S]{0,100}proves? (?:a |the )?journey/i);
  assert.match(
    joined,
    /never (?:use|derive)[\s\S]{0,140}(?:names|name)[\s\S]{0,80}(?:emails|email)/i,
  );
  assert.doesNotMatch(
    joined,
    /sessionRef:[\s\S]{0,100}(?:get\("x-|\.headers|\.query|\.body|\bargs\.)/,
  );
});

test("legacy feedback verification and reference docs preserve the two-stage consent workflow", async () => {
  const pages = await Promise.all([
    read("docs/guides/verify.mdx"),
    read("docs/reference/mcp-2026-07-28.mdx"),
  ]);
  for (const content of pages) {
    assert.match(content, /record_product_feedback_consent/);
    assert.match(content, /report_product_feedback/);
    assert.match(content, /consent_required/);
    assert.match(content, /feedback_ready/);
  }
  const reference = pages.at(-1);
  assert.match(reference, /only the action allowed at that stage/i);
  assert.match(reference, /Never call `report_product_feedback` from a `consent_required` result/);
});

test("docs explain the product/customer-agent boundary and evidence model", async () => {
  const overview = await read("docs/index.mdx");
  const reliability = await read("docs/concepts/reliability.mdx");
  const privacy = await read("docs/reference/privacy-security.mdx");
  assert.match(overview, /AI agent acting for them/i);
  assert.match(overview, /Customers do not create an Epode account, install\s+a plugin/i);
  assert.match(
    reliability,
    /does not label ordinary HTTP traffic as agent traffic without evidence/i,
  );
  assert.match(reliability, /MCP.*confirmed/i);
  assert.match(reliability, /Never use `\/llms\.txt` as the only feedback handoff/i);
  assert.match(reliability, /native report tool/i);
  assert.match(privacy, /does not identify an agent/i);
  assert.match(privacy, /prompts or transcripts/i);
});

test("every shipped agent handoff keeps routine feedback success out of the user answer", async () => {
  const handoffs = await Promise.all([
    read("protocol/v1/README.md"),
    read("backend/src/main.rs"),
    read("sdk/node/src/core.ts"),
    read("sdk/node/src/mcp.ts"),
    read("sdk/python/src/agent_feedback/core.py"),
    read("sdk/rust/src/lib.rs"),
    read("sdk/go/agentfeedback.go"),
    read("examples/setup-matrix-manual-http/server.py"),
    read("examples/setup-matrix-manual-mcp/server.py"),
    read("companion/plugins/epode-companion/scripts/mcp-server.mjs"),
    read("companion/plugins/epode-companion/skills/epode-product-feedback/SKILL.md"),
  ]);
  for (const content of handoffs) {
    assert.match(content, /routine/i);
    assert.match(content, /do not mention|keep .* out of the final (?:answer|response)/i);
    assert.match(content, /unless the user explicitly ask/i);
  }
});

test("docs and dashboard publish the same install artifacts and feedback modes", async () => {
  const pages = await Promise.all([
    read("docs/quickstart.mdx"),
    read("docs/integrations/node-express.mdx"),
    read("docs/integrations/python-asgi.mdx"),
    read("docs/integrations/rust-axum.mdx"),
    read("docs/integrations/manual-http.mdx"),
    read("docs/concepts/feedback-modes.mdx"),
  ]);
  const joined = pages.join("\n");
  for (const artifact of [
    "agent-feedback-node-0.4.0.tgz",
    "agent_feedback-0.4.0-py3-none-any.whl",
    "agent-feedback-rust-0.4.0.tar.gz",
    "agent-feedback-protocol-v1-0.4.0.zip",
  ]) {
    assert.ok(joined.includes(artifact), `docs omit ${artifact}`);
    assert.ok(dashboard.includes(artifact), `dashboard omits ${artifact}`);
  }
  for (const mode of ["never_ask", "ask_once", "ask_always", "off"]) {
    assert.ok(joined.includes(mode), `docs omit ${mode}`);
    assert.ok(dashboard.includes(mode), `dashboard omits ${mode}`);
  }
});

test("verified install snippets pin the current manifest checksums", async () => {
  const manifest = JSON.parse(await read("backend/public/agent-feedback-integrations-0.4.0.json"));
  const pages = {
    node: await read("docs/integrations/node-mcp.mdx"),
    go: await read("docs/integrations/go-http.mdx"),
    rust: await read("docs/integrations/rust-axum.mdx"),
  };
  for (const [kind, content] of Object.entries(pages)) {
    const artifact = manifest.artifacts[kind];
    assert.ok(content.includes(artifact.filename), `${kind} docs omit the current filename`);
    assert.ok(content.includes(artifact.sha256), `${kind} docs omit the current SHA-256`);
    assert.ok(dashboard.includes(artifact.filename), `dashboard omits ${kind} filename`);
    assert.ok(dashboard.includes(artifact.sha256), `dashboard omits ${kind} SHA-256`);
  }
});

test("dashboard setup stops before install or extraction when artifact verification fails", () => {
  assert.match(
    dashboard,
    /const verifiedDownload = .*curl -fsSL .* &&\\nprintf .*shasum -a 256 -c -`;/,
  );
  assert.match(
    dashboard,
    /const nodeDownload = .*curl -fsSL .* &&\\nprintf .*shasum -a 256 -c -`;/,
  );
  for (const failClosedInstall of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this asserts a literal template interpolation in generated setup source.
    'const nodeInstall = `${nodeDownload} &&\\nnpm install "$epode_artifact"`',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this asserts a literal template interpolation in generated setup source.
    'install: `${pythonDownload} &&\\npip install "$epode_artifact"`',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this asserts a literal template interpolation in generated setup source.
    "install: `${goDownload} &&\\nmkdir -p ",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this asserts a literal template interpolation in generated setup source.
    "install: `${rustDownload} &&\\nmkdir -p ",
  ]) {
    assert.ok(
      dashboard.includes(failClosedInstall),
      `dashboard setup lost checksum-gated install contract: ${failClosedInstall}`,
    );
  }
});

test("company onboarding docs preserve key safety and the enrichment loop", async () => {
  const [quickstart, verification, privacy, configuration] = await Promise.all([
    read("docs/quickstart.mdx"),
    read("docs/guides/verify.mdx"),
    read("docs/reference/privacy-security.mdx"),
    read("docs/reference/configuration.mdx"),
  ]);

  for (const milestone of ["Ask", "Learn", "Personalize", "Measure"]) {
    assert.match(`${await read("docs/index.mdx")}\n${quickstart}`, new RegExp(milestone, "i"));
  }
  assert.match(verification, /First opportunity/);
  assert.match(privacy, /does not persist the full secret in\s+browser storage/i);
  assert.match(privacy, /deployment secret manager/i);
  assert.match(configuration, /`sessionRef` \/ `session_ref`/);
  assert.match(configuration, /omit it rather than infer continuity/i);
});

test("primary onboarding is company-only customer enrichment", async () => {
  const [index, quickstart, customerContext, configuration] = await Promise.all([
    read("docs/index.mdx"),
    read("docs/quickstart.mdx"),
    read("docs/reference/customer-context.mdx"),
    read("docs/reference/configuration.mdx"),
  ]);
  const primary = `${index}\n${quickstart}`;
  assert.match(primary, /Customers/);
  assert.match(primary, /Insights/);
  assert.match(primary, /Setup/);
  assert.match(primary, /Data controls/);
  assert.match(primary, /@epode\/node/);
  assert.match(primary, /EPODE_API_KEY/);
  assert.match(primary, /\/_epode\/v1\/enrichment\/consent/);
  assert.match(primary, /contextFor/);
  assert.match(primary, /personalization\.decide/);
  assert.match(primary, /outcomes\.track/);
  assert.doesNotMatch(primary, /Epode Companion|customer.*install.*plugin/i);
  assert.match(customerContext, /targeted_advertising/);
  assert.match(customerContext, /agent_reports_user_statement/);
  assert.match(configuration, /company-owned enrichment relay/i);
});

test("public privacy docs explain operable retention and durable Ask-once permission", async () => {
  const [privacy, customers] = await Promise.all([
    read("docs/reference/privacy-security.mdx"),
    read("docs/concepts/customers-and-sessions.mdx"),
  ]);
  for (const content of [privacy, customers]) {
    assert.match(content, /1 to 365 days/);
    assert.match(content, /dashboard (?:filtering|queries).*immediately/is);
    assert.match(content, /feedback(?: reports)?,\s*interactions, and sessions/is);
    assert.match(content, /scheduled purge|one purge interval/i);
    assert.match(content, /Ask-once permission/i);
    assert.match(content, /explicitly\s+changed or the product is deleted/i);
  }
});

test("the HTTP reference publishes the complete report shape", async () => {
  const content = await read("docs/reference/http-envelope.mdx");
  for (const field of ["impacts", "findingKinds", "findingSeverities", "maxFindings"]) {
    assert.ok(content.includes(`"${field}"`), `HTTP envelope reference omits ${field}`);
  }
  assert.match(content, /"state": "feedback_ready"/);
  assert.match(content, /"state": "consent_required"/);
  assert.doesNotMatch(content, /"optional": \[[^\]]*"consent"/);
});

test("repository overview matches the current team and frontend implementation", async () => {
  const repositoryReadme = await read("README.md");
  assert.match(repositoryReadme, /share link that lasts 24 hours/i);
  assert.match(repositoryReadme, /`web\/` — Next\.js dashboard frontend/);
  assert.doesNotMatch(repositoryReadme, /`app\/` — public product site/);
});

test("every public docs page has a title and actionable description", async () => {
  for (const page of navigationPages(docsConfig.navigation)) {
    const content = await read(`docs/${page}.mdx`);
    assert.match(
      content,
      /^---\n[\s\S]*?title:\s*".+"[\s\S]*?description:\s*".+"[\s\S]*?\n---\n/,
      `${page} has incomplete frontmatter`,
    );
  }
});

test("the downloadable protocol bundle preserves the immutable v1 schema contract", async () => {
  const bundle = new URL("../backend/public/agent-feedback-protocol-v1-0.4.0.zip", import.meta.url)
    .pathname;
  const schemaFiles = [
    "consent-decision.schema.json",
    "conformance.json",
    "envelope.schema.json",
    "feedback-report.schema.json",
    "telemetry-batch.schema.json",
  ];
  const listing = execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(
    listing,
    ["protocol/v1/README.md", ...schemaFiles.map((file) => `protocol/v1/${file}`)].sort(),
  );
  for (const file of schemaFiles) {
    assert.equal(
      execFileSync("unzip", ["-p", bundle, `protocol/v1/${file}`], { encoding: "utf8" }),
      await read(`protocol/v1/${file}`),
      `${file} in the downloadable protocol bundle is stale`,
    );
  }
  const bundledReadme = execFileSync("unzip", ["-p", bundle, "protocol/v1/README.md"], {
    encoding: "utf8",
  });
  assert.equal(bundledReadme, await read("protocol/v1/README.md"));
  assert.match(bundledReadme, /"state": "feedback_ready"/);
  assert.match(bundledReadme, /silent background bookkeeping/);
  assert.match(bundledReadme, /Agent-Feedback-Request: 1/);
  assert.doesNotMatch(bundledReadme, /"optional": \[[^\]]*"consent"/);
});

test("the telemetry schema accepts only bounded opaque correlation evidence", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(await read("protocol/v1/telemetry-batch.schema.json")));
  const event = {
    interactionId: "018f1f2e-7b4a-7c12-9c8d-123456789abc",
    surface: "mcp",
    operation: "summarize",
    classification: "confirmed",
    confirmationMethod: "mcp",
    occurredAt: "2026-07-31T00:00:00.000Z",
  };
  const batch = (overrides = {}) => ({ events: [{ ...event, ...overrides }] });

  assert.equal(validate(batch()), true, JSON.stringify(validate.errors));
  assert.equal(
    validate(
      batch({
        sequence: Number.MAX_SAFE_INTEGER,
        customerRef: "account_42",
        sessionRef: "workflow:canonical_42",
        sessionSource: "mcp",
      }),
    ),
    true,
    JSON.stringify(validate.errors),
  );

  for (const sessionRef of [
    "customer@example.com",
    "workflow with spaces",
    "workflow/with/path",
    "x".repeat(161),
  ]) {
    assert.equal(validate(batch({ sessionRef, sessionSource: "mcp" })), false, sessionRef);
  }
  assert.equal(validate(batch({ sequence: 0 })), false);
  assert.equal(validate(batch({ sequence: Number.MAX_SAFE_INTEGER + 1 })), false);
  assert.equal(validate(batch({ sessionRef: "workflow_42", sessionSource: "transport" })), false);
  assert.equal(validate(batch({ unexpectedCorrelationHint: "workflow_42" })), false);
});
