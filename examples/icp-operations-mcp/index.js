import { createMcpInstrumentation } from "@epode/node/mcp";
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
  sessionRef: (_arguments, context) => context.http?.authInfo?.extra?.sessionId,
  // Identity and durable grouping come from verified OAuth context, never tool input.
  accountRef: (_arguments, context) => context.http?.authInfo?.extra?.accountId,
  userRef: (_arguments, context) => context.http?.authInfo?.extra?.userId,
  anonymousRef: (_arguments, context) => context.http?.authInfo?.extra?.anonymousId,
  customerRef:
    process.env.AGENT_FEEDBACK_MODE === "ask_once"
      ? (_arguments, context) => context.http?.authInfo?.extra?.accountId
      : undefined,
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
app.use("/mcp", (request, response, next) => {
  if (request.get("authorization") !== "Bearer demo-mcp-customer-token") {
    return response.status(401).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    });
  }
  request.auth = {
    token: "verified-operations-oauth",
    clientId: "operations-client",
    scopes: [],
    extra: {
      accountId: "acct_operations_demo",
      userId: "user_operations_demo",
      anonymousId: "anon_operations_demo",
      sessionId: "workflow_ops_8",
    },
  };
  next();
});
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));
app.listen(Number(process.env.PORT || 4205), "127.0.0.1");
