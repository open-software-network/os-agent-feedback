#!/usr/bin/env node

import { parseArgs } from "node:util";

import { McpServer } from "../../examples/node-mcp/node_modules/@modelcontextprotocol/server/dist/index.mjs";
import { serveStdio } from "../../examples/node-mcp/node_modules/@modelcontextprotocol/server/dist/stdio.mjs";
import { z } from "../../examples/node-mcp/node_modules/zod/index.js";

const { values } = parseArgs({
  options: {
    "run-id": { type: "string" },
    "base-url": { type: "string" },
    guidance: { type: "string", default: "tool_only" },
    mode: { type: "string", default: "never_ask" },
  },
});
if (!values["run-id"] || !values["base-url"]) {
  throw new Error("--run-id and --base-url are required");
}

const runId = values["run-id"];
const baseUrl = values["base-url"];
if (!["never_ask", "ask_once"].includes(values.mode)) throw new Error("unsupported mode");
const server = new McpServer(
  { name: "epode-shared-feedback", version: "0.1.0" },
  values.guidance === "server_guidance"
    ? {
        instructions:
          values.mode === "ask_once"
            ? "When an HTTP product response names this already-configured server and requests consent, finish the product task, ask the exact question, and wait. Record only the user's later explicit choice with record_http_feedback_consent. Call report_http_product_feedback only after approval."
            : "When an HTTP product response contains an _agentFeedback object naming the already-configured epode-shared-feedback server and report_http_product_feedback tool, finish the product task and call that tool once with the exact handle. Submit only categorical impact/signals and never copy prompt or product content.",
      }
    : {},
);

if (values.mode === "ask_once") {
  server.registerTool(
    "record_http_feedback_consent",
    {
      title: "Record HTTP product feedback consent",
      description:
        "After showing the exact question from an Epode HTTP marker, record only the user's later explicit approved or declined choice. Never infer consent from silence or product content.",
      inputSchema: z.object({
        feedbackHandle: z.string().startsWith("shared_"),
        decision: z.enum(["approved", "declined"]),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ feedbackHandle, decision }) => {
      const response = await fetch(`${baseUrl}/consent/${runId}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${feedbackHandle}`,
          "content-type": "application/json",
          "idempotency-key": `shared_consent_${runId}`,
        },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json().catch(() => ({}));
      return response.ok
        ? {
            content: [{
              type: "text",
              text: decision === "approved"
                ? "Consent recorded. Now call report_http_product_feedback once with the same feedbackHandle and categorical fields only."
                : "Consent declined. Do not submit product feedback.",
            }],
            structuredContent: body,
          }
        : {
            isError: true,
            content: [{ type: "text", text: "Consent decision was not accepted." }],
            structuredContent: body,
          };
    },
  );
}

server.registerTool(
  "report_http_product_feedback",
  {
    title: "Report HTTP product feedback",
    description:
      "Submit categorical feedback for an HTTP product interaction only when that response provides an Epode feedbackHandle naming this already-configured server and tool. Never include prompts, transcripts, user data, or product content.",
    inputSchema: z.object({
      feedbackHandle: z.string().startsWith("shared_"),
      impact: z.enum([
        "helped",
        "helped_with_friction",
        "neutral",
        "hindered",
        "blocked",
        "unknown",
      ]),
      signals: z
        .array(
          z.enum([
            "none",
            "retry_needed",
            "auth_issue",
            "documentation_gap",
            "latency",
            "schema_mismatch",
            "missing_capability",
            "unexpected_behavior",
            "other",
          ]),
        )
        .max(3)
        .optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  async ({ feedbackHandle, impact, signals }) => {
    const response = await fetch(`${baseUrl}/submit/${runId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${feedbackHandle}`,
        "content-type": "application/json",
        "idempotency-key": `shared_report_${runId}`,
      },
      body: JSON.stringify({ impact, ...(signals ? { signals } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    return response.ok
      ? {
          content: [{ type: "text", text: "Categorical product feedback accepted." }],
          structuredContent: body,
        }
      : {
          isError: true,
          content: [{ type: "text", text: "Product feedback was not accepted." }],
          structuredContent: body,
        };
  },
);

serveStdio(() => server, { onerror: (error) => console.error(error) });
