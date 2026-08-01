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
  const nodeInstall = `npm install ${artifacts}/agent-feedback-node-0.1.0.tgz`;
  const byStack: Record<SetupStack, { install: string; code: string; verify: string }> = {
    "node-mcp": {
      install: `${nodeInstall}\nnpm install @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express`,
      code: `import { createMcpInstrumentation } from "@agent-feedback/node/mcp";\n\nconst feedback = createMcpInstrumentation({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n});\nfeedback.instrument(productMcpServer);`,
      verify:
        "Call server/discover, then call one normal product tool from an MCP 2026-07-28 client.",
    },
    "manual-mcp": {
      install: `curl -O ${artifacts}/agent-feedback-protocol-v1.zip`,
      code: "Implement stateless MCP 2026-07-28, server/discover, confirmed telemetry, _agentFeedback results, and report_product_feedback.",
      verify:
        "Verify discovery, stateless headers, one product tool call, and one feedback report.",
    },
    "node-express": {
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/express";\n\napp.use(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"],\n}));`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "node-fastify": {
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/fastify";\n\nawait app.register(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"],\n}));`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-asgi": {
      install: `pip install ${artifacts}/agent_feedback-0.1.0-py3-none-any.whl`,
      code: `app = AgentFeedbackASGI(\n    app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),\n)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-wsgi": {
      install: `pip install ${artifacts}/agent_feedback-0.1.0-py3-none-any.whl`,
      code: `app.wsgi_app = AgentFeedbackWSGI(\n    app.wsgi_app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),\n)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    go: {
      install: "go get github.com/open-software-network/os-epode/sdk/go@latest",
      code: `feedback, err := agentfeedback.New(agentfeedback.Options{\n    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),\n    Include: []string{"${route}"},\n})\nhandler := feedback.Middleware(router)`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    rust: {
      install: `mkdir -p vendor/agent-feedback-rust\ncurl -fsSL ${artifacts}/agent-feedback-rust-0.1.0.tar.gz | tar -xz -C vendor/agent-feedback-rust`,
      code: `let feedback = AgentFeedbackLayer::new(\n    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)\n        .include(["${route}"]),\n)?;\nlet app = router.layer(feedback);`,
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
        "Confirm an adjacent path returns 404 and POST returns 405 without reaching upstream; then compare ordinary and opted-in docs responses: their bodies must be identical.",
    },
    "manual-http": {
      install: `curl -O ${artifacts}/agent-feedback-protocol-v1.zip`,
      code: `GET ${origin}/.well-known/agent-feedback-v1.json\n\nSign a capability, add the feedback envelope to eligible 2xx responses, and queue opportunity telemetry.`,
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
      : "- Limit HTTP or HTML integration to routes used by customer agents.";
  return `Add Agent Feedback to this repository.

Product surface: ${SETUP_SURFACES[surface].name}
Integration: ${stackName(stack)}

Requirements:
- Use AGENT_FEEDBACK_KEY from the server environment. Never print or expose it.
- Install the official package with: ${instructions.install}
- Configure the integration once using this reference:

${instructions.code}

${routeBoundaryRequirement}
- Never put the product key in browser JavaScript.
- Preserve response shapes, errors, streams, and binary responses.
- Make one real request or MCP tool call to verify the connection.

Protocol: ${origin}/.well-known/agent-feedback-v1.json`;
}
