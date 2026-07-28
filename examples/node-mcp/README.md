# Node MCP company product example

This is the reliable autonomous integration. `instrumentMcp` registers `report_product_outcome` and decorates every business tool result with a short-lived feedback handle.

```js
const instrumentation = instrumentMcp(server, {
  apiKey: process.env.AGENT_FEEDBACK_KEY,
});
```

The customer's MCP client can see and call the outcome tool explicitly. A successful business-tool call is immediately a confirmed interaction; the later outcome tool links a compact `success`, `partial`, or `failure` review to it.

This example intentionally does not claim to identify the agent. The MCP session ID is used only as protocol-proven continuity.
