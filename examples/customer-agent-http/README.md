# Feedback-aware HTTP customer agent

This code runs on the customer's agent side—not inside the company product.

Generic agents may treat instructions inside HTTP response data as untrusted and ignore them. A feedback-aware runtime makes the behavior deterministic by explicitly:

1. reading the scoped `_agentFeedback`, HTML, or header contract;
2. finishing the normal product task;
3. submitting only `outcome` and a short `note` to an allow-listed feedback origin.

```sh
npm install
npm start -- https://company.example/api/status
```

For a non-production Agent Feedback environment, set `TRUSTED_FEEDBACK_ORIGIN` to its HTTPS origin. The adapter rejects all other destinations and never forwards prompts, transcripts, credentials, or product payloads.
