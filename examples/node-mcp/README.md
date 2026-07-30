# Node MCP company product example

This is the reliable autonomous integration for MCP `2026-07-28`. The server is stateless: every request carries its own version, client metadata, and capabilities. There is no initialization handshake or transport session.

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

Set `AGENT_FEEDBACK_MODE=never_ask` to submit autonomously, `ask_once` to let Epode remember approval or refusal by opaque `customerRef`, or `ask_always` to ask before each report. Both ask modes expose only `record_product_feedback_consent` first and reveal `report_product_feedback` after approval.

This example intentionally does not claim to identify the agent. MCP client information remains a self-reported runtime hint, and Epode records each tool call as its own interaction unless the product supplies an explicit application-level continuity handle.
