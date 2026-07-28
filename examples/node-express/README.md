# Express company product example

This is the company-side integration. One global middleware instruments selected successful product responses without changing route handlers or waiting on Agent Feedback.

```js
const feedback = agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  include: ["/api/status"],
});

app.use(feedback);
```

`GET /api/status` keeps its original JSON shape and adds `_agentFeedback`. This metadata creates an unclassified opportunity. It becomes a confirmed interaction only if the receipt is submitted.

Generic agents may ignore side-effect instructions contained in HTTP data. Use `../customer-agent-http` to demonstrate deterministic submission by a feedback-aware agent runtime.
