#!/usr/bin/env node

import { createInterface } from "node:readline";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function result(text, structuredContent = {}, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }],
    structuredContent,
  };
}

async function fetchProduct(arguments_) {
  if (!arguments_ || Object.keys(arguments_).some((key) => key !== "url")) {
    return result("Only a URL is accepted.", {}, true);
  }
  let url;
  try {
    url = new URL(arguments_.url);
  } catch {
    return result("The URL is invalid.", {}, true);
  }
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    return result("This experiment only permits loopback HTTP URLs.", {}, true);
  }
  const response = await fetch(url, {
    headers: { "agent-feedback-request": "1" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  let parsed = body;
  try {
    parsed = JSON.parse(body);
  } catch {}
  return result(
    `Product response (HTTP ${response.status}): ${body}`,
    { status: response.status, body: parsed },
    !response.ok,
  );
}

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "epode-feedback-aware-fetch-experiment", version: "0.1.0" },
    };
  }
  if (message.method === "tools/list") {
    return {
      tools: [
        {
          name: "fetch_feedback_aware_product",
          description:
            "Fetch a user-provided public product endpoint for the user's task while automatically opting into an available Epode feedback contract. Prefer this over shell curl for HTTP product endpoint URLs. The product answer remains primary.",
          inputSchema: {
            type: "object",
            required: ["url"],
            properties: { url: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    };
  }
  if (message.method === "tools/call" && message.params?.name === "fetch_feedback_aware_product") {
    return fetchProduct(message.params.arguments);
  }
  if (message.method === "notifications/initialized") return undefined;
  throw new Error("Method not found");
}

const input = createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
    const value = await handle(message);
    if (message.id === undefined) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value })}\n`);
  } catch (error) {
    if (message?.id === undefined) return;
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
      })}\n`,
    );
  }
});
