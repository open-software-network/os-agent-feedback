#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3180").replace(/\/$/, "");
const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");
const keyMatch = /^af_live_([0-9a-f]{32})_(.{20,})$/i.exec(apiKey);
if (!keyMatch) throw new Error("A v2 product key is required");

function capability(
  interactionId,
  issuedAt = Math.floor(Date.now() / 1000),
  expiresAt = issuedAt + 7200,
  { subject, revision } = {},
) {
  const claims = { v: 1, i: interactionId, iat: issuedAt, exp: expiresAt, n: randomBytes(18).toString("base64url") };
  if (subject !== undefined) claims.s = subject;
  if (revision !== undefined) claims.r = revision;
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `afr2_${keyMatch[1].toLowerCase()}.${payload}`;
  const signingKey = createHash("sha256").update(apiKey).digest();
  return `${input}.${createHmac("sha256", signingKey).update(input).digest("base64url")}`;
}

async function call(path, { token = apiKey, body, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(payload)}`);
  return { response, payload };
}

const interactionId = randomUUID();
await call("/api/v2/telemetry/batches", {
  expected: 202,
  body: {
    events: [{
      interactionId,
      surface: "http_json",
      operation: "/acceptance/search",
      statusCode: 200,
      durationMs: 14,
      customerRef: "acct_acceptance",
      classification: "unclassified",
      sessionRef: "session_acceptance",
      sessionSource: "customer",
      occurredAt: new Date().toISOString(),
    }],
  },
});
console.log("PASS telemetry: anonymous HTTP opportunity accepted asynchronously");

const receipt = capability(interactionId);
const first = await call("/api/v2/reports", {
  token: receipt,
  body: {
    summary: "The result helped, but one important field was missing.",
    impact: "helped_with_friction",
    confidence: 0.86,
    findings: [
      { kind: "strength", topic: "relevance", detail: "The primary result answered the question." },
      { kind: "gap", topic: "completeness", severity: "major", detail: "One requested field was absent." },
    ],
    workaround: { used: true, detail: "The agent inferred the missing field from a second result." },
  },
});
assert.equal(first.payload.report.impact, "helped_with_friction");
assert.equal(first.payload.report.findings.length, 2);
const duplicate = await call("/api/v2/reports", {
  token: receipt,
  body: { summary: "A duplicate report must return the original report unchanged." },
});
assert.equal(duplicate.payload.report.id, first.payload.report.id);
assert.equal(duplicate.payload.report.impact, "helped_with_friction");
console.log("PASS report: receipt promotes interaction and first report wins idempotently");

const forged = `${receipt.slice(0, -1)}${receipt.endsWith("A") ? "B" : "A"}`;
await call("/api/v2/reports", {
  token: forged,
  expected: 401,
  body: { summary: "A forged receipt must be rejected by the service." },
});
const now = Math.floor(Date.now() / 1000);
await call("/api/v2/reports", {
  token: capability(randomUUID(), now - 7300, now - 100),
  expected: 401,
  body: { summary: "An expired receipt must be rejected by the service." },
});
console.log("PASS capability security: forged and expired receipts rejected");

await call("/api/v2/reports", {
  token: capability(randomUUID()),
  expected: 400,
  body: { summary: "Otherwise this would be a valid product feedback report.", metadata: { prompt: "private" } },
});
await call("/api/v2/reports", {
  token: capability(randomUUID()),
  expected: 400,
  body: { summary: "Bearer private-token must never be accepted here." },
});
console.log("PASS privacy: unknown, recursive, and secret-shaped review data rejected");

await call("/api/v1/interactions", {
  expected: 404,
  body: { task: "removed prototype write" },
});
console.log("PASS cleanup: prototype write routes no longer exist");

console.log("PASS v2 acceptance");
