import { randomUUID } from "node:crypto";
import { instrumentMcp } from "@agent-feedback/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "127.0.0.1" });
const sessions = new Map();

function productServer(session) {
  const server = new McpServer({ name: "setup-matrix-node-mcp", version: "1.0.0" });
  const feedback = instrumentMcp(server, {
    apiKey: process.env.AGENT_FEEDBACK_KEY,
    endpoint: process.env.AGENT_FEEDBACK_URL,
    sessionRef: () => session.id,
  });
  server.registerTool("search", { description: "Return a deterministic setup-matrix result.", inputSchema: z.object({ query: z.string() }) }, async ({ query }) => ({
    content: [{ type: "text", text: `node-mcp-result:${query}` }],
    structuredContent: { stack: "node-mcp", answer: `node-mcp-result:${query}` },
  }));
  return { server, feedback };
}

app.get("/health", (_request, response) => response.json({ ok: true }));
app.post("/mcp", async (request, response) => {
  const existing = sessions.get(request.headers["mcp-session-id"]);
  if (existing) return existing.transport.handleRequest(request, response, request.body);
  if (request.body?.method !== "initialize") return response.status(400).json({ error: "initialize first" });
  const session = { id: randomUUID() };
  const { server, feedback } = productServer(session);
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (id) => { session.id = id; sessions.set(id, { transport, server, feedback }); },
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
});

app.listen(Number(process.env.PORT || 4107), "127.0.0.1");
