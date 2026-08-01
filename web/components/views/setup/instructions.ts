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
  const nodeInstall = `npm install ${artifacts}/agent-feedback-node-0.2.0.tgz`;
  const byStack: Record<SetupStack, { install: string; code: string; verify: string }> = {
    "node-mcp": {
      install: `${nodeInstall}\nnpm install @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express zod`,
      code: `import { createMcpInstrumentation } from "@agent-feedback/node/mcp";\n\nconst feedback = createMcpInstrumentation({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  includeTools: ["search", "fetch_result"],\n  customerRef: (_args, context) => context.http?.authInfo?.extra?.accountId,\n  sessionRef: (_args, _context, result) =>\n    result?.structuredContent?.agentSessionId, // optional product-proven journey\n});\nfeedback.instrument(productMcpServer);`,
      verify:
        "Call server/discover, then call one normal product tool from an MCP 2026-07-28 client.",
    },
    "manual-mcp": {
      install: `curl -fsSLO ${artifacts}/agent-feedback-protocol-v1.zip`,
      code: "1. Implement stateless MCP 2026-07-28 and server/discover.\n2. Validate MCP-Protocol-Version, Mcp-Method, and Mcp-Name.\n3. Emit confirmed telemetry and add _agentFeedback to selected product-tool results.\n4. Register record_product_feedback_consent and report_product_feedback with strict schemas.",
      verify:
        "Verify discovery, stateless headers, one product tool call, and one feedback report.",
    },
    "node-express": {
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/express";\n\napp.use(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"], // replace with customer-agent product routes\n  customerRef: req => req.user?.accountId,\n  sessionRef: req => req.agentSession?.id, // optional proven journey\n}));`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "node-fastify": {
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/fastify";\n\nawait app.register(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"], // replace with customer-agent product routes\n  customerRef: req => req.user?.accountId,\n  sessionRef: req => req.agentSession?.id, // optional proven journey\n}));`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-asgi": {
      install: `python -m pip install ${artifacts}/agent_feedback-0.2.0-py3-none-any.whl`,
      code: `import os\nfrom agent_feedback import AgentFeedbackASGI\n\napp = AgentFeedbackASGI(\n    app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),  # replace with customer-agent product routes\n    customer_ref=lambda scope: scope.get("state", {}).get("account_id"),\n    session_ref=lambda scope: scope.get("state", {}).get("agent_session_id"),  # optional\n)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-wsgi": {
      install: `python -m pip install ${artifacts}/agent_feedback-0.2.0-py3-none-any.whl`,
      code: `import os\nfrom agent_feedback import AgentFeedbackWSGI\n\napp.wsgi_app = AgentFeedbackWSGI(\n    app.wsgi_app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),  # replace with customer-agent product routes\n    customer_ref=lambda env: env.get("product.account_id"),\n    session_ref=lambda env: env.get("product.agent_session_id"),  # optional\n)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    go: {
      install: "go get github.com/open-software-network/os-epode/sdk/go@v0.2.0",
      code: `feedback, err := agentfeedback.New(agentfeedback.Options{\n    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),\n    Include: []string{"${route}"}, // replace with customer-agent product routes\n    CustomerRef: func(r *http.Request) string { return authenticatedAccountID(r.Context()) },\n    SessionRef: func(r *http.Request) string { return agentSessionID(r.Context()) }, // optional\n})\nif err != nil { log.Fatal(err) }\ndefer feedback.Shutdown(context.Background())\nhandler := feedback.Middleware(router)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    rust: {
      install: `mkdir -p vendor/agent-feedback-rust\ncurl -fsSL ${artifacts}/agent-feedback-rust-0.2.0.tar.gz | tar -xz -C vendor/agent-feedback-rust`,
      code: `let feedback = AgentFeedbackLayer::new(\n    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)\n        .include(["${route}"]) // replace with customer-agent product routes\n        .customer_ref(|request| authenticated_account_id(request))\n        .session_ref(|request| agent_session_id(request)), // optional\n)?;\nlet app = router.layer(feedback.clone());`,
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
      install: `curl -fsSLO ${artifacts}/agent-feedback-protocol-v1.zip`,
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
  instructions: { install: string; code: string },
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
      : "- Derive customerRef only from verified product authentication. Use a stable opaque account or tenant ID, never a name, email, or caller-supplied unverified value. It is required for durable Ask once.";
  return `Add Agent Feedback to this repository.

Product surface: ${SETUP_SURFACES[surface].name}
Integration: ${stackName(stack)}

Requirements:
- Use AGENT_FEEDBACK_KEY from the server environment. Never print or expose it.
- Install the official package with: ${instructions.install}
- Configure the integration once using this reference:

${instructions.code}

${routeBoundaryRequirement}
${identityRequirement}
- Add sessionRef only when your product already has proof that interactions belong to one journey; never infer continuity.
- Never put the product key in browser JavaScript.
- Preserve response shapes, errors, streams, and binary responses.
- Verify unknown, approved, and declined states when AGENT_FEEDBACK_MODE=ask_once.
- Make one real request or MCP tool call and prove the first opportunity, first confirmed interaction, and first report in Setup.

Protocol: ${origin}/.well-known/agent-feedback-v1.json`;
}
