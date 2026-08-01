# Epode

Epode tells companies whether their product actually worked for the independent customer agents using it.

A company instruments selected API, website, or MCP surfaces once. Every SDK creates a short-lived, write-only interaction receipt locally and adds the same feedback contract to eligible successful responses. Telemetry is always asynchronous, and HTTP responses never wait on Epode. In Ask once mode, the receipt carries an opaque subject so Epode Companion can resolve the remembered decision through its trusted inspection tool. After the customer agent understands the product's contribution, it can submit:

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

Workspaces support OS Account teams. Owners can invite admins or members, change roles, and remove teammates. Admins can manage products and member invitations. Members have read-only access to feedback and observability data. Email-bound invitations last seven days. Teams can also create a reusable, member-only share link that lasts 24 hours.

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
  customerRef: req => req.user?.accountId, // stable opaque ID; required for durable Ask once
}));
```

No handler changes, relay endpoint, agent account, or agent-side preference store is required.

Collection has four modes. `never_ask` submits autonomously without interrupting the user. `ask_once` lets the agent finish the product task, then emits the exact permission question and a two-value decision action. Epode stores `approved` or `declined` for the product plus an opaque HMAC-derived customer subject; agents store nothing. Approval reveals a separate report contract, refusal suppresses future asks, and silence or ambiguity stores no decision. `ask_always` uses the same answer-first two-step flow for every report. `off` emits no feedback contract.

Epode remembering the decision does not force a fresh generic HTTP agent to trust or act on it. Raw HTTP stays `best_effort_without_agent_adapter`; MCP tools and trusted host adapters are the higher-confidence paths.

For Codex and Claude Code users, **Epode Companion** is the trusted host adapter for ordinary HTTP APIs and websites. It is installed once from the Epode marketplace, recognizes short-lived Epode response handles, and exposes only three fixed-destination MCP actions: verify a request and its canonical product/policy, record an explicit consent decision, and submit a bounded categorical outcome. It never accepts prompt, transcript, task, response, identity, or arbitrary report text. Native company MCP remains the preferred path when a product already has an MCP server.

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
- `examples/customer-agent-http/` — raw HTTP protocol/conformance harness; customer users install Epode Companion instead
- `web/` — Next.js dashboard frontend

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

## Dashboard release browser check

Run `make web-release-e2e` for the signed-in dashboard release check. It starts a
disposable local API fixture and the Next.js app, then drives Chrome through the
same root-host BFF routes used by `app.epode.ai`; it never calls OS Accounts or a
shared database. The fixture issues a localhost-only, test-value session cookie
and exists only inside the test process, so it cannot authenticate against a
deployed API.

The command covers root routing, the failed-auth retry handoff, product switching
and creation, Home, server-filtered/paginated Feedback and Sessions detail views,
Setup copy, Collection policy, Team invitations, and BFF path/header forwarding.
It writes a screenshot and request trace under `.artifacts/browser-release-e2e/`
only when it fails. Set `EPODE_E2E_BROWSER` to an explicit Chrome/Chromium binary
when the runner does not expose one at a standard path.

This is the CI-safe canary command. Keep one protected live smoke before a release:
sign in through OS Accounts on `https://app.epode.ai`, verify one dashboard API
response after the real cookie exchange, and sign out. That live check deliberately
is not automated here because the fixture cookie must remain invalid in production.
