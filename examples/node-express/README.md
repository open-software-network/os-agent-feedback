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

Send the same opaque `x-agent-session` value on related requests to demonstrate a real product-defined session:

```sh
curl -H 'x-agent-session: evaluation-123' https://example-status-agent-production.up.railway.app/api/status
curl -H 'x-agent-session: evaluation-123' 'https://example-status-agent-production.up.railway.app/api/recommendation?priority=reliability'
```

Generic agents may ignore side-effect instructions contained in HTTP data. Use `../customer-agent-http` to demonstrate deterministic submission by a feedback-aware agent runtime.

Set `AGENT_FEEDBACK_MODE=never_ask` to submit autonomously, `ask_once` to let Epode remember approval or refusal by the configured opaque `customerRef`, or `ask_always` to run the answer-first decision flow for every report.
