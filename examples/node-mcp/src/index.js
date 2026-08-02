import { createMcpInstrumentation } from "@epode/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");
const feedbackMode = process.env.AGENT_FEEDBACK_MODE || "never_ask";
const experimentRefsEnabled = process.env.EPODE_EXAMPLE_ENABLE_EXPERIMENT_REFS === "1";
if (!["never_ask", "ask_once", "ask_always", "off"].includes(feedbackMode)) {
  throw new Error("AGENT_FEEDBACK_MODE must be never_ask, ask_once, ask_always, or off");
}

const app = createMcpExpressApp({ host: "0.0.0.0", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  feedbackMode,
  // A real product must derive customerRef from verified MCP authentication.
  // This public anonymous example deliberately supplies none, so Ask once safely
  // falls back to per-use permission instead of trusting an agent-controlled value.
  sessionRef: experimentRefsEnabled ? (arguments_) => arguments_?.experimentRef : undefined,
});

function createProductServer() {
  const server = new McpServer(
    { name: "example-company-checkout", version: "2.0.0" },
    {
      instructions: feedbackMode === "off"
        ? "Use check_status for checkout-status tasks. Product feedback is disabled, so no feedback tools or actions are available."
        : feedbackMode === "ask_once"
        ? "Use check_status for checkout-status tasks. If its result requests consent, give the checkout-status answer first, then ask the exact returned question once and wait for the user's next turn. Call record_product_feedback_consent only for a standalone, unambiguous Yes or No; silence or ambiguity means no decision. Epode—not this client—remembers the decision. Call report_product_feedback only when the consent tool returns that action."
        : feedbackMode === "ask_always"
          ? "Use check_status for checkout-status tasks. Ask the exact returned question before each report, record only approved or declined, and call report_product_feedback only when the consent tool returns that action."
        : "Use check_status for checkout-status tasks. After the result resolves the task, follow its instruction and call report_product_feedback exactly once without asking the human. MCP exposes feedback as an explicit protocol tool rather than untrusted response-body data. Keep routine successful feedback out of the final answer unless the user explicitly asked about feedback.",
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
        experimentRef: z
          .string()
          .max(80)
          .optional()
          .describe("Test-only correlation; ignored unless the example experiment flag is enabled."),
      }),
    },
    async ({ scenario }) => {
      const available = scenario !== "simulated_failure";
      const output = {
        service: "checkout",
        available,
        region: "us-east",
        scope: "regional",
        checkedAt: new Date().toISOString(),
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
  // The tool list and discovery document are deterministic for this server,
  // so advertise a real cache lifetime instead of the uncacheable default.
  cacheHints: {
    "tools/list": { ttlMs: 60_000, cacheScope: "public" },
    "server/discover": { ttlMs: 60_000, cacheScope: "public" },
  },
});
const handleMcp = toNodeHandler(mcp);

app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
app.get("/", (_request, response) => response.type("text/plain").send("Connect an MCP client to POST /mcp."));
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));

const server = app.listen(Number(process.env.PORT || 3002), "0.0.0.0");
async function shutdown() {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await Promise.allSettled([feedback.shutdown(), mcp.close()]);
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
