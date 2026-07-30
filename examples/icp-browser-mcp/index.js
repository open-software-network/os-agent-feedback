import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
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
  sessionRef: (arguments_, _context, result) =>
    arguments_?.sessionId || result?.structuredContent?.sessionId,
  customerRef: (_arguments, context) => context.authInfo?.extra?.accountId || "acct_browser_demo",
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
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));
app.listen(Number(process.env.PORT || 4203), "127.0.0.1");
