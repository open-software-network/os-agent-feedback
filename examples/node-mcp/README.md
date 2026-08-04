# Node MCP company product example

This is the native protocol integration for MCP `2026-07-28`. The server is stateless: every request carries
its own version, client metadata, and capabilities. There is no initialization handshake or transport session.
No Epode Companion install is required because the product server exposes the feedback tools itself.

```js
const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
});

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "my-product", version: "1.0.0" });
  feedback.instrument(server); // before registering business tools
  // server.registerTool(...)
  return server;
});
```

The customer's MCP client can see and call the feedback tool explicitly. A business-tool call is immediately a confirmed interaction; the later feedback tool links a structured report with a narrative, optional impact, findings, workaround, and confidence.

Set `AGENT_FEEDBACK_MODE=never_ask` to submit autonomously, `ask_once` to let Epode remember approval or refusal
when verified identity exists, `ask_always` to ask before each report, or `off` to leave the MCP server's tool
surface untouched. In both ask modes, the product result directs the agent only to
`record_product_feedback_consent`; approval returns a separate `report_product_feedback` action.

The runnable server requires `Bearer demo-account-a-token` (or the second account's
`Bearer demo-account-b-token`) and derives identity from the verified MCP HTTP auth context. These fixed tokens
are instructional stand-ins for signature or introspection verification, including audience, expiry, scope, and
account membership checks.

Call `check_status` with `operation: "create"` to mint a canonical product journey ID. Pass that result as the
`journeyId` candidate on `operation: "follow_up"`. The server resolves the candidate against account-owned state;
missing, malformed, unknown, and another account's IDs remain unlinked. Repeating the same candidate—whether a
normal follow-up or cache replay—reuses the canonical ID. Repeating a create with the same `idempotencyKey`
demonstrates product-owned deduplication: the registry returns the existing canonical journey while Epode records
a fresh Response. Another create without that key gets a new journey ID. The idempotency key itself is never
Session proof. A failed business result can remain linked when ownership is proven.

The in-memory registry is deliberately small and instructional. Production products use durable authenticated
state shared by their workers. Argument and result fields are candidates, not proof by themselves; never fall
back to an MCP transport/session ID. The MCP transport remains stateless and the Epode runtime remains a single
process-level object.

This example intentionally does not claim to identify the agent. MCP client information remains a self-reported runtime hint, and Epode records each tool call as its own interaction unless the product supplies an explicit application-level continuity handle.
