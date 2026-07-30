#!/usr/bin/env node

import { createInterface } from "node:readline";

const productionEndpoint = "https://app.epode.ai";
const configuredEndpoint = (process.env.EPODE_COMPANION_ENDPOINT || productionEndpoint).replace(
  /\/$/,
  "",
);
const endpointUrl = new URL(configuredEndpoint);
if (configuredEndpoint !== productionEndpoint) {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpointUrl.hostname);
  if (process.env.EPODE_COMPANION_ALLOW_TEST_ENDPOINT !== "1" || !loopback) {
    throw new Error("Epode Companion endpoint overrides are restricted to explicit loopback tests");
  }
}

const handlePattern = /^afr2_[A-Za-z0-9._-]{40,2048}$/;
const outcomeReports = {
  completed: {
    summary: "The product completed the requested outcome.",
    impact: "helped",
  },
  completed_with_friction: {
    summary: "The product completed the requested outcome with friction.",
    impact: "helped_with_friction",
  },
  partial: {
    summary: "The product partially completed the requested outcome.",
    impact: "helped_with_friction",
  },
  not_completed: {
    summary: "The product did not complete the requested outcome.",
    impact: "blocked",
  },
  uncertain: {
    summary: "It was unclear whether the product completed the requested outcome.",
    impact: "unknown",
  },
};
const signalFindings = {
  accurate: ["strength", "accuracy", "minor", "The result was accurate for the requested outcome."],
  relevant: ["strength", "relevance", "minor", "The result was relevant to the requested outcome."],
  fast: ["strength", "latency", "minor", "The product responded quickly."],
  clear: ["strength", "clarity", "minor", "The result was clear to use."],
  complete: ["strength", "completeness", "minor", "The result was complete for the requested outcome."],
  easy_to_use: ["strength", "usability", "minor", "The product was easy to use."],
  slow: ["friction", "latency", "minor", "The product responded slowly."],
  incomplete: ["gap", "completeness", "major", "The result was incomplete for the requested outcome."],
  incorrect: ["defect", "accuracy", "major", "The result was incorrect for the requested outcome."],
  hard_to_use: ["friction", "usability", "major", "The product was difficult to use."],
  authentication_friction: ["friction", "authentication", "major", "Authentication created friction."],
  documentation_gap: ["gap", "documentation", "major", "The documentation did not cover the needed behavior."],
  missing_capability: ["gap", "capability", "major", "A needed capability was unavailable."],
  unexpected_output: ["defect", "response_shape", "major", "The product returned an unexpected result shape."],
  unavailable: ["defect", "availability", "blocking", "The product was unavailable."],
};
const outcomes = Object.keys(outcomeReports);
const signals = Object.keys(signalFindings);

function result(text, structuredContent = {}, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function validateHandle(value) {
  if (typeof value !== "string" || !handlePattern.test(value)) {
    throw new Error("feedbackHandle must be a short-lived afr2_ Epode capability");
  }
  return value;
}

function validateReport(arguments_) {
  const allowed = new Set([
    "feedbackHandle",
    "outcome",
    "confidence",
    "signals",
    "workaroundUsed",
  ]);
  if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) {
    throw new Error("report arguments must be an object");
  }
  if (Object.keys(arguments_).some((key) => !allowed.has(key))) {
    throw new Error("report contains an unknown field");
  }
  const feedbackHandle = validateHandle(arguments_.feedbackHandle);
  if (!outcomes.includes(arguments_.outcome)) {
    throw new Error("outcome is invalid");
  }
  if (
    arguments_.confidence !== undefined &&
    (typeof arguments_.confidence !== "number" ||
      arguments_.confidence < 0 ||
      arguments_.confidence > 1)
  ) {
    throw new Error("confidence must be between 0 and 1");
  }
  if (arguments_.signals !== undefined) {
    if (
      !Array.isArray(arguments_.signals) ||
      arguments_.signals.length > 8 ||
      new Set(arguments_.signals).size !== arguments_.signals.length ||
      arguments_.signals.some((signal) => !signals.includes(signal))
    ) {
      throw new Error("signals must contain at most 8 unique supported values");
    }
  }
  if (arguments_.workaroundUsed !== undefined && typeof arguments_.workaroundUsed !== "boolean") {
    throw new Error("workaroundUsed must be a boolean");
  }
  const { outcome, confidence, workaroundUsed } = arguments_;
  const findings = (arguments_.signals || []).map((signal) => {
    const [kind, topic, severity, detail] = signalFindings[signal];
    return { kind, topic, severity, detail };
  });
  return {
    feedbackHandle,
    report: {
      ...outcomeReports[outcome],
      ...(confidence === undefined ? {} : { confidence }),
      ...(findings.length === 0 ? {} : { findings }),
      ...(workaroundUsed === undefined
        ? {}
        : {
            workaround: {
              used: workaroundUsed,
              ...(workaroundUsed
                ? { detail: "The requested outcome required a workaround." }
                : {}),
            },
          }),
    },
  };
}

async function epodeRequest(path, feedbackHandle, body) {
  const response = await fetch(`${configuredEndpoint}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${feedbackHandle}`,
      "content-type": "application/json",
      "user-agent": "epode-companion/0.1.0",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json().catch(() => ({}));
  return { response, value };
}

async function recordConsent(arguments_) {
  const allowed = new Set(["feedbackHandle", "decision"]);
  if (
    !arguments_ ||
    typeof arguments_ !== "object" ||
    Array.isArray(arguments_) ||
    Object.keys(arguments_).some((key) => !allowed.has(key))
  ) {
    throw new Error("consent arguments contain an unknown field");
  }
  const feedbackHandle = validateHandle(arguments_.feedbackHandle);
  if (!["approved", "declined"].includes(arguments_.decision)) {
    throw new Error("decision must be approved or declined");
  }
  const { response, value } = await epodeRequest(
    "/api/v2/consent/decisions",
    feedbackHandle,
    { decision: arguments_.decision },
  );
  if (!response.ok) {
    return result(
      `Permission could not be recorded (HTTP ${response.status}). Do not assume approval.`,
      { accepted: false, retryable: response.status >= 500 },
      true,
    );
  }
  const authorization = value?.feedback?.submit?.authorization;
  const reportHandle =
    typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : undefined;
  if (arguments_.decision === "declined") {
    return result("Permission declined. Do not submit product feedback.", {
      state: "declined",
      accepted: true,
    });
  }
  if (!reportHandle) {
    return result(
      "Permission was recorded, but Epode returned no report action. Do not submit feedback.",
      { state: "approved", accepted: false, retryable: false },
      true,
    );
  }
  validateHandle(reportHandle);
  return result(
    "Permission approved. Submit one bounded product report using the returned feedbackHandle.",
    { state: "approved", accepted: true, feedbackHandle: reportHandle },
  );
}

async function submitFeedback(arguments_) {
  const { feedbackHandle, report } = validateReport(arguments_);
  const { response, value } = await epodeRequest("/api/v2/reports", feedbackHandle, report);
  if (!response.ok) {
    return result(
      `Feedback submission failed (HTTP ${response.status}). ${
        response.status >= 500
          ? "Retry once."
          : "Do not retry unless Epode returns a new valid feedbackHandle."
      }`,
      { accepted: false, retryable: response.status >= 500 },
      true,
    );
  }
  return result("Product feedback accepted.", value);
}

const tools = [
  {
    name: "record_product_feedback_consent",
    title: "Record product feedback permission",
    description:
      "Record only the user's explicit approved or declined decision for an Epode feedbackHandle. Never infer approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["feedbackHandle", "decision"],
      properties: {
        feedbackHandle: { type: "string", pattern: "^afr2_" },
        decision: { type: "string", enum: ["approved", "declined"] },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "submit_product_feedback",
    title: "Submit bounded product feedback",
    description:
      "Submit one product outcome using only fixed categories after permission is resolved. No free-form user, task, or product content is accepted.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["feedbackHandle", "outcome"],
      properties: {
        feedbackHandle: { type: "string", pattern: "^afr2_" },
        outcome: { type: "string", enum: outcomes },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        signals: {
          type: "array",
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", enum: signals },
        },
        workaroundUsed: { type: "boolean" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

async function handle(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion || "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "epode-companion", version: "0.1.0" },
      instructions:
        "Use these fixed-destination tools only for Epode feedback handles found after a completed HTTP product interaction. Ask whenever permission is required. Reports accept only fixed outcome categories and never user or task content.",
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const arguments_ = request.params?.arguments || {};
    if (name === "record_product_feedback_consent") return await recordConsent(arguments_);
    if (name === "submit_product_feedback") return await submitFeedback(arguments_);
    return result("Unknown Epode Companion tool.", { accepted: false }, true);
  }
  throw new Error(`Unsupported MCP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
    if (request.id === undefined) continue;
    const response = await handle(request);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: response })}\n`);
  } catch (error) {
    if (request?.id === undefined) continue;
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: error instanceof Error ? error.message : "Invalid request" },
      })}\n`,
    );
  }
}
