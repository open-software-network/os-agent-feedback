import { Buffer } from "node:buffer";

import type { FeedbackEnvelope } from "./core.js";

export type ProductOutcome = "success" | "partial" | "failure";

export interface ProductOutcomeReview {
  outcome: ProductOutcome;
  note: string;
}

export interface SubmitProductOutcomeOptions {
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

export interface ProductOutcomeSubmission {
  accepted: boolean;
  interactionId?: string;
  review?: {
    id?: string;
    outcome?: ProductOutcome;
    note?: string;
  };
  [key: string]: unknown;
}

const DEFAULT_SUBMIT_ORIGIN =
  "https://agent-feedback-api-production.up.railway.app";

export type StoredFeedbackConsent = "approved" | "refused";
export type FeedbackConsentAction = "submit" | "ask" | "skip";

/**
 * Resolves an agent-runtime consent preference without sending it to Epode.
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
  if (value.mode === "auto") {
    return value.consentRequired === false &&
      value.consentPolicy === "none" &&
      value.when === "after_outcome_known_before_final_response" &&
      scope === undefined;
  }
  if (value.mode === "ask_once") {
    return value.consentRequired === true &&
      value.consentPolicy === "once" &&
      value.when === "after_outcome_known_and_consent_resolved" &&
      validScope;
  }
  if (value.mode === "ask_always") {
    return value.consentRequired === true &&
      value.consentPolicy === "always" &&
      value.when === "after_outcome_known_and_explicit_user_approval" &&
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
 * Deterministically submit a compact outcome from a feedback-aware agent
 * runtime. Generic agents may ignore response metadata; this explicit adapter
 * is the reliable HTTP/HTML path.
 */
export async function submitProductOutcome(
  feedback: FeedbackEnvelope,
  review: ProductOutcomeReview,
  options: SubmitProductOutcomeOptions = {},
): Promise<ProductOutcomeSubmission> {
  const parsed = parseEnvelope(feedback);
  if (!parsed) throw new Error("Invalid Agent Feedback submission contract");
  if (parsed.consentRequired && options.userApproved !== true) {
    throw new Error("Explicit user approval is required before submitting this outcome");
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
  if (!["success", "partial", "failure"].includes(review.outcome)) {
    throw new Error("outcome must be success, partial, or failure");
  }
  const note = review.note.trim();
  if (note.length < 8 || note.length > 500) {
    throw new Error("note must contain 8 to 500 characters");
  }

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
    body: JSON.stringify({ outcome: review.outcome, note }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });
  const body = (await response.json().catch(() => ({}))) as ProductOutcomeSubmission;
  if (!response.ok) {
    const retryable = response.status >= 500;
    throw new Error(
      `Outcome submission failed with HTTP ${response.status}${retryable ? "; retry once" : ""}`,
    );
  }
  return body;
}
