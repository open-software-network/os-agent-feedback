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

The customer's MCP client can see and call the outcome tool explicitly. A successful business-tool call is immediately a confirmed interaction; the later outcome tool links a compact `success`, `partial`, or `failure` review to it.

Set `AGENT_FEEDBACK_MODE=ask` to require one end-of-task permission question. The outcome tool accepts `userApproved: true` only after explicit approval; refusal or no response means no submission.

This example intentionally does not claim to identify the agent. MCP client information remains a self-reported runtime hint, and Epode records each tool call as its own interaction unless the product supplies an explicit application-level continuity handle.
