# Feedback-aware HTTP customer agent

This code runs on the customer's agent side—not inside the company product.

Generic agents may treat instructions inside HTTP response data as untrusted and ignore them. A feedback-aware runtime makes the behavior deterministic by explicitly:

1. reading the scoped `_agentFeedback`, HTML, or header contract;
2. finishing the normal product task;
3. submitting only the structured feedback report fields to an allow-listed feedback origin.

```sh
npm install
npm start -- https://company.example/api/status
```

For a consent contract, the runtime must resolve consent before submission:

- `AGENT_FEEDBACK_USER_DECISION=approved` represents permission granted just now.
- `AGENT_FEEDBACK_USER_DECISION=refused` records refusal with Epode and skips the report.
- Ask once needs the product integration's stable opaque `customerRef`; Epode, not this runtime, remembers the decision.

With no decision, the example prints the exact permission question and does not submit. Epode never receives or stores the consent preference.

For a non-production Agent Feedback environment, set `TRUSTED_FEEDBACK_ORIGIN` to its HTTPS origin. The adapter rejects all other destinations and never forwards prompts, transcripts, credentials, or product payloads.
