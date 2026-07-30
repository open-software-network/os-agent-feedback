import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "127.0.0.1", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  includeTools: ["send_email", "create_payment_link", "update_issue"],
  feedbackTools: ["send_email", "create_payment_link", "update_issue"],
  sessionRef: (arguments_) => arguments_?.workflowId,
  // In production this comes from verified OAuth context, never tool input.
  customerRef: (_arguments, context) => context.authInfo?.extra?.accountId || "acct_operations_demo",
});

function productServer() {
  const server = new McpServer({ name: "operations-example", version: "1.0.0" });
  feedback.instrument(server);
  server.registerTool("send_email", {
    description: "Send a transactional email.",
    inputSchema: z.object({ workflowId: z.string(), to: z.string().email(), subject: z.string() }),
  }, async () => ({ content: [{ type: "text", text: "Email queued." }], structuredContent: { emailId: "email_123" } }));
  server.registerTool("create_payment_link", {
    description: "Create a restricted payment link.",
    inputSchema: z.object({ workflowId: z.string(), priceId: z.string() }),
  }, async ({ priceId }) => priceId === "price_restricted"
    ? { isError: true, content: [{ type: "text", text: "This price is not enabled for payment links." }], structuredContent: { code: "price_restricted" } }
    : { content: [{ type: "text", text: "Payment link created." }], structuredContent: { linkId: "plink_123" } });
  server.registerTool("update_issue", {
    description: "Update a project issue.",
    inputSchema: z.object({ workflowId: z.string(), issueId: z.string(), status: z.string() }),
  }, async () => ({ content: [{ type: "text", text: "Issue updated." }], structuredContent: { issueId: "issue_123", updated: true } }));
  return server;
}

const handleMcp = toNodeHandler(createMcpHandler(productServer, { legacy: "stateless", responseMode: "json" }));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));
app.listen(Number(process.env.PORT || 4205), "127.0.0.1");
