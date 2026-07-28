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

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(value: unknown): FeedbackEnvelope | undefined {
  if (!object(value) || value.v !== 1 || !object(value.submit)) return undefined;
  if (
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
