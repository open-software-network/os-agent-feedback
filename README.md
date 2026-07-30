# Epode

Epode tells companies whether their product actually worked for the independent customer agents using it.

A company instruments selected API, website, or MCP surfaces once. Every SDK creates the same short-lived, write-only interaction receipt locally and adds the same feedback contract to eligible successful responses. The product response never waits for Agent Feedback. After the customer agent understands the product's contribution, it can submit:

```json
{
  "summary": "The result answered the question, but one field was stale.",
  "impact": "helped_with_friction",
  "confidence": 0.91,
  "findings": [
    { "kind": "strength", "topic": "relevance", "detail": "The top result was useful." },
    { "kind": "gap", "topic": "freshness", "severity": "major", "detail": "One field used an older API." }
  ],
  "workaround": { "used": true, "detail": "The agent verified the field in official docs." }
}
```

Agent Feedback does not identify agents. HTTP responses are unclassified opportunities until a receipt is used; generic HTTP agents may ignore response-side instructions, while a feedback-aware runtime can submit deterministically. MCP `2026-07-28` tool calls are confirmed agent interactions and expose feedback as an explicit protocol tool. The MCP transport is stateless; sessions exist only when the company supplies an explicit application-level continuity handle.

Dashboard data is organized as workspace → product → integration. Users choose a product once; its Home overview, keys, interactions, feedback, sessions, and collection policy stay scoped to that product.

Workspaces support OS Account teams. Owners can invite admins or members, change roles, and remove teammates. Admins can manage products and member invitations. Members have read-only access to feedback and observability data. Invitations are bound to the recipient's OS Account email or handle and can be accepted through a seven-day share link.

## Protocol-first integrations

First-class adapters currently cover:

- Node: Express, Fastify, and MCP
- Python: ASGI and WSGI
- Go: standard `net/http`
- Rust: Axum and Tower
- Every other language: the public HTTP protocol and conformance vectors

For example, Express remains one global middleware:

```ts
import { agentFeedback } from "@agent-feedback/node/express";

app.use(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  feedbackMode: "ask_once", // or use AGENT_FEEDBACK_MODE from Setup
  include: ["/search", "/docs/*"],
  customerRef: req => req.user?.accountId, // optional opaque ID
}));
```

No handler changes, primary-path network call, relay endpoint, or agent account is required.

Collection has four modes. `never_ask` submits autonomously without interrupting the user. `ask_once` asks once per
product and agent runtime, then remembers approval or refusal under an opaque product-scoped key.
`ask_always` requests fresh permission for every report. `off` emits no feedback contract. Epode
does not receive the stored ask-once preference or treat it as an identity.

## Repository

- `backend/` — Rust/Axum/PostgreSQL API, OS Accounts dashboard, migrations, and acceptance tests
- `sdk/node/` — `@agent-feedback/node` with Express, Fastify, MCP, and the integration doctor
- `sdk/python/` — dependency-free ASGI/WSGI middleware and agent helper
- `sdk/go/` — standard-library HTTP middleware and agent helper
- `sdk/rust/` — Axum/Tower middleware and agent helper
- `protocol/v1/` — language-neutral schemas, signing algorithm, and conformance vector
- `examples/node-express/` — hosted JSON API playground with explicit agent-session continuity
- `examples/node-fastify/` — hosted agent-readable website example
- `examples/node-mcp/` — hosted stateless MCP 2026-07-28 example with a 2025 compatibility fallback
- `examples/python-asgi/` — FastAPI/ASGI product example
- `examples/go-http/` — standard-library Go product example
- `examples/rust-axum/` — Rust Axum product example
- `examples/customer-agent-http/` — optional deterministic HTTP/HTML agent-side adapter
- `app/` — public product site

## Production

- Dashboard/API: https://app.epode.ai
- Express example: https://example-status-agent-production.up.railway.app
- MCP example: https://example-mcp-agent-production.up.railway.app/mcp
- Ask-mode HTTP lab: https://epode-ask-http-production.up.railway.app
- Ask-mode MCP lab: https://epode-ask-mcp-production.up.railway.app/mcp
- Ask-mode effectiveness report: `.reviews/ask-mode-effectiveness-2026-07-29.md`
- Ask-for-permission behavior report: `.reviews/ask-mode-consent-2026-07-29.md`

The Fastify example and public Sites URL are assigned during the v2 rollout.

## Cross-language canary

- Node Express: https://example-status-agent-v2-canary.up.railway.app
- Node Fastify: https://example-fastify-agent-v2-canary.up.railway.app
- Node MCP: https://example-mcp-agent-v2-canary.up.railway.app/mcp
- Python ASGI: https://example-python-agent-v2-canary.up.railway.app
- Go `net/http`: https://example-go-agent-v2-canary.up.railway.app
- Rust Axum: https://example-rust-axum-agent-v2-canary.up.railway.app
- Protocol and SDK downloads: https://agent-feedback-api-v2-canary.up.railway.app/.well-known/agent-feedback-v1.json
