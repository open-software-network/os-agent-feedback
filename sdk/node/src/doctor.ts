#!/usr/bin/env node

import { Buffer } from "node:buffer";

type Envelope = {
  mode?: string;
  consentRequired?: boolean;
  consentPolicy?: string;
  consentScope?: string;
  when?: string;
  submit?: {
    url?: string;
    method?: string;
    authorization?: string;
    contentType?: string;
    fields?: Record<string, unknown>;
  };
  instruction?: string;
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
  if (
    !envelope.submit?.url ||
    envelope.submit.method !== "POST" ||
    !envelope.submit.authorization?.startsWith("Bearer afr2_") ||
    !envelope.submit.fields
  ) {
    fail("Response has an incomplete feedback submission contract");
  }
  const consentMode = envelope.mode === "ask_once" || envelope.mode === "ask_always";
  if (consentMode) {
    const validOnce = envelope.mode === "ask_once" &&
      envelope.consentRequired === true &&
      envelope.consentPolicy === "once" &&
      /^afcs1_[0-9a-f]{32}$/.test(envelope.consentScope || "") &&
      envelope.when === "after_outcome_known_and_consent_resolved";
    const validAlways = envelope.mode === "ask_always" &&
      envelope.consentRequired === true &&
      envelope.consentPolicy === "always" &&
      envelope.consentScope === undefined &&
      envelope.when === "after_outcome_known_and_explicit_user_approval";
    if (!validOnce && !validAlways) fail("Response has an invalid consent contract");
    console.log("PASS response injection");
    console.log(`PASS ${envelope.mode} consent contract`);
    console.log("PASS synthetic review skipped; the doctor cannot impersonate user consent");
    return;
  }
  if (
    envelope.mode !== "never_ask" ||
    envelope.consentRequired !== false ||
    envelope.consentPolicy !== "none" ||
    envelope.consentScope !== undefined ||
    envelope.when !== "after_outcome_known_before_final_response"
  ) {
    fail("Response has an invalid Never ask feedback contract");
  }
  const review = await fetch(envelope.submit.url, {
    method: "POST",
    headers: {
      authorization: envelope.submit.authorization,
      "content-type": envelope.submit.contentType || "application/json",
    },
    body: JSON.stringify({
      outcome: "success",
      note: "The integration doctor verified this product response end to end.",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!review.ok) fail(`Synthetic review returned HTTP ${review.status}`);
  const accepted = (await review.json()) as { interactionId?: string };
  console.log(`PASS response injection`);
  console.log(`PASS scoped direct submission`);
  console.log(`PASS synthetic review ${accepted.interactionId || "accepted"}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
