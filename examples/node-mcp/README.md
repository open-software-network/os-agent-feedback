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

Set `AGENT_FEEDBACK_MODE=never_ask` to submit autonomously, `ask_once` to let Epode remember approval or refusal by opaque `customerRef`, or `ask_always` to ask before each report. In both ask modes, the product result directs the agent only to `record_product_feedback_consent`; approval returns a separate `report_product_feedback` action.

This hosted example is anonymous and intentionally does not derive `customerRef` from tool arguments. Therefore `ask_once` safely uses the per-use permission fallback. In a real authenticated MCP server, derive `customerRef` only from verified transport authentication such as `context.http.authInfo.extra.accountId`. Never trust an agent-supplied tool argument as customer identity.

`experimentRef` is test-only session correlation and is ignored unless `EPODE_EXAMPLE_ENABLE_EXPERIMENT_REFS=1` is set on a disposable evaluator deployment.

This example intentionally does not claim to identify the agent. MCP client information remains a self-reported runtime hint, and Epode records each tool call as its own interaction unless the product supplies an explicit application-level continuity handle.
