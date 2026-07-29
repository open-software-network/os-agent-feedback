#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3180").replace(/\/$/, "");
const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");
const keyMatch = /^af_live_([0-9a-f]{32})_(.{20,})$/i.exec(apiKey);
if (!keyMatch) throw new Error("A v2 product key is required");

function capability(interactionId, issuedAt = Math.floor(Date.now() / 1000), expiresAt = issuedAt + 7200) {
  const claims = { v: 1, i: interactionId, iat: issuedAt, exp: expiresAt, n: randomBytes(18).toString("base64url") };
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
const first = await call("/api/v2/outcomes", {
  token: receipt,
  body: { outcome: "partial", note: "The result helped, but one field was missing." },
});
assert.equal(first.payload.review.outcome, "partial");
const duplicate = await call("/api/v2/outcomes", {
  token: receipt,
  body: { outcome: "failure", note: "A duplicate must return the original review." },
});
assert.equal(duplicate.payload.review.id, first.payload.review.id);
assert.equal(duplicate.payload.review.outcome, "partial");
console.log("PASS outcome: receipt promotes interaction and first review wins idempotently");

const forged = `${receipt.slice(0, -1)}${receipt.endsWith("A") ? "B" : "A"}`;
await call("/api/v2/outcomes", {
  token: forged,
  expected: 401,
  body: { outcome: "success", note: "A forged receipt must be rejected." },
});
const now = Math.floor(Date.now() / 1000);
await call("/api/v2/outcomes", {
  token: capability(randomUUID(), now - 7300, now - 100),
  expected: 401,
  body: { outcome: "success", note: "An expired receipt must be rejected." },
});
console.log("PASS capability security: forged and expired receipts rejected");

await call("/api/v2/outcomes", {
  token: capability(randomUUID()),
  expected: 400,
  body: { outcome: "success", note: "Otherwise valid compact review.", metadata: { prompt: "private" } },
});
await call("/api/v2/outcomes", {
  token: capability(randomUUID()),
  expected: 400,
  body: { outcome: "success", note: "Bearer private-token must never be accepted." },
});
console.log("PASS privacy: unknown, recursive, and secret-shaped review data rejected");

await call("/api/v1/interactions", {
  expected: 404,
  body: { task: "removed prototype write" },
});
console.log("PASS cleanup: prototype write routes no longer exist");

console.log("PASS v2 acceptance");
