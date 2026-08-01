# Fastify company product example

This example shows both agent-readable HTML and structured JSON. One Fastify plugin instruments `/agent-docs` and `/api/search` globally.

```js
await app.register(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  include: ["/agent-docs", "/api/search"],
}));
```

HTML receives an embedded `application/json` feedback contract. JSON objects receive `_agentFeedback`. Both are
best-effort for generic agents. The supported customer-facing path for Codex and Claude Code is the shared
[Epode Companion](../../docs/integrations/companion.mdx), installed once per user runtime for every
Epode-instrumented product.
