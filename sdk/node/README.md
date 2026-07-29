# `@agent-feedback/node`

Collect one compact outcome review from the independent customer agents using your product. The SDK never identifies an agent, never sends prompts or product payloads, and never waits for Agent Feedback on your response path.

There are two reliability levels:

- **MCP is protocol-backed.** The SDK registers an explicit `report_product_outcome` tool, which compatible agents can call autonomously.
- **Ask mode requests consent.** Set `feedbackMode: "ask"` to make the agent finish the task, ask the user once, and submit only after explicit approval. MCP requires `userApproved: true`; HTTP agent helpers require the same approval option.
- **HTTP and HTML are best-effort by default.** Generic agents may treat response metadata as untrusted and ignore its side-effect instruction. A feedback-aware agent adapter can make submission deterministic.

## Express

Until the npm registry release is connected, install the signed build directly from the production service:

```sh
npm install https://agent-feedback-api-production.up.railway.app/static/agent-feedback-node-0.1.0.tgz
```

```ts
import { agentFeedback } from "@agent-feedback/node/express";

app.use(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  include: ["/search", "/docs/*"],
  customerRef: req => req.user?.accountId, // optional opaque ID
}));
```

Compatible JSON objects receive `_agentFeedback`. HTML receives an embedded `application/json` handoff. Arrays and scalar JSON responses use `Agent-Feedback` and `Link` headers. Errors, redirects, streams, binary responses, assets, health routes, and unrelated routes are untouched. These HTTP opportunities remain unclassified unless the scoped receipt returns.

## Fastify

```ts
import { agentFeedback } from "@agent-feedback/node/fastify";

await app.register(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  include: ["/search", "/docs/*"],
}));
```

## MCP 2026-07-28

The current MCP transport is stateless and creates a fresh server for each HTTP request. Create one process-level Epode runtime so telemetry remains batched, then instrument each server before registering business tools:

```ts
import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { originValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
});

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "my-product", version: "1.0.0" });
  feedback.instrument(server);
  // Register your product tools after instrumentation.
  return server;
}, { legacy: "stateless" });

// [] rejects browser Origin requests; add only trusted browser client hostnames.
app.use("/mcp", originValidation([]));
const handleMcp = toNodeHandler(mcp);
app.all("/mcp", (req, res) => handleMcp(req, res, req.body));
```

The official handler implements `server/discover`, per-request protocol metadata, `Mcp-Method`/`Mcp-Name` validation, cache hints, and the required `resultType` field. Its legacy fallback keeps 2025-era clients working without transport-session state. Business-tool results are decorated automatically and `report_product_outcome` is registered for the customer agent. MCP tool use is a confirmed agent interaction.

`instrumentMcp(server, options)` remains available for existing long-lived or legacy server objects.

## Optional feedback-aware HTTP agent adapter

Agent runtimes that want deterministic HTTP/HTML feedback can explicitly consume the contract:

```ts
import {
  feedbackFromResponse,
  submitProductOutcome,
} from "@agent-feedback/node/agent";

const response = await fetch(productUrl);
const body = await response.json();
const feedback = feedbackFromResponse(response, body);

if (feedback) {
  await submitProductOutcome(
    feedback,
    { outcome: "success", note: "The product completed the task." },
    { allowedSubmitOrigins: ["https://agent-feedback-api-production.up.railway.app"] },
  );
}
```

The adapter requires an allow-listed HTTPS destination and submits only `outcome` and `note`.

## Verify the whole loop

```sh
npx agent-feedback-doctor https://your-product.example/search?q=test
```

The doctor verifies response injection and submits a real synthetic review with the scoped receipt. Set `AGENT_FEEDBACK_ENABLED=false` as an emergency kill switch.
