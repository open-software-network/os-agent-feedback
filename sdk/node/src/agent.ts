import { Buffer } from "node:buffer";

import type { FeedbackEnvelope } from "./core.js";

export type FeedbackImpact = "helped" | "helped_with_friction" | "neutral" | "hindered" | "blocked" | "unknown";
export type FeedbackFindingKind = "strength" | "friction" | "defect" | "gap" | "suggestion" | "uncertainty" | "other";
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
  sessionLabel?: string;
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
  /** Required when the response contract has consentRequired: true. */
  userApproved?: boolean;
  /** Ask-once accepts a stored grant; ask-every-time requires granted_now. */
  approvalSource?: "granted_now" | "stored_grant";
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProductFeedbackSubmission {
  accepted: boolean;
  interactionId?: string;
  report?: {
    id?: string;
    summary?: string;
    sessionLabel?: string;
    impact?: FeedbackImpact;
    confidence?: number;
    findings?: FeedbackFinding[];
    workaround?: FeedbackWorkaround;
  };
  [key: string]: unknown;
}

const DEFAULT_SUBMIT_ORIGIN =
  "https://app.epode.ai";

export type StoredFeedbackConsent = "approved" | "refused";
export type FeedbackConsentAction = "submit" | "ask" | "skip";

/**
 * Resolves an agent-runtime consent preference without exposing the preference store to Epode.
 * Persist `stored` under feedback.consentScope in the agent's own preference store.
 */
export function feedbackConsentAction(
  feedback: FeedbackEnvelope,
  stored?: StoredFeedbackConsent,
): FeedbackConsentAction {
  if (!parseEnvelope(feedback)) return "skip";
  if (!feedback.consentRequired) return "submit";
  if (feedback.mode === "ask_always") return "ask";
  if (feedback.mode === "ask_once") {
    if (stored === "approved") return "submit";
    if (stored === "refused") return "skip";
  }
  return "ask";
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validConsentContract(value: Record<string, unknown>): boolean {
  const scope = value.consentScope;
  const validScope =
    typeof scope === "string" && /^afcs1_[0-9a-f]{32}$/.test(scope);
  if (value.mode === "never_ask") {
    return value.consentRequired === false &&
      value.consentPolicy === "none" &&
      value.when === "after_experience_known_before_final_response" &&
      scope === undefined;
  }
  if (value.mode === "ask_once") {
    return value.consentRequired === true &&
      value.consentPolicy === "once" &&
      value.when === "after_experience_known_and_consent_resolved" &&
      validScope;
  }
  if (value.mode === "ask_always") {
    return value.consentRequired === true &&
      value.consentPolicy === "always" &&
      value.when === "after_experience_known_and_explicit_user_approval" &&
      scope === undefined;
  }
  return false;
}

function parseEnvelope(value: unknown): FeedbackEnvelope | undefined {
  if (!object(value) || value.v !== 1 || !object(value.submit)) return undefined;
  if (
    value.requested !== true ||
    !validConsentContract(value) ||
    value.submit.method !== "POST" ||
    typeof value.submit.url !== "string" ||
    typeof value.submit.authorization !== "string" ||
    !value.submit.authorization.startsWith("Bearer afr2_") ||
    value.submit.contentType !== "application/json"
  ) {
    return undefined;
  }
  return value as unknown as FeedbackEnvelope;
}

function envelopeFromHtml(html: string): FeedbackEnvelope | undefined {
  const match =
    /<script[^>]+id=["']agent-feedback["'][^>]*>([\s\S]*?)<\/script>/i.exec(
      html,
    );
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
  if (object(body)) {
    const embedded = parseEnvelope(body._agentFeedback);
    if (embedded) return embedded;
  }
  if (typeof body === "string") {
    const embedded = envelopeFromHtml(body);
    if (embedded) return embedded;
  }
  const encoded = response.headers.get("agent-feedback");
  if (!encoded) return undefined;
  try {
    return parseEnvelope(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
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
  if (!parsed) throw new Error("Invalid Agent Feedback submission contract");
  if (parsed.consentRequired && options.userApproved !== true) {
    throw new Error("Explicit user approval is required before submitting this report");
  }
  if (
    parsed.mode === "ask_once" &&
    !["granted_now", "stored_grant"].includes(options.approvalSource || "")
  ) {
    throw new Error("Ask-once submission requires granted_now or stored_grant approval");
  }
  if (parsed.mode === "ask_always" && options.approvalSource !== "granted_now") {
    throw new Error("Ask-every-time submission requires fresh approval");
  }
  const summary = report.summary.trim();
  if (summary.length < 8 || summary.length > 700) throw new Error("summary must contain 8 to 700 characters");
  const sessionLabel = report.sessionLabel?.trim();
  if (Object.hasOwn(report, "sessionLabel") && (sessionLabel === undefined || Array.from(sessionLabel).length < 2 || Array.from(sessionLabel).length > 80)) throw new Error("sessionLabel must contain 2 to 80 characters");
  if (report.impact && !["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"].includes(report.impact)) throw new Error("invalid impact");
  if (report.confidence !== undefined && (report.confidence < 0 || report.confidence > 1)) throw new Error("confidence must be between 0 and 1");
  if ((report.findings?.length || 0) > 8) throw new Error("findings cannot contain more than 8 items");
  for (const finding of report.findings || []) {
    if (!["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"].includes(finding.kind)) throw new Error("invalid finding kind");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(finding.topic)) throw new Error("finding topic must be a normalized slug");
    if (finding.severity && !["minor", "major", "blocking"].includes(finding.severity)) throw new Error("invalid finding severity");
    const detail = finding.detail.trim();
    if (detail.length < 3 || detail.length > 350) throw new Error("finding detail must contain 3 to 350 characters");
  }
  if (report.workaround?.used && !report.workaround.detail?.trim()) throw new Error("workaround detail is required when a workaround was used");

  const submitUrl = new URL(parsed.submit.url);
  if (submitUrl.protocol !== "https:") {
    throw new Error("Agent Feedback submissions require HTTPS");
  }
  const allowedOrigins = new Set(
    (options.allowedSubmitOrigins || [DEFAULT_SUBMIT_ORIGIN]).map(
      (value) => new URL(value).origin,
    ),
  );
  if (!allowedOrigins.has(submitUrl.origin)) {
    throw new Error(
      `Refusing to submit feedback to untrusted origin ${submitUrl.origin}`,
    );
  }

  const response = await (options.fetch || globalThis.fetch)(submitUrl, {
    method: "POST",
    headers: {
      authorization: parsed.submit.authorization,
      "content-type": "application/json",
      "user-agent": "@agent-feedback/node-agent/0.1.0",
    },
    body: JSON.stringify({
      summary,
      ...(sessionLabel !== undefined ? { sessionLabel } : {}),
      ...(report.impact ? { impact: report.impact } : {}),
      ...(report.confidence !== undefined ? { confidence: report.confidence } : {}),
      ...(report.findings ? { findings: report.findings } : {}),
      ...(report.workaround ? { workaround: report.workaround } : {}),
      ...(parsed.mode === "ask_once"
        ? {
            consent: {
              userApproved: true,
              approvalSource: options.approvalSource,
              consentScope: parsed.consentScope,
            },
          }
        : parsed.mode === "ask_always"
          ? {
              consent: {
                userApproved: true,
                approvalSource: "granted_now",
              },
            }
          : {}),
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  const body = (await response.json().catch(() => ({}))) as ProductFeedbackSubmission;
  if (!response.ok) {
    const retryable = response.status >= 500;
    throw new Error(
      `Feedback submission failed with HTTP ${response.status}${retryable ? "; retry once" : ""}`,
    );
  }
  return body;
}
