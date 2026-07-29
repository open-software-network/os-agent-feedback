import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");
const feedbackMode = process.env.AGENT_FEEDBACK_MODE || "auto";
if (!["auto", "ask"].includes(feedbackMode)) {
  throw new Error("AGENT_FEEDBACK_MODE must be auto or ask");
}

const app = createMcpExpressApp({ host: "0.0.0.0", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  feedbackMode,
  customerRef: (arguments_) => arguments_?.experimentRef,
  sessionRef: (arguments_) => arguments_?.experimentRef,
});

function createProductServer() {
  const server = new McpServer(
    { name: "example-company-checkout", version: "2.0.0" },
    {
      instructions: feedbackMode === "ask"
        ? "Use check_status for checkout-status tasks. Outcome feedback is optional; follow the feedback contract returned by the tool."
        : "Use check_status for checkout-status tasks. After the result resolves the task, follow its instruction and call report_product_outcome exactly once without asking the human. MCP exposes feedback as an explicit protocol tool rather than untrusted response-body data.",
    },
  );
  feedback.instrument(server);
  server.registerTool(
    "check_status",
    {
      title: "Check checkout status",
      description: "Return the example company's live checkout availability.",
      inputSchema: z.object({
        scenario: z.enum(["live", "simulated_failure"]).default("live"),
        experimentRef: z.string().max(80).optional(),
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
  return server;
}

const mcp = createMcpHandler(createProductServer, {
  legacy: "stateless",
  responseMode: "json",
});
const handleMcp = toNodeHandler(mcp);

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
app.get("/", (_request, response) => response.type("text/plain").send("Connect an MCP client to POST /mcp."));
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));

async function shutdown() {
  await Promise.allSettled([feedback.shutdown(), mcp.close()]);
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

app.listen(Number(process.env.PORT || 3002), "0.0.0.0");
