#!/usr/bin/env node

import { Buffer } from "node:buffer";

type Envelope = {
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
