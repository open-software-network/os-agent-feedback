import {
  createMcpInstrumentation,
  type McpInstrumentationContext,
} from "../dist/mcp.js";
import { McpServer } from "@modelcontextprotocol/server";

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function authenticatedAccountId(context: McpInstrumentationContext): string | undefined {
  const accountId = context.http?.authInfo?.extra?.accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

const feedback = createMcpInstrumentation({
  apiKey: "af_live_2123456789abcdef0123456789abcdef_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
  customerRef: (_arguments, context) => authenticatedAccountId(context),
  sessionRef: (arguments_, _context, result) =>
    stringField(arguments_, "runId") ?? stringField(result?.structuredContent, "runId"),
});

const server = new McpServer({ name: "type-fixture", version: "1.0.0" });
feedback.instrument(server);
