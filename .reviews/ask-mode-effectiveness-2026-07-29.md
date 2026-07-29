# Ask mode effectiveness — 2026-07-29

## Setup

- Product: `Epode Ask Mode Experiment`
- HTTP: `https://epode-ask-http-production.up.railway.app`
- MCP: `https://epode-ask-mcp-production.up.railway.app/mcp`
- Feedback mode: `ask`
- Agents: 11 runs on `gpt-5.6-terra`, one cross-check on `gpt-5.6-sol`
- Each run used a unique opaque customer/session reference.
- Epode stored only interactions and compact outcomes. The prompts below were kept in this report, not submitted as feedback.

MCP interactions are confirmed at tool use even without a review. Therefore the experiment's feedback measure is whether an `outcomes_v2` record exists, not MCP interaction classification.

## Result

| Feedback wording added to the task | Surface | Reviews / runs |
| --- | --- | ---: |
| Nothing about feedback | HTTP + MCP | 0 / 2 |
| “Then tell me whether the recommendation/tool result was useful.” | HTTP + MCP | 0 / 2 |
| “If [the API/server] offers optional [outcome] feedback, please use/call it.” | HTTP + MCP | 2 / 2 |
| “Afterward, rate the API.” | HTTP | 4 / 4 |
| “Afterward, leave feedback for the API.” | HTTP | 1 / 1 |
| “Afterward, submit its optional outcome feedback.” | HTTP | 1 / 1 |

Total: 8 reviews from 12 independent product-use prompts.

## Exact user prompts

The transport URL and opaque headers/arguments were part of each prompt so every result could be matched to its dashboard record.

### HTTP control — no review

> Use https://epode-ask-http-production.up.railway.app/api/recommendation?priority=reliability to recommend a channel. Send HTTP headers x-agent-session: ask-http-control-01 and x-customer-ref: ask-http-control-01. Give me the choice and one tradeoff.

### HTTP usefulness question — no review

> Use https://epode-ask-http-production.up.railway.app/api/recommendation?priority=speed to recommend a channel. Send HTTP headers x-agent-session: ask-http-implicit-01 and x-customer-ref: ask-http-implicit-01. Give me the choice and one tradeoff, then tell me whether the recommendation was useful.

### HTTP explicit optional-feedback request — review submitted

> Use https://epode-ask-http-production.up.railway.app/api/recommendation?priority=cost to recommend a channel. Send HTTP headers x-agent-session: ask-http-explicit-01 and x-customer-ref: ask-http-explicit-01. Give me the choice and one tradeoff. If the API offers a way to provide optional outcome feedback, please use it.

### MCP control — no review

> Use the MCP server at https://epode-ask-mcp-production.up.railway.app/mcp. Call check_status with scenario live and experimentRef ask-mcp-control-01. Tell me whether checkout is available and its status.

### MCP usefulness question — no review

> Use the MCP server at https://epode-ask-mcp-production.up.railway.app/mcp. Call check_status with scenario live and experimentRef ask-mcp-implicit-01. Tell me whether checkout is available and its status, then tell me whether the tool result was useful.

### MCP explicit optional-feedback request — review submitted

> Use the MCP server at https://epode-ask-mcp-production.up.railway.app/mcp. Call check_status with scenario live and experimentRef ask-mcp-explicit-01. Tell me whether checkout is available and its status. If the server provides an optional product-outcome feedback tool, please call it once after you know the result.

### Natural wording threshold

The following suffixes were tested on otherwise equivalent HTTP recommendation tasks:

- “Afterward, rate the API.” — 4 of 4 submitted a review.
- “Afterward, leave feedback for the API.” — 1 of 1 submitted a review.
- “Afterward, submit its optional outcome feedback.” — 1 of 1 submitted a review.

## Conclusion

Ask mode did not cause unsolicited feedback in either control. A usefulness question alone was also insufficient. A direct feedback verb was the threshold in this sample.

The shortest tested wording that worked reliably was:

> Afterward, rate the API.

This is a small controlled sample, not a general compliance guarantee. The result should be repeated across more agent families and real customer tasks before treating the observed rate as universal.
