# Express company product example

This is the company-side integration. One global middleware instruments selected successful product responses without changing route handlers or waiting on Agent Feedback.

```js
const feedback = agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  include: ["/api/status"],
});

app.use(feedback);
```

`GET /api/status` and `GET /api/recommendation?priority=reliability` keep their original JSON shapes and add `_agentFeedback`. This metadata creates an unclassified opportunity. It becomes a confirmed interaction only if the receipt is submitted.

This hosted playground is anonymous and intentionally omits `customerRef`; Ask once therefore uses the safe
per-use fallback instead of trusting an account header. In a real product, authentication must establish the
account before the Agent Feedback middleware reads it.

For disposable evaluator deployments only, set `EPODE_EXAMPLE_ENABLE_EXPERIMENT_REFS=1` and send the same opaque
`x-agent-session` value on related requests to exercise explicit session grouping:

```sh
curl -H 'x-agent-session: evaluation-123' https://example-status-agent-production.up.railway.app/api/status
curl -H 'x-agent-session: evaluation-123' 'https://example-status-agent-production.up.railway.app/api/recommendation?priority=reliability'
```

Generic agents may ignore side-effect instructions contained in HTTP data. The supported customer-facing path
for Codex and Claude Code is the shared [Epode Companion](../../docs/integrations/companion.mdx), installed once
per user runtime for every Epode-instrumented product. `../customer-agent-http` remains a protocol/conformance
harness; do not ask customers to install that example or the company SDK.

Set `AGENT_FEEDBACK_MODE=never_ask` to submit autonomously, `ask_once` to use the safe per-use permission fallback
in this anonymous example, `ask_always` to ask before every report, or `off` to expose no feedback action.
