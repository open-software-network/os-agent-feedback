# `@agent-feedback/node`

Collect one compact outcome review from the independent customer agents using your product. The SDK never identifies an agent, never sends prompts or product payloads, and never waits for Agent Feedback on your response path.

There are two reliability levels:

- **MCP is protocol-backed.** The SDK registers an explicit `report_product_outcome` tool, which compatible agents can call autonomously.
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

## MCP

Call `instrumentMcp` immediately after constructing the server, before registering business tools:

```ts
import { instrumentMcp } from "@agent-feedback/node/mcp";

instrumentMcp(server, {
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
});
```

Business-tool results are decorated automatically and `report_product_outcome` is registered for the customer agent. MCP tool use is a confirmed agent interaction. HTTP traffic remains unclassified until its receipt is used.

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
