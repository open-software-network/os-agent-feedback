import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { FeedbackEnvelope } from "./core.js";

export type FeedbackImpact =
  | "helped"
  | "helped_with_friction"
  | "neutral"
  | "hindered"
  | "blocked"
  | "unknown";
export type FeedbackFindingKind =
  | "strength"
  | "friction"
  | "defect"
  | "gap"
  | "suggestion"
  | "uncertainty"
  | "other";
export type FeedbackSeverity = "minor" | "major" | "blocking";

export interface FeedbackFinding {
  kind: FeedbackFindingKind;
  topic: string;
  severity?: FeedbackSeverity;
  detail: string;
}

export interface FeedbackWorkaround {
  used: boolean;
  detail?: string;
}

export interface ProductFeedbackReport {
  summary: string;
  impact?: FeedbackImpact;
  confidence?: number;
  findings?: FeedbackFinding[];
  workaround?: FeedbackWorkaround;
}

export interface SubmitProductFeedbackOptions {
  /**
   * Origins this agent runtime trusts to receive scoped feedback receipts.
   * The hosted Agent Feedback service is trusted by default.
   */
  allowedSubmitOrigins?: string[];
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProductFeedbackSubmission {
  accepted: boolean;
  interactionId?: string;
  report?: {
    id?: string;
    summary?: string;
    impact?: FeedbackImpact;
    confidence?: number;
    findings?: FeedbackFinding[];
    workaround?: FeedbackWorkaround;
  };
  [key: string]: unknown;
}

const DEFAULT_SUBMIT_ORIGIN = "https://app.epode.ai";

/** A report transport failure after the product answer is safe to retry once. */
export class FeedbackSubmissionError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "FeedbackSubmissionError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

function retryableReportStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function reportIdempotencyKey(authorization: string): string {
  // The receipt binds one interaction, so this key intentionally remains the
  // same across the single bounded retry without exposing the capability.
  return createHash("sha256").update(`agent-feedback-report\0${authorization}`).digest("hex");
}

export type FeedbackConsentAction = "submit" | "ask" | "skip";

/**
 * Resolves the action described by Epode's server-managed response contract.
 */
export function feedbackConsentAction(feedback: FeedbackEnvelope): FeedbackConsentAction {
  if (!parseEnvelope(feedback)) return "skip";
  if (feedback.state === "feedback_ready") return "submit";
  if (feedback.state === "consent_required") return "ask";
  return "skip";
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validConsentContract(value: Record<string, unknown>): boolean {
  if (value.state === "feedback_ready") {
    return (
      value.mode === "never_ask" &&
      value.consentRequired === false &&
      value.consentPolicy === "none" &&
      value.when === "after_experience_known_before_final_response" &&
      object(value.submit) &&
      value.requiredAction === undefined
    );
  }
  if (value.state === "consent_required") {
    const modeContract =
      (value.mode === "ask_once" &&
        value.configuredMode === "ask_once" &&
        value.consentPolicy === "once" &&
        value.when === "after_experience_known_and_consent_resolved") ||
      (value.mode === "ask_always" &&
        (value.configuredMode === "ask_always" || value.configuredMode === "ask_once") &&
        value.consentPolicy === "always" &&
        value.when === "after_experience_known_and_explicit_user_approval");
    return (
      modeContract &&
      value.consentRequired === true &&
      value.consentManagedBy === "epode" &&
      object(value.requiredAction) &&
      value.submit === undefined
    );
  }
  return false;
}

function parseEnvelope(value: unknown): FeedbackEnvelope | undefined {
  if (!object(value) || value.v !== 1) return undefined;
  if (value.requested !== true || !validConsentContract(value)) {
    return undefined;
  }
  if (value.state === "feedback_ready") {
    const submit = value.submit as Record<string, unknown>;
    if (
      submit.method !== "POST" ||
      typeof submit.url !== "string" ||
      submit.url.length === 0 ||
      typeof submit.authorization !== "string" ||
      !submit.authorization.startsWith("Bearer afr2_") ||
      submit.contentType !== "application/json"
    ) {
      return undefined;
    }
  } else {
    const requiredAction = value.requiredAction as Record<string, unknown>;
    const action = requiredAction.submitDecision;
    const bodySchema = object(action) ? action.bodySchema : undefined;
    if (
      requiredAction.type !== "ask_user" ||
      typeof requiredAction.question !== "string" ||
      requiredAction.question.length === 0 ||
      !object(action) ||
      action.method !== "POST" ||
      typeof action.url !== "string" ||
      typeof action.authorization !== "string" ||
      !action.authorization.startsWith("Bearer afr2_") ||
      action.contentType !== "application/json" ||
      !object(bodySchema) ||
      Object.keys(bodySchema).length !== 1 ||
      !Array.isArray(bodySchema.decision) ||
      bodySchema.decision.length !== 2 ||
      bodySchema.decision[0] !== "approved" ||
      bodySchema.decision[1] !== "declined"
    ) {
      return undefined;
    }
  }
  return value as unknown as FeedbackEnvelope;
}

export async function submitFeedbackConsent(
  feedback: FeedbackEnvelope,
  decision: "approved" | "declined",
  options: SubmitProductFeedbackOptions = {},
): Promise<{ state: "approved" | "declined"; feedback?: FeedbackEnvelope }> {
  const parsed = parseEnvelope(feedback);
  const action = parsed?.requiredAction?.submitDecision;
  if (!parsed || parsed.state !== "consent_required" || !action) {
    throw new Error("Invalid Agent Feedback consent contract");
  }
  const url = new URL(action.url);
  if (url.protocol !== "https:") throw new Error("Agent Feedback decisions require HTTPS");
  const allowedOrigins = new Set(
    (options.allowedSubmitOrigins || [DEFAULT_SUBMIT_ORIGIN]).map((value) => new URL(value).origin),
  );
  if (!allowedOrigins.has(url.origin)) {
    throw new Error(`Refusing to submit a consent decision to untrusted origin ${url.origin}`);
  }
  const response = await (options.fetch || globalThis.fetch)(url, {
    method: "POST",
    headers: {
      authorization: action.authorization,
      "content-type": action.contentType,
      "user-agent": "@agent-feedback/node-agent/0.2.0",
    },
    body: JSON.stringify({ decision }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    state?: unknown;
    feedback?: unknown;
  };
  if (!response.ok || (body.state !== "approved" && body.state !== "declined")) {
    throw new Error(`Consent decision failed with HTTP ${response.status}`);
  }
  return {
    state: body.state,
    ...(parseEnvelope(body.feedback) ? { feedback: parseEnvelope(body.feedback) } : {}),
  };
}

function envelopeFromHtml(html: string): FeedbackEnvelope | undefined {
  const match = /<script[^>]+id=["']agent-feedback["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return undefined;
  try {
    return parseEnvelope(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
}

/**
 * Read Agent Feedback metadata from a response without executing it.
 *
 * Pass the response body after parsing it as JSON or reading it as text. This
 * supports JSON object metadata, HTML metadata, and the header fallback used
 * for arrays and scalar responses.
 */
export function feedbackFromResponse(
  response: Pick<Response, "headers">,
  body: unknown,
): FeedbackEnvelope | undefined {
  // Header metadata is the explicit fallback for arrays, scalar JSON, and
  // HTML documents that already own the marker id. Prefer it when present so
  // a product-owned HTML tag cannot shadow the scoped receipt.
  const encoded = response.headers.get("agent-feedback");
  if (encoded) {
    try {
      const headerEnvelope = parseEnvelope(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
      if (headerEnvelope) return headerEnvelope;
    } catch {
      // Fall back to an embedded contract when a malformed header is present.
    }
  }
  if (object(body)) {
    const embedded = parseEnvelope(body._agentFeedback);
    if (embedded) return embedded;
  }
  if (typeof body === "string") {
    const embedded = envelopeFromHtml(body);
    if (embedded) return embedded;
  }
  return undefined;
}

/**
 * Deterministically submit a structured report from a feedback-aware agent
 * runtime. Generic agents may ignore response metadata; this explicit adapter
 * is the reliable HTTP/HTML path.
 */
export async function submitProductFeedback(
  feedback: FeedbackEnvelope,
  report: ProductFeedbackReport,
  options: SubmitProductFeedbackOptions = {},
): Promise<ProductFeedbackSubmission> {
  const parsed = parseEnvelope(feedback);
  if (!parsed?.submit || parsed.state !== "feedback_ready")
    throw new Error("Invalid Agent Feedback submission contract");
  const summary = report.summary.trim();
  if (summary.length < 8 || summary.length > 700)
    throw new Error("summary must contain 8 to 700 characters");
  if (
    report.impact &&
    !["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"].includes(
      report.impact,
    )
  )
    throw new Error("invalid impact");
  if (report.confidence !== undefined && (report.confidence < 0 || report.confidence > 1))
    throw new Error("confidence must be between 0 and 1");
  if ((report.findings?.length || 0) > 8)
    throw new Error("findings cannot contain more than 8 items");
  for (const finding of report.findings || []) {
    if (
      !["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"].includes(
        finding.kind,
      )
    )
      throw new Error("invalid finding kind");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(finding.topic))
      throw new Error("finding topic must be a normalized slug");
    if (finding.severity && !["minor", "major", "blocking"].includes(finding.severity))
      throw new Error("invalid finding severity");
    const detail = finding.detail.trim();
    if (detail.length < 3 || detail.length > 350)
      throw new Error("finding detail must contain 3 to 350 characters");
  }
  if (report.workaround?.used && !report.workaround.detail?.trim())
    throw new Error("workaround detail is required when a workaround was used");

  const submitUrl = new URL(parsed.submit.url);
  if (submitUrl.protocol !== "https:") {
    throw new Error("Agent Feedback submissions require HTTPS");
  }
  const allowedOrigins = new Set(
    (options.allowedSubmitOrigins || [DEFAULT_SUBMIT_ORIGIN]).map((value) => new URL(value).origin),
  );
  if (!allowedOrigins.has(submitUrl.origin)) {
    throw new Error(`Refusing to submit feedback to untrusted origin ${submitUrl.origin}`);
  }

  const requestBody = JSON.stringify({
    summary,
    ...(report.impact ? { impact: report.impact } : {}),
    ...(report.confidence !== undefined ? { confidence: report.confidence } : {}),
    ...(report.findings ? { findings: report.findings } : {}),
    ...(report.workaround ? { workaround: report.workaround } : {}),
  });
  const idempotencyKey = reportIdempotencyKey(parsed.submit.authorization);
  const fetchImplementation = options.fetch || globalThis.fetch;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImplementation(submitUrl, {
        method: "POST",
        headers: {
          authorization: parsed.submit.authorization,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "user-agent": "@agent-feedback/node-agent/0.2.0",
        },
        body: requestBody,
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
    } catch {
      if (attempt === 0) continue;
      throw new FeedbackSubmissionError(
        "Feedback submission could not reach Epode after one retry.",
        { retryable: true },
      );
    }
    const body = (await response.json().catch(() => ({}))) as ProductFeedbackSubmission;
    if (!response.ok) {
      const retryable = retryableReportStatus(response.status);
      if (attempt === 0 && retryable) continue;
      throw new FeedbackSubmissionError(
        `Feedback submission failed with HTTP ${response.status}${retryable ? " after one retry" : ""}.`,
        { retryable, status: response.status },
      );
    }
    if (body.accepted !== true) {
      throw new FeedbackSubmissionError("Epode returned an invalid feedback receipt.", {
        retryable: false,
        status: response.status,
      });
    }
    return body;
  }
  throw new FeedbackSubmissionError("Feedback submission could not reach Epode after one retry.", {
    retryable: true,
  });
}
