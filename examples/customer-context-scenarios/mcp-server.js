import { pathToFileURL } from "node:url";

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

import {
  SHOPWISE_TOOLS,
  ShopwiseMcpError,
  ShopwiseMcpExample,
} from "./shopwise-mcp.js";

const searchTool = SHOPWISE_TOOLS.find((tool) => tool.name === "search_catalog");
if (!searchTool) throw new Error("Shopwise search_catalog contract is missing");

const requestHeader = (requestInfo, name) => {
  const value = requestInfo?.headers?.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

/**
 * Build one independent, stateless Shopwise MCP server. The caller's bounded
 * shopperContext lives only inside the search_catalog invocation.
 */
export function createShopwiseProductServer({ requestInfo } = {}) {
  const product = new ShopwiseMcpExample();
  const server = new McpServer(
    { name: "shopwise-ecommerce", version: "1.0.0" },
    {
      instructions:
        "Call search_catalog once with only the shopping facts needed for the current task. The returned receipt says exactly what was received and applied. Shopwise does not save this context or import assistant memory.",
    },
  );

  server.registerTool(
    searchTool.name,
    {
      title: searchTool.title,
      description: searchTool.description,
      inputSchema: fromJsonSchema(searchTool.inputSchema),
      annotations: searchTool.annotations,
    },
    async (arguments_, context) => {
      const sessionId =
        requestHeader(requestInfo, "x-shopwise-session-id") || `mcp-request-${context.mcpReq.id}`;
      const incognito = requestHeader(requestInfo, "x-shopwise-incognito") === "true";
      try {
        return product.callTool(searchTool.name, arguments_, { sessionId, incognito });
      } catch (error) {
        if (!(error instanceof ShopwiseMcpError)) throw error;
        return {
          isError: true,
          content: [{ type: "text", text: `${error.code}: ${error.message}` }],
          structuredContent: { error: { code: error.code, message: error.message } },
        };
      }
    },
  );

  return server;
}

/** Create the production-shaped HTTP surface without binding a port. */
export function createShopwiseMcpApp({ host = "0.0.0.0" } = {}) {
  const app = createMcpExpressApp({ host, allowedOrigins: [] });
  const mcp = createMcpHandler(createShopwiseProductServer, {
    legacy: "stateless",
    responseMode: "json",
    cacheHints: {
      "server/discover": { ttlMs: 60_000, cacheScope: "public" },
      "tools/list": { ttlMs: 60_000, cacheScope: "public" },
    },
  });
  const handleMcp = toNodeHandler(mcp);

  app.get("/", (_request, response) =>
    response.type("text/plain").send("Connect an MCP client to POST /mcp."),
  );
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.all("/mcp", (request, response) => handleMcp(request, response, request.body));

  return { app, mcp };
}

/** Start the example as an ordinary HTTP MCP service. */
export function startShopwiseMcpServer({
  port = Number(process.env.PORT || 4310),
  host = process.env.HOST || "0.0.0.0",
} = {}) {
  const { app, mcp } = createShopwiseMcpApp({ host });
  const server = app.listen(port, host);
  const close = async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await mcp.close();
  };
  return { server, close };
}

const entryPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPath === import.meta.url) {
  const running = startShopwiseMcpServer();
  const shutdown = () => void running.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
