#!/usr/bin/env node

import { Buffer } from "node:buffer";

type Envelope = {
  mode?: string;
  configuredMode?: string;
  state?: string;
  consentRequired?: boolean;
  consentPolicy?: string;
  consentManagedBy?: string;
  when?: string;
  submit?: {
    url?: string;
    method?: string;
    authorization?: string;
    contentType?: string;
    reportSchema?: Record<string, unknown>;
  };
  instruction?: string;
  requiredAction?: {
    type?: string;
    question?: string;
    submitDecision?: {
      url?: string;
      method?: string;
      authorization?: string;
      bodySchema?: { decision?: string[] };
    };
  };
};

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function embeddedFromHtml(html: string): Envelope | undefined {
  const match = /<script[^>]+id=["']agent-feedback["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return undefined;
  return JSON.parse(match[1]) as Envelope;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    fail("Usage: agent-feedback-doctor <product-response-url>");
  }
  const response = await fetch(target, {
    headers: { accept: "application/json, text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`Product returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  let envelope: Envelope | undefined;
  if (contentType.includes("application/json")) {
    const body = JSON.parse(raw) as Record<string, unknown>;
    envelope = body._agentFeedback as Envelope | undefined;
  } else if (contentType.includes("text/html")) {
    envelope = embeddedFromHtml(raw);
  }
  if (!envelope) {
    const encoded = response.headers.get("agent-feedback");
    if (encoded) {
      envelope = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Envelope;
    }
  }
  if (!envelope?.instruction) fail("Response is missing feedback instructions");
  if (envelope.state === "consent_required") {
    const action = envelope.requiredAction;
    const validOnce =
      envelope.mode === "ask_once" &&
      envelope.consentRequired === true &&
      envelope.consentPolicy === "once" &&
      envelope.when === "after_experience_known_and_consent_resolved";
    const validAlways =
      envelope.mode === "ask_always" &&
      envelope.consentRequired === true &&
      envelope.consentPolicy === "always" &&
      envelope.when === "after_experience_known_and_explicit_user_approval";
    if (
      (!validOnce && !validAlways) ||
      envelope.consentManagedBy !== "epode" ||
      envelope.submit !== undefined ||
      action?.type !== "ask_user" ||
      action.submitDecision?.method !== "POST" ||
      !action.submitDecision.authorization?.startsWith("Bearer afr2_") ||
      action.submitDecision.bodySchema?.decision?.join(",") !== "approved,declined"
    ) {
      fail("Response has an invalid answer-first consent contract");
    }
    console.log("PASS response injection");
    console.log(`PASS ${envelope.mode} answer-first decision contract`);
    console.log("PASS report schema withheld until approval");
    console.log("PASS synthetic decision skipped; the doctor cannot impersonate the user");
    return;
  }
  if (
    envelope.state !== "feedback_ready" ||
    !envelope.submit?.url ||
    envelope.submit.method !== "POST" ||
    !envelope.submit.authorization?.startsWith("Bearer afr2_") ||
    !envelope.submit.reportSchema
  ) {
    fail("Response has an incomplete feedback submission contract");
  }
  if (
    envelope.mode !== "never_ask" ||
    envelope.consentRequired !== false ||
    envelope.consentPolicy !== "none" ||
    envelope.when !== "after_experience_known_before_final_response"
  ) {
    fail("Response has an invalid Never ask feedback contract");
  }
  const report = await fetch(envelope.submit.url, {
    method: "POST",
    headers: {
      authorization: envelope.submit.authorization,
      "content-type": envelope.submit.contentType || "application/json",
    },
    body: JSON.stringify({
      summary: "The integration doctor verified this product response end to end.",
      impact: "helped",
      confidence: 1,
      findings: [
        {
          kind: "strength",
          topic: "integration",
          detail: "Response discovery and feedback submission both worked.",
        },
      ],
      workaround: { used: false },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!report.ok) fail(`Synthetic report returned HTTP ${report.status}`);
  const accepted = (await report.json()) as { interactionId?: string };
  console.log(`PASS response injection`);
  console.log(`PASS scoped direct submission`);
  console.log(`PASS synthetic report ${accepted.interactionId || "accepted"}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
