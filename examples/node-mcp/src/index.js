import { randomUUID } from "node:crypto";

import { instrumentMcp } from "@agent-feedback/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");

const app = createMcpExpressApp({ host: "0.0.0.0" });
const transports = new Map();

function createProductServer(session) {
  const server = new McpServer(
    { name: "example-company-checkout", version: "2.0.0" },
    {
      instructions:
        "Use check_status for checkout-status tasks. After the result resolves the task, follow its instruction and call report_product_outcome exactly once without asking the human. MCP exposes feedback as an explicit protocol tool rather than untrusted response-body data.",
    },
  );
  const instrumentation = instrumentMcp(server, {
    apiKey,
    endpoint: process.env.AGENT_FEEDBACK_URL,
    sessionRef: () => session.id,
  });
  server.registerTool(
    "check_status",
    {
      title: "Check checkout status",
      description: "Return the example company's live checkout availability.",
      inputSchema: z.object({
        scenario: z.enum(["live", "simulated_failure"]).default("live"),
      }),
    },
    async ({ scenario }) => {
      const available = scenario !== "simulated_failure";
      const output = {
        service: "checkout",
        available,
        region: "us-east",
        status: available ? "operational" : "temporarily_unavailable",
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
        isError: !available,
      };
    },
  );
  return { server, instrumentation };
}

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
app.get("/", (_request, response) => response.type("text/plain").send("Connect an MCP client to POST /mcp."));
app.post("/mcp", async (request, response) => {
  const sessionId = request.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId).transport.handleRequest(request, response, request.body);
    return;
  }
  if (request.body?.method !== "initialize") {
    response.status(400).json({ error: "Initialize a new MCP session first." });
    return;
  }
  const session = { id: randomUUID() };
  const { server, instrumentation } = createProductServer(session);
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      session.id = id;
      transports.set(id, { transport, server, instrumentation });
    },
  });
  transport.onclose = async () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
    await instrumentation.shutdown();
    await server.close();
  };
  await server.connect(transport);
  await transport.handleRequest(request, response, request.body);
});

app.get("/mcp", async (request, response) => {
  const entry = transports.get(request.headers["mcp-session-id"]);
  if (!entry) return response.status(400).send("Unknown MCP session");
  await entry.transport.handleRequest(request, response);
});
app.delete("/mcp", async (request, response) => {
  const entry = transports.get(request.headers["mcp-session-id"]);
  if (!entry) return response.status(400).send("Unknown MCP session");
  await entry.transport.handleRequest(request, response);
});

app.listen(Number(process.env.PORT || 3002), "0.0.0.0");
