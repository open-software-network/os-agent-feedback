export const SETUP_SURFACES = {
  mcp: {
    name: "MCP server",
    description: "Register the feedback tool and record confirmed product tool calls.",
    stacks: ["node-mcp", "manual-mcp"],
  },
  api: {
    name: "HTTP API",
    description: "Add feedback instructions to selected successful API responses.",
    stacks: [
      "node-express",
      "node-fastify",
      "python-asgi",
      "python-wsgi",
      "go",
      "rust",
      "manual-http",
    ],
  },
  website: {
    name: "Server-rendered website",
    description: "Inject feedback instructions into eligible HTML on the server.",
    stacks: [
      "node-express",
      "node-fastify",
      "python-asgi",
      "python-wsgi",
      "go",
      "rust",
      "manual-http",
    ],
  },
  static: {
    name: "Static site / hosted docs",
    description:
      "Bind a dedicated docs route to a trusted edge proxy without exposing the product key.",
    stacks: ["static-edge"],
  },
} as const;

export type SetupSurface = keyof typeof SETUP_SURFACES;
export type SetupStack =
  | "node-mcp"
  | "manual-mcp"
  | "node-express"
  | "node-fastify"
  | "python-asgi"
  | "python-wsgi"
  | "go"
  | "rust"
  | "static-edge"
  | "manual-http";

const STACK_NAMES: Record<SetupStack, string> = {
  "node-mcp": "Node MCP",
  "manual-mcp": "Another MCP stack",
  "node-express": "Node · Express",
  "node-fastify": "Node · Fastify",
  "python-asgi": "Python · ASGI",
  "python-wsgi": "Python · WSGI",
  go: "Go · net/http",
  rust: "Rust · Axum/Tower",
  "static-edge": "Trusted edge proxy",
  "manual-http": "Another HTTP stack",
};

export function stackName(stack: SetupStack): string {
  return STACK_NAMES[stack];
}

export function setupInstructions(
  stack: SetupStack,
  surface: SetupSurface,
  origin: string,
): { install: string; code: string; verify: string } {
  const artifacts = `${origin}/static`;
  const route = surface === "static" ? "/docs/**" : surface === "website" ? "/docs/*" : "/search";
  const verifiedDownload = (filename: string, sha256: string) =>
    `epode_artifact="$(mktemp -d)/${filename}" &&\ncurl -fsSL ${artifacts}/${filename} -o "$epode_artifact" &&\nprintf '%s  %s\\n' '${sha256}' "$epode_artifact" | shasum -a 256 -c -`;
  const nodeDownload = `mkdir -p .epode/artifacts &&\nepode_artifact=".epode/artifacts/agent-feedback-node-0.2.2.tgz" &&\ncurl -fsSL ${artifacts}/agent-feedback-node-0.2.2.tgz -o "$epode_artifact" &&\nprintf '%s  %s\\n' 'a108603544c2d17af6859c45d994593a246401ca2f0def1fbeb43f74f5c16fe8' "$epode_artifact" | shasum -a 256 -c -`;
  const pythonDownload = verifiedDownload(
    "agent_feedback-0.2.2-py3-none-any.whl",
    "5723fd4e86c140218708f9e23187e932cfa1d39f85b29e9d76cbc8dbb6fb0ea7",
  );
  const goDownload = verifiedDownload(
    "agent-feedback-go-0.2.2.tar.gz",
    "7f28ce6fb875167aac3afab974ca7cfc5896043e69ed136c375a99b9cde6cc15",
  );
  const rustDownload = verifiedDownload(
    "agent-feedback-rust-0.2.2.tar.gz",
    "f5bc42f38cea06b41449f0ae7b753b602d8e3a5dcf4a98fb3d8c21cd25fcfc62",
  );
  const protocolDownload = verifiedDownload(
    "agent-feedback-protocol-v1-0.2.2.zip",
    "ba3b239e2bf5de1514ca866c5a50a369d9a396ea440c1f65525b529be9025845",
  );
  const nodeInstall = `${nodeDownload} &&\nnpm install "$epode_artifact"`;
  const byStack: Record<SetupStack, { install: string; code: string; verify: string }> = {
    "node-mcp": {
      install: `${nodeInstall} &&\nnpm install @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express zod`,
      code: `import { createMcpInstrumentation, type McpInstrumentationContext } from "@agent-feedback/node/mcp";\nimport { createMcpExpressApp, requireBearerAuth } from "@modelcontextprotocol/express";\nimport { toNodeHandler } from "@modelcontextprotocol/node";\nimport { createMcpHandler, McpServer } from "@modelcontextprotocol/server";\nimport { productTokenVerifier } from "./product-auth.js";\n\nconst app = createMcpExpressApp({ host: "0.0.0.0", allowedOrigins: [] });\n// Verify the token and authorize its tenant before the MCP handler runs.\napp.use("/mcp", requireBearerAuth({\n  verifier: productTokenVerifier, // existing signature/introspection verifier\n  requiredScopes: ["mcp"],\n}));\n\nfunction stringField(value: unknown, key: string): string | undefined {\n  if (typeof value !== "object" || value === null) return undefined;\n  const field = Reflect.get(value, key);\n  return typeof field === "string" && field.length > 0 ? field : undefined;\n}\nfunction authenticatedAccountId(context: McpInstrumentationContext) {\n  const accountId = context.http?.authInfo?.extra?.accountId;\n  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;\n}\n\nconst feedback = createMcpInstrumentation({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  includeTools: ["search", "fetch_result"],\n  feedbackTools: ["fetch_result"],\n  customerRef: (_args, context) => authenticatedAccountId(context),\n  sessionRef: (args, _context, result) =>\n    stringField(args, "agentSessionId") ??\n    stringField(result?.structuredContent, "agentSessionId"), // optional proven journey\n});\n\nfunction productServer() {\n  const server = new McpServer(\n    { name: "your-product", version: "1.0.0" },\n    {\n      instructions: "After each selected product tool call, find _agentFeedback in structuredContent or in a standalone JSON content block. Finish the product task first. For consent_required, show the product answer, ask the exact returned question once, and wait for the user's next turn; call record_product_feedback_consent only for an explicit standalone Yes or No. For feedback_ready, call report_product_feedback exactly once. For feedback_disabled, do nothing unless the user explicitly asks to change permission. Keep successful background reporting out of the final answer.",\n    },\n  );\n  feedback.instrument(server);\n  return server;\n}\n\nconst handleMcp = toNodeHandler(createMcpHandler(productServer, {\n  legacy: "stateless",\n  responseMode: "json",\n}));\napp.all("/mcp", (req, res) => handleMcp(req, res, req.body));`,
      verify:
        "Call server/discover, then call one normal product tool from an MCP 2026-07-28 client.",
    },
    "manual-mcp": {
      install: protocolDownload,
      code: "1. Implement stateless MCP 2026-07-28 and server/discover.\n2. Validate MCP-Protocol-Version, Mcp-Method, and Mcp-Name.\n3. Emit confirmed telemetry. Put _agentFeedback in structuredContent for schema-less tools, or a standalone JSON TextContent block when the business tool declares outputSchema.\n4. Register record_product_feedback_consent and report_product_feedback with strict schemas.",
      verify:
        "Verify discovery, stateless headers, one product tool call, and one feedback report.",
    },
    "node-express": {
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/express";\n\n// Mount verified product authentication before Agent Feedback.\napp.use(productAuthentication);\napp.use(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"], // replace with customer-agent product routes\n  customerRef: req => req.user?.accountId,\n  sessionRef: req => req.agentSession?.id, // optional proven journey\n}));`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "node-fastify": {
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/fastify";\n\n// Verify the caller and authorize its tenant before Epode reads req.user.\napp.addHook("preHandler", productAuthentication);\nawait app.register(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"], // replace with customer-agent product routes\n  customerRef: req => req.user?.accountId,\n  sessionRef: req => req.agentSession?.id, // optional proven journey\n}));`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-asgi": {
      install: `${pythonDownload} &&\npython -m pip install "$epode_artifact"`,
      code: `import os\nfrom agent_feedback import AgentFeedbackASGI\n\napp = AgentFeedbackASGI(\n    app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),  # replace with customer-agent product routes\n    customer_ref=lambda scope: scope.get("state", {}).get("account_id"),\n    session_ref=lambda scope: scope.get("state", {}).get("agent_session_id"),  # optional\n)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-wsgi": {
      install: `${pythonDownload} &&\npython -m pip install "$epode_artifact"`,
      code: `import os\nfrom agent_feedback import AgentFeedbackWSGI\n\napp.wsgi_app = AgentFeedbackWSGI(\n    app.wsgi_app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),  # replace with customer-agent product routes\n    customer_ref=lambda env: env.get("product.account_id"),\n    session_ref=lambda env: env.get("product.agent_session_id"),  # optional\n)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    go: {
      install: `${goDownload} &&
mkdir -p .epode/agent-feedback-go-0.2.2 &&
tar -xzf "$epode_artifact" -C .epode/agent-feedback-go-0.2.2 &&
go mod edit -replace=github.com/open-software-network/os-epode/sdk/go=./.epode/agent-feedback-go-0.2.2 &&
go mod edit -require=github.com/open-software-network/os-epode/sdk/go@v0.2.2`,
      code: `feedback, err := agentfeedback.New(agentfeedback.Options{\n    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),\n    Include: []string{"${route}"}, // replace with customer-agent product routes\n    CustomerRef: func(r *http.Request) string { return authenticatedAccountID(r.Context()) },\n    SessionRef: func(r *http.Request) string { return agentSessionID(r.Context()) }, // optional\n})\nif err != nil { log.Fatal(err) }\ndefer feedback.Shutdown(context.Background())\n// Authentication must establish the verified request context before Epode runs.\nhandler := productAuthentication(feedback.Middleware(router))`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    rust: {
      install: `${rustDownload} &&\nmkdir -p vendor/agent-feedback-rust-0.2.2 &&\ntar -xzf "$epode_artifact" -C vendor/agent-feedback-rust-0.2.2`,
      code: `// Cargo.toml: agent-feedback = { path = "vendor/agent-feedback-rust-0.2.2" }\nlet feedback = AgentFeedbackLayer::new(\n    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)\n        .include(["${route}"]) // replace with customer-agent product routes\n        .customer_ref(|request| authenticated_account_id(request))\n        .session_ref(|request| agent_session_id(request)), // optional\n)?;\n// The outer authentication layer must populate request extensions before Epode runs.\nlet app = router.layer(feedback.clone()).layer(product_auth_layer());`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "static-edge": {
      install: nodeInstall,
      code: `import { createStaticDocsProxy } from "@agent-feedback/node/edge";

let proxy;
export default {
  fetch(request, env, context) {
    // Bind this Worker only to dedicated public docs routes at the edge.
    proxy ??= createStaticDocsProxy({
      apiKey: env.AGENT_FEEDBACK_KEY,
      feedbackMode: env.AGENT_FEEDBACK_MODE,
      upstreamOrigin: "https://your-docs-origin.example",
      include: ["/docs", "/docs/**"],
    });
    return proxy.fetch(request, context);
  },
};`,
      verify:
        "Confirm an adjacent path returns 404 and POST returns 405 without reaching upstream; then compare ordinary and opted-in docs responses: their bodies must be identical, and only the opted-in response has Agent-Feedback.",
    },
    "manual-http": {
      install: protocolDownload,
      code: `GET ${origin}/.well-known/agent-feedback-v1.json\n\n1. Keep the product key server-side and sign a short-lived scoped capability.\n2. Derive Ask once state only from a stable opaque authenticated customer ID.\n3. Add the current feedback action to selected eligible 2xx responses.\n4. Queue opportunity telemetry without delaying or failing the product response.\n5. Preserve response bodies, caching, errors, streams, and binary responses.`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")} and inspect the feedback envelope.`,
    },
  };
  return byStack[stack];
}

export const READ_CLIENTS = {
  "claude-code": {
    name: "Claude Code",
    note: `Claude Code expands \${VAR} inside headers. The "type" field is required.`,
    config: (origin: string) =>
      `{\n  "mcpServers": {\n    "agent-feedback": {\n      "type": "http",\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer \${AGENT_FEEDBACK_READ_KEY}" }\n    }\n  }\n}`,
  },
  cursor: {
    name: "Cursor",
    note: "Cursor uses the env: prefix when interpolating environment variables.",
    config: (origin: string) =>
      `{\n  "mcpServers": {\n    "agent-feedback": {\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer \${env:AGENT_FEEDBACK_READ_KEY}" }\n    }\n  }\n}`,
  },
  "vs-code": {
    name: "VS Code",
    note: "VS Code prompts once and stores the secret securely instead of writing it to the file.",
    config: (origin: string) =>
      `{\n  "inputs": [{\n    "type": "promptString",\n    "id": "epode-read-key",\n    "description": "Agent Feedback read key",\n    "password": true\n  }],\n  "servers": {\n    "agent-feedback": {\n      "type": "http",\n      "url": "${origin}/mcp",\n      "headers": { "Authorization": "Bearer \${input:epode-read-key}" }\n    }\n  }\n}`,
  },
} as const;

export type ReadClient = keyof typeof READ_CLIENTS;

export function setupAgentPrompt(
  surface: SetupSurface,
  stack: SetupStack,
  instructions: { install: string; code: string; verify: string },
  origin: string,
): string {
  const routeBoundaryRequirement =
    surface === "static"
      ? "- Bind the Worker only to dedicated public docs routes at the edge, never a hostname-wide catch-all. Treat include as a second fail-closed boundary."
      : surface === "mcp"
        ? "- Set includeTools to only customer-facing product tools whose use should appear in Epode."
        : "- Replace the example include route and limit instrumentation to routes used by customer agents.";
  const identityRequirement =
    surface === "static"
      ? "- Do not invent customerRef for public docs. Add it only if verified edge authentication supplies a stable opaque account ID."
      : "- Run product authentication and authorized tenant selection before Agent Feedback. customerRef is a synchronous accessor over that verified identity, not an authentication hook. Use a stable opaque account or tenant ID, never a name, email, or caller-supplied unverified value. It is required for durable Ask once.";
  const verificationRequirement =
    surface === "mcp"
      ? `- Verify with a real MCP 2026-07-28 client, not an HTTP GET doctor: ${instructions.verify}`
      : surface === "static"
        ? `- Verify the public proxy without product authentication: ${instructions.verify}`
        : `- Run the integration doctor against one real company-authenticated request and prove only the first opportunity in Setup: ${instructions.verify}`;
  return `Add Agent Feedback to this repository.

Product surface: ${SETUP_SURFACES[surface].name}
Integration: ${stackName(stack)}

Requirements:
- Use AGENT_FEEDBACK_KEY from the server environment. Never print or expose it.
- Before installing hosted bytes, read integrityManifest from ${origin}/.well-known/agent-feedback-v1.json and verify the selected artifact's filename and SHA-256. Stop on any mismatch.
- Install the official package with: ${instructions.install}
- Keep project-local hosted artifacts referenced by package manifests in source control or the deployment build context.
- Configure the integration once using this reference:

${instructions.code}

${routeBoundaryRequirement}
${identityRequirement}
- Add sessionRef only when your product already has proof that interactions belong to one journey; never infer continuity.
- Never put the product key in browser JavaScript.
- Preserve response shapes, errors, streams, and binary responses.
${verificationRequirement}
- Never approve or decline feedback permission for a tester, fabricate customer feedback, or create a synthetic report. Ask modes require the real tester's explicit decision.
- Finish by printing a copyable customer-agent activation task for a real tester. That separate task should use the product normally, follow the returned feedback action, and let Epode prove the first confirmed interaction and first report.

Protocol: ${origin}/.well-known/agent-feedback-v1.json`;
}
