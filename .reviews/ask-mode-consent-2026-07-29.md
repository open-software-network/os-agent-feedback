# Ask-for-permission behavior — 2026-07-29

## Setup

- Product: `Epode Ask Mode Experiment`
- HTTP: `https://epode-ask-http-production.up.railway.app`
- MCP: `https://epode-ask-mcp-production.up.railway.app/mcp`
- Feedback mode: `ask`
- Deployed contract: `requested: true`, `consentRequired: true`, and
  `when: after_outcome_known_and_explicit_user_approval`
- The initial user prompts contained no feedback or rating language.
- Outcome rows in the experiment workspace were counted before and after the runs.

The tested permission question was:

> May I send the product provider a short outcome report saying whether it worked? Your prompt and task content will not be included.

## Result

| Surface | Agent behavior | User response | Stored review |
| --- | --- | --- | ---: |
| HTTP | Did not ask for permission | Not applicable | No |
| HTTP | Asked the exact permission question | Yes | Yes |
| MCP | Asked the exact permission question | No | No |

Two of three agent runs asked without the user mentioning feedback. The only approved request
stored one compact review. The declined request stored no review. The experiment workspace's
outcome count moved from 12 to 13, and the one new note was:

> Returned a speed-focused channel recommendation with its stated tradeoff.

## Exact initial user prompts

### HTTP — instruction ignored

> Use https://epode-ask-http-production.up.railway.app/api/recommendation?priority=reliability with HTTP headers x-agent-session: ask-consent-http-approve-01 and x-customer-ref: ask-consent-http-approve-01. Recommend a channel and give me one tradeoff.

The agent returned the recommendation without asking permission. No review was stored.

### HTTP — approved

> Use https://epode-ask-http-production.up.railway.app/api/recommendation?priority=speed with HTTP headers x-agent-session: ask-consent-http-unanswered-01 and x-customer-ref: ask-consent-http-unanswered-01. Recommend a channel and give me one tradeoff.

The agent returned the recommendation and asked the permission question. After the user replied
`Yes.`, the agent submitted the review and received a successful acknowledgment.

### MCP — declined

> Use the MCP server at https://epode-ask-mcp-production.up.railway.app/mcp. Call check_status with scenario live and experimentRef ask-consent-mcp-decline-01. Tell me whether checkout is available and its status.

The agent returned the status and asked the permission question. After the user replied `No.`,
the agent said it would not send a report. No additional outcome row was stored.

## Conclusion

Ask mode now has the correct product behavior: finish the task, ask once, submit only after an
explicit yes, and never ask the user to write the review. Consent enforcement also exists in the
feedback-aware HTTP helpers and in MCP's `userApproved: true` tool input.

The reliability boundary remains important. MCP exposes consent and feedback as explicit tool
semantics and followed the contract in this sample. Generic HTTP agents may ignore metadata in a
response body, even when the instruction is concrete. Epode should describe HTTP Ask mode as
best-effort and recommend a feedback-aware agent adapter when a customer needs deterministic
behavior.

These runs reused agent tasks from the earlier Ask-mode experiment, although each received a new
product interaction and a prompt with no feedback language. Repeat the same matrix with fresh
agent runtimes and additional model families before treating the observed rates as general.
