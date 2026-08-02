import { createMcpInstrumentation } from "@epode/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "127.0.0.1", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  includeTools: ["browser_*"],
  // One report for the completed browser journey, not one report per click.
  feedbackTools: ["browser_close"],
  sessionRef: (_arguments, context) => context.http?.authInfo?.extra?.sessionId,
  accountRef: (_arguments, context) => context.http?.authInfo?.extra?.accountId,
  userRef: (_arguments, context) => context.http?.authInfo?.extra?.userId,
  anonymousRef: (_arguments, context) => context.http?.authInfo?.extra?.anonymousId,
  customerRef:
    process.env.AGENT_FEEDBACK_MODE === "ask_once"
      ? (_arguments, context) => context.http?.authInfo?.extra?.accountId
      : undefined,
  runtimeHint: (_arguments, context) => context.clientInfo?.name,
});

function productServer() {
  const server = new McpServer({ name: "browser-automation-example", version: "1.0.0" });
  feedback.instrument(server);
  server.registerTool("browser_start", {
    description: "Start a hosted browser session.", inputSchema: z.object({ runId: z.string() }),
  }, async ({ runId }) => ({
    content: [{ type: "text", text: "Browser session started." }],
    structuredContent: { sessionId: `browser_${runId}` },
  }));
  server.registerTool("browser_navigate", {
    description: "Navigate the browser.", inputSchema: z.object({ sessionId: z.string(), url: z.string() }),
  }, async ({ url }) => ({ content: [{ type: "text", text: `Navigated to ${url}` }], structuredContent: { ok: true } }));
  server.registerTool("browser_act", {
    description: "Perform a browser action.", inputSchema: z.object({ sessionId: z.string(), action: z.string() }),
  }, async ({ action }) => ({ content: [{ type: "text", text: `Performed ${action}` }], structuredContent: { ok: true } }));
  server.registerTool("browser_extract", {
    description: "Extract the final requested value.", inputSchema: z.object({ sessionId: z.string(), field: z.string() }),
  }, async ({ field }) => ({ content: [{ type: "text", text: `${field}: $49` }], structuredContent: { field, value: "$49" } }));
  server.registerTool("browser_close", {
    description: "Close the hosted browser.", inputSchema: z.object({ sessionId: z.string() }),
  }, async () => ({ content: [{ type: "text", text: "Browser closed." }], structuredContent: { closed: true } }));
  server.registerTool("admin_health", {}, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return server;
}

const handleMcp = toNodeHandler(createMcpHandler(productServer, { legacy: "stateless", responseMode: "json" }));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.use("/mcp", (request, response, next) => {
  if (request.get("authorization") !== "Bearer demo-mcp-customer-token") {
    return response.status(401).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    });
  }
  request.auth = {
    token: "verified-browser-oauth",
    clientId: "browser-client",
    scopes: [],
    extra: {
      accountId: "acct_browser_demo",
      userId: "user_browser_demo",
      anonymousId: "anon_browser_demo",
      sessionId: "browser_run_77",
    },
  };
  next();
});
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));
app.listen(Number(process.env.PORT || 4203), "127.0.0.1");
