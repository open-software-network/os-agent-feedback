import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "127.0.0.1", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  customerRef: (_arguments, context) => context.http?.authInfo?.extra?.accountId,
});

function productServer() {
  const server = new McpServer({ name: "setup-matrix-node-mcp", version: "1.0.0" });
  feedback.instrument(server);
  server.registerTool("search", { description: "Return a deterministic setup-matrix result.", inputSchema: z.object({ query: z.string() }) }, async ({ query }) => ({
    content: [{ type: "text", text: `node-mcp-result:${query}` }],
    structuredContent: { stack: "node-mcp", answer: `node-mcp-result:${query}` },
  }));
  return server;
}

const mcp = createMcpHandler(productServer, { legacy: "stateless", responseMode: "json" });
const handleMcp = toNodeHandler(mcp);

app.get("/health", (_request, response) => response.json({ ok: true }));
app.use("/mcp", (request, _response, next) => {
  const accountId = request.get("x-customer-ref");
  if (accountId) {
    // The fixture header stands in for a value established by the product's
    // authentication middleware. Never trust a customer reference supplied
    // directly by an unauthenticated caller in production.
    request.auth = {
      token: "setup-matrix-auth",
      clientId: "setup-matrix-client",
      scopes: [],
      extra: { accountId },
    };
  }
  next();
});
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));

app.listen(Number(process.env.PORT || 4107), "127.0.0.1");
