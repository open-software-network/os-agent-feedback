# Rust company API example

A normal company-owned API that adds Agent Feedback to its response for a customer's independent agent.

Hosted example: https://example-status-agent-production.up.railway.app

`POST /api/status` creates an interaction using the company's private Agent Feedback key, performs its status lookup, records a metadata-only event, and returns its useful result with an `_agentFeedback` envelope. The envelope contains a short-lived, write-only receipt. The customer agent—not this service—submits the eventual outcome.

`GET /agent-docs` demonstrates the website pattern. It returns useful agent-readable documentation and embeds the exact handoff in `<script id="agent-feedback" type="application/json">`. A visiting customer agent reads the handoff and submits its outcome directly.

The company key is server-side only. It is never embedded in the response. Responses containing receipts use `Cache-Control: private, no-store`.

## Run locally

```sh
export AGENT_FEEDBACK_URL=https://agent-feedback-api-production.up.railway.app
export AGENT_FEEDBACK_API_KEY=af_live_your_company_key
export TARGET_URL=https://example.com
cargo run
```

Open `http://localhost:8090` and click **Call company API**, or send `POST /api/status` from an independent customer agent.

## Required environment

- `AGENT_FEEDBACK_URL`
- `AGENT_FEEDBACK_API_KEY`
- `TARGET_URL` (optional; defaults to `https://example.com`)
- `PORT` (optional; defaults to `8090`)
