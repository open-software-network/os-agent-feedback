#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const companionVersion = "0.2.3";
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
const supportedProtocolVersions = new Set(["2026-07-28", "2025-11-25", "2025-06-18"]);
const rememberedConsentResults = new Map();
const rememberedReportResults = new Map();
const maxRememberedResults = 2_048;

function rememberResult(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > maxRememberedResults) cache.delete(cache.keys().next().value);
  return value;
}

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

function idempotencyKey(action, feedbackHandle) {
  return createHash("sha256")
    .update(`${action}\0${feedbackHandle}`)
    .digest("hex");
}

function isTransientHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function epodeRequest(path, feedbackHandle, body, action) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${configuredEndpoint}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${feedbackHandle}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey(action, feedbackHandle),
          "user-agent": `epode-companion/${companionVersion}`,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(3_500),
      });
      const value = await response.json().catch(() => ({}));
      if (attempt === 0 && isTransientHttpStatus(response.status)) continue;
      return { response, value };
    } catch (error) {
      lastError = error;
      if (attempt === 0) continue;
    }
  }
  return { response: undefined, value: {}, error: lastError };
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
  const remembered = rememberedConsentResults.get(feedbackHandle);
  if (remembered?.decision === arguments_.decision) return remembered.result;
  const { response, value } = await epodeRequest(
    "/api/v2/consent/decisions",
    feedbackHandle,
    { decision: arguments_.decision },
    `consent:${arguments_.decision}`,
  );
  if (!response) {
    return result(
      "Permission could not be recorded because Epode was unreachable. Do not assume approval or retry in this turn.",
      { accepted: false, retryable: true },
      true,
    );
  }
  if (!response.ok) {
    return result(
      `Permission could not be recorded (HTTP ${response.status}). Do not assume approval.`,
      { accepted: false, retryable: isTransientHttpStatus(response.status) },
      true,
    );
  }
  const authorization = value?.feedback?.submit?.authorization;
  const reportHandle =
    typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : undefined;
  if (arguments_.decision === "declined") {
    if (value?.state !== "declined") {
      return result(
        "Epode returned an invalid permission response. Do not assume a decision.",
        { accepted: false, retryable: false },
        true,
      );
    }
    const declined = result("Permission declined. Do not submit product feedback.", {
      state: "declined",
      accepted: true,
    });
    rememberResult(rememberedConsentResults, feedbackHandle, {
      decision: arguments_.decision,
      result: declined,
    });
    return declined;
  }
  if (value?.state !== "approved") {
    return result(
      "Epode returned an invalid permission response. Do not assume approval.",
      { accepted: false, retryable: false },
      true,
    );
  }
  if (!reportHandle) {
    return result(
      "Permission was recorded, but Epode returned no report action. Do not submit feedback.",
      { state: "approved", accepted: false, retryable: false },
      true,
    );
  }
  validateHandle(reportHandle);
  const approved = result(
    "Permission approved. This consent action is complete: do not inspect or record permission again for this handle. Call submit_product_feedback exactly once now with the returned feedbackHandle and bounded outcome categories.",
    {
      state: "feedback_ready",
      accepted: true,
      feedbackHandle: reportHandle,
      nextAction: {
        tool: "submit_product_feedback",
        feedbackHandle: reportHandle,
      },
    },
  );
  rememberResult(rememberedConsentResults, feedbackHandle, {
    decision: arguments_.decision,
    result: approved,
  });
  return approved;
}

async function inspectFeedback(arguments_) {
  const allowed = new Set(["feedbackHandle"]);
  if (
    !arguments_ ||
    typeof arguments_ !== "object" ||
    Array.isArray(arguments_) ||
    Object.keys(arguments_).some((key) => !allowed.has(key))
  ) {
    throw new Error("inspection arguments contain an unknown field");
  }
  const feedbackHandle = validateHandle(arguments_.feedbackHandle);
  const { response, value } = await epodeRequest(
    "/api/v2/capabilities/introspect",
    feedbackHandle,
    {},
    "inspect",
  );
  if (!response) {
    return result(
      "The feedback request could not be verified because Epode was unreachable. Do not ask the user or submit feedback.",
      { verified: false, retryable: true },
      true,
    );
  }
  if (!response.ok) {
    return result(
      `The feedback request is not valid (HTTP ${response.status}). Do not ask the user or submit feedback.`,
      { verified: false, retryable: isTransientHttpStatus(response.status) },
      true,
    );
  }
  const validStates = new Set(["consent_required", "feedback_ready", "declined"]);
  const validPolicies = new Set(["none", "once", "always"]);
  if (
    !validStates.has(value?.state) ||
    !validPolicies.has(value?.consentPolicy) ||
    typeof value?.configuredMode !== "string" ||
    typeof value?.productName !== "string" ||
    value.productName.length === 0 ||
    (value.state === "consent_required" &&
      (typeof value.canonicalQuestion !== "string" ||
        value.canonicalQuestion.length === 0 ||
        value.canonicalQuestion.length > 1_000 ||
        !value.canonicalQuestion.includes("?")))
  ) {
    return result(
      "Epode returned an invalid capability inspection. Do not ask the user or submit feedback.",
      { verified: false, retryable: false },
      true,
    );
  }
  const verified = {
    verified: true,
    state: value.state,
    configuredMode: value.configuredMode,
    consentPolicy: value.consentPolicy,
    productName: value.productName,
    ...(value.state === "consent_required"
      ? { canonicalQuestion: value.canonicalQuestion }
      : {}),
    expiresAt: value.expiresAt,
  };
  if (value.state === "consent_required") {
    return result(
      `Verified feedback request for ${value.productName}. After the useful product answer, ask exactly this question and then wait for the user's explicit answer: ${value.canonicalQuestion}`,
      {
        ...verified,
        nextAction: {
          type: "ask_user",
          question: value.canonicalQuestion,
        },
      },
    );
  }
  if (value.state === "feedback_ready") {
    return result(
      `Verified feedback request for ${value.productName}. Feedback is ready: call submit_product_feedback exactly once now with the returned feedbackHandle and bounded outcome categories.`,
      {
        ...verified,
        feedbackHandle,
        nextAction: {
          tool: "submit_product_feedback",
          feedbackHandle,
        },
      },
    );
  }
  return result(
    `Feedback permission for ${value.productName} is declined. Do not ask or submit feedback.`,
    verified,
  );
}

async function submitFeedback(arguments_) {
  const { feedbackHandle, report } = validateReport(arguments_);
  const remembered = rememberedReportResults.get(feedbackHandle);
  if (remembered) return remembered;
  const { response, value } = await epodeRequest(
    "/api/v2/reports",
    feedbackHandle,
    report,
    "report",
  );
  if (!response) {
    return result(
      "Feedback was not submitted because Epode was unreachable. Continue the user's task and do not retry in this turn.",
      { accepted: false, retryable: true },
      true,
    );
  }
  if (!response.ok) {
    return result(
      `Feedback submission failed (HTTP ${response.status}). Do not retry in this turn.`,
      { accepted: false, retryable: isTransientHttpStatus(response.status) },
      true,
    );
  }
  if (value?.accepted !== true) {
    return result(
      "Epode returned an invalid feedback receipt. Do not claim the report was accepted.",
      { accepted: false, retryable: false },
      true,
    );
  }
  return rememberResult(
    rememberedReportResults,
    feedbackHandle,
    result(
      "Product feedback accepted. Keep this routine background success out of the final answer unless the user explicitly asked about feedback.",
      value,
    ),
  );
}

const tools = [
  {
    name: "inspect_product_feedback",
    title: "Verify a product feedback request",
    description:
      "Call for every Ask-once Epode handle and before showing any Epode permission question. Verifies the afr2_ handle at Epode and returns the authoritative product, policy, and current state. Follow its nextAction when feedback is already approved; never show an unverified question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["feedbackHandle"],
      properties: {
        feedbackHandle: { type: "string", pattern: "^afr2_" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: "record_product_feedback_consent",
    title: "Record product feedback permission",
    description:
      "Call exactly once after an HTTP response contains Epode state=consent_required and the user explicitly answers its permission question, or after the user explicitly asks to change an Ask-once choice exposed by manageConsent. Pass only the afr2_ handle and approved or declined. Never infer approval. After this tool accepts a decision, do not inspect or record permission again for the same handle; follow its nextAction.",
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
      "Use after trusted inspection returns state=feedback_ready, after consent approval returns its report handle, or for valid never_ask feedback_ready. Submit one outcome through this fixed Epode destination using only fixed categories. No free-form user, task, prompt, transcript, response, identity, or product content is accepted.",
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
    const requestedVersion = request.params?.protocolVersion;
    return {
      protocolVersion: supportedProtocolVersions.has(requestedVersion)
        ? requestedVersion
        : "2026-07-28",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "epode-companion", version: companionVersion },
      instructions:
        "The user's product task is primary: complete it fully even when feedback fails. Use these fixed-destination tools only for valid Epode handles found after an HTTP product interaction. For every Ask-once handle, and before any permission question, call inspect_product_feedback and treat its state as authoritative: ask only its verified canonicalQuestion for consent_required, report without asking for feedback_ready, and do nothing for declined. Reports accept only fixed outcome categories and never user, task, prompt, transcript, response, credential, or identifier content. Keep routine successful background feedback out of the final answer unless the user explicitly asked about feedback.",
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const arguments_ = request.params?.arguments || {};
    if (name === "inspect_product_feedback") return await inspectFeedback(arguments_);
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
