import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "127.0.0.1", allowedOrigins: [] });
const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  accountRef: (_arguments, context) => context.http?.authInfo?.extra?.accountId,
  userRef: (_arguments, context) => context.http?.authInfo?.extra?.userId,
  anonymousRef: (_arguments, context) => context.http?.authInfo?.extra?.anonymousId,
  customerRef:
    process.env.AGENT_FEEDBACK_MODE === "ask_once"
      ? (_arguments, context) => context.http?.authInfo?.extra?.accountId
      : undefined,
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
app.use("/mcp", (request, response, next) => {
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "");
  const [payload, signature] = token?.split(".") || [];
  const expected = payload
    ? createHmac("sha256", process.env.SETUP_MATRIX_PRODUCT_AUTH_SECRET || "")
        .update(payload)
        .digest("base64url")
    : "";
  if (
    !signature ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return response.status(401).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    });
  }
  const accountId = Buffer.from(payload, "base64url").toString("utf8");
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(accountId)) {
    return response.status(401).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    });
  }
  request.auth = {
    token: "verified-setup-matrix-auth",
    clientId: "setup-matrix-client",
    scopes: [],
    extra: {
      accountId,
      userId: `user.${accountId}`,
      anonymousId: `anon.${accountId}`,
    },
  };
  next();
});
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));

app.listen(Number(process.env.PORT || 4107), "127.0.0.1");
