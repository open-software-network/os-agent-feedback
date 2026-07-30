import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "127.0.0.1", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  includeTools: ["resolve_library", "query_docs"],
  feedbackTools: ["query_docs"],
  sessionRef: (arguments_) => arguments_?.runId,
  customerRef: (_arguments, context) => context.http?.authInfo?.extra?.accountId || "acct_docs_demo",
});

function productServer() {
  const server = new McpServer({ name: "current-docs-example", version: "1.0.0" });
  feedback.instrument(server);
  server.registerTool("resolve_library", {
    description: "Resolve a package name.", inputSchema: z.object({ name: z.string(), runId: z.string() }),
  }, async ({ name }) => ({ content: [{ type: "text", text: `/vendor/${name}` }], structuredContent: { libraryId: `/vendor/${name}` } }));
  server.registerTool("query_docs", {
    description: "Query current documentation.", inputSchema: z.object({ libraryId: z.string(), question: z.string(), runId: z.string() }),
  }, async () => ({ content: [{ type: "text", text: "The current option is enabled with cacheComponents: true." }], structuredContent: { citations: ["https://docs.example.test/current"] } }));
  return server;
}

const handleMcp = toNodeHandler(createMcpHandler(productServer, { legacy: "stateless", responseMode: "json" }));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));
app.listen(Number(process.env.PORT || 4204), "127.0.0.1");
