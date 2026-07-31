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
    required: [
      "@agent-feedback/node/express",
      "agentFeedback({",
      "include:",
      "agent-feedback-doctor",
    ],
  },
  {
    id: "node-fastify",
    page: "docs/integrations/node-fastify.mdx",
    required: [
      "@agent-feedback/node/fastify",
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
    required: ["agent-feedback-rust-0.1.0.tar.gz", "AgentFeedbackLayer::new", ".include", "Tokio"],
  },
  {
    id: "manual-http",
    page: "docs/integrations/manual-http.mdx",
    required: ["agent-feedback-protocol-v1.zip", "HMAC-SHA256", "_agentFeedback", "Cache-Control"],
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
      "report_product_feedback",
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
      "report_product_feedback",
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
    "concepts/reliability",
    "concepts/feedback-modes",
    "guides/verify",
    "guides/real-world-patterns",
    "guides/troubleshooting",
    "reference/privacy-security",
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
    assert.match(content, /runnable .*example/i);
    assert.ok(
      dashboard.includes(`"${integration.id}"`),
      `${integration.id} is not selectable in product Setup`,
    );
  }
  assert.equal(mcpIntegrations.length, 2);
});

test("docs explain the product/customer-agent boundary and evidence model", async () => {
  const overview = await read("docs/index.mdx");
  const reliability = await read("docs/concepts/reliability.mdx");
  const privacy = await read("docs/reference/privacy-security.mdx");
  assert.match(overview, /independent agents used by your customers/i);
  assert.match(overview, /customers do not install an Epode SDK/i);
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

test("docs and dashboard publish the same install artifacts and feedback modes", async () => {
  const pages = await Promise.all([
    read("docs/quickstart.mdx"),
    read("docs/integrations/python-asgi.mdx"),
    read("docs/integrations/rust-axum.mdx"),
    read("docs/integrations/manual-http.mdx"),
    read("docs/concepts/feedback-modes.mdx"),
  ]);
  const joined = pages.join("\n");
  for (const artifact of [
    "agent-feedback-node-0.1.0.tgz",
    "agent_feedback-0.1.0-py3-none-any.whl",
    "agent-feedback-rust-0.1.0.tar.gz",
    "agent-feedback-protocol-v1.zip",
  ]) {
    assert.ok(joined.includes(artifact), `docs omit ${artifact}`);
    assert.ok(dashboard.includes(artifact), `dashboard omits ${artifact}`);
  }
  for (const mode of ["never_ask", "ask_once", "ask_always", "off"]) {
    assert.ok(joined.includes(mode), `docs omit ${mode}`);
    assert.ok(dashboard.includes(mode), `dashboard omits ${mode}`);
  }
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

test("the downloadable protocol bundle contains only the current report contract", async () => {
  const bundle = new URL("../backend/public/agent-feedback-protocol-v1.zip", import.meta.url)
    .pathname;
  const listing = execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" });
  assert.doesNotMatch(listing, /outcome\.schema\.json/);
  for (const required of [
    "README.md",
    "conformance.json",
    "envelope.schema.json",
    "feedback-report.schema.json",
    "telemetry-batch.schema.json",
  ]) {
    assert.match(listing, new RegExp(`protocol/v1/${required.replaceAll(".", "\\.")}$`, "m"));
  }
  assert.deepEqual(
    JSON.parse(
      execFileSync("unzip", ["-p", bundle, "protocol/v1/telemetry-batch.schema.json"], {
        encoding: "utf8",
      }),
    ),
    JSON.parse(await read("protocol/v1/telemetry-batch.schema.json")),
  );
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
