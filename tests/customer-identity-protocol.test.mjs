import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const telemetrySchema = JSON.parse(
  await readFile(new URL("../protocol/v1/telemetry-batch.schema.json", import.meta.url), "utf8"),
);
const envelopeSchema = JSON.parse(
  await readFile(new URL("../protocol/v1/envelope.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateTelemetry = ajv.compile(telemetrySchema);
const validateEnvelope = ajv.compile(envelopeSchema);

const event = {
  interactionId: "018f1f2e-7b4a-7c12-9c8d-123456789abc",
  surface: "http_json",
  operation: "/search",
  statusCode: 200,
  accountRef: "org_123",
  userRef: "user_123",
  anonymousRef: "anon_123",
  customerRef: "legacy_123",
  classification: "unclassified",
  occurredAt: "2026-08-01T12:00:00.000Z",
};

test("telemetry accepts bounded company-side progressive identity context", () => {
  assert.equal(
    validateTelemetry({ events: [event] }),
    true,
    ajv.errorsText(validateTelemetry.errors),
  );
});

test("telemetry rejects unbounded, personal, and unknown identity fields", () => {
  for (const invalid of [
    { ...event, userRef: "person@example.com" },
    { ...event, anonymousRef: "contains whitespace" },
    { ...event, accountRef: "x".repeat(161) },
    { ...event, agentIdentity: "invented-agent" },
  ]) {
    assert.equal(validateTelemetry({ events: [invalid] }), false);
  }
});

test("a product link click joins by first-party browser reference while request details stay traits", () => {
  const linked = {
    ...event,
    surface: "http_html",
    anonymousRef: "s-first-party-browser",
    sessionRef: "session-generated-by-product",
    sessionSource: "customer",
    customerLinkSource: "product_link_click",
    requestObservation: {
      clientIp: "203.0.113.10",
      method: "GET",
      userAgent: "Mozilla/5.0 Browser",
    },
  };
  assert.equal(
    validateTelemetry({ events: [linked] }),
    true,
    ajv.errorsText(validateTelemetry.errors),
  );
  assert.equal(
    validateTelemetry({
      events: [{ ...linked, anonymousRef: undefined }],
    }),
    false,
  );
  assert.equal(
    validateTelemetry({
      events: [{ ...linked, surface: "http_json" }],
    }),
    false,
  );
});

test("agent-visible envelope cannot contain company identity references", () => {
  const envelope = {
    v: 1,
    mode: "never_ask",
    state: "feedback_ready",
    requested: true,
    consentRequired: false,
    consentPolicy: "none",
    reliability: "best_effort_without_agent_adapter",
    when: "after_experience_known_before_final_response",
    instruction: "Complete the product task, then submit one bounded outcome report.",
    submit: {
      url: "https://app.epode.ai/api/v2/reports",
      method: "POST",
      authorization: "Bearer afr2_example",
      contentType: "application/json",
      reportSchema: {
        required: ["summary"],
        optional: ["impact", "confidence", "findings", "workaround"],
        impacts: ["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"],
        findingKinds: [
          "strength",
          "friction",
          "defect",
          "gap",
          "suggestion",
          "uncertainty",
          "other",
        ],
        findingSeverities: ["minor", "major", "blocking"],
        confidenceRange: [0, 1],
        summaryMinLength: 8,
        summaryMaxLength: 700,
        findingRequired: ["kind", "topic", "detail"],
        findingOptional: ["severity"],
        findingTopicFormat: "lowercase_slug",
        findingDetailMinLength: 3,
        findingDetailMaxLength: 350,
        workaroundRequired: ["used"],
        workaroundOptional: ["detail"],
        workaroundDetailMinLength: 3,
        workaroundDetailMaxLength: 350,
        maxFindings: 8,
      },
    },
    privacy: "Never include prompts, credentials, personal data, or raw product content.",
    expiresAt: "2026-08-01T14:00:00.000Z",
    accountRef: "org_123",
  };
  assert.equal(validateEnvelope(envelope), false);
});
