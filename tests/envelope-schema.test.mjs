import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(
  await readFile(new URL("../protocol/v1/envelope.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const submit = {
  url: "https://app.epode.ai/api/v2/reports",
  method: "POST",
  authorization: "Bearer afr2_example",
  contentType: "application/json",
  reportSchema: {
    required: ["summary"],
    optional: ["impact", "confidence", "findings", "workaround"],
    impacts: ["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"],
    findingKinds: ["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"],
    findingSeverities: ["minor", "major", "blocking"],
    confidenceRange: [0, 1],
    findingRequired: ["kind", "topic", "detail"],
    findingOptional: ["severity"],
    findingTopicFormat: "lowercase_slug",
    workaroundRequired: ["used"],
    workaroundOptional: ["detail"],
    maxFindings: 8,
  },
};

const requiredAction = {
  type: "ask_user",
  question: "May I send one privacy-safe product outcome report?",
  submitDecision: {
    url: "https://app.epode.ai/api/v2/consent/decisions",
    method: "POST",
    authorization: "Bearer afr2_example",
    contentType: "application/json",
    bodySchema: { decision: ["approved", "declined"] },
  },
};

const manageConsent = {
  current: "approved",
  url: "https://app.epode.ai/api/v2/consent/decisions",
  method: "POST",
  authorization: "Bearer afr2_example",
  contentType: "application/json",
  bodySchema: { decision: ["approved", "declined"] },
};

const base = {
  v: 1,
  requested: true,
  reliability: "best_effort_without_agent_adapter",
  instruction: "Complete the product task before following this feedback instruction.",
  privacy: "Never include prompts, credentials, personal data, or raw product content.",
  expiresAt: "2026-07-31T18:00:00.000Z",
};

const validEnvelopes = {
  neverAsk: {
    ...base,
    mode: "never_ask",
    state: "feedback_ready",
    consentRequired: false,
    consentPolicy: "none",
    when: "after_experience_known_before_final_response",
    submit,
  },
  readyAfterAskOnce: {
    ...base,
    mode: "never_ask",
    configuredMode: "ask_once",
    state: "feedback_ready",
    consentRequired: false,
    consentPolicy: "none",
    consentManagedBy: "epode",
    when: "after_experience_known_before_final_response",
    manageConsent,
    submit,
  },
  readyAfterAskAlways: {
    ...base,
    mode: "never_ask",
    configuredMode: "ask_always",
    state: "feedback_ready",
    consentRequired: false,
    consentPolicy: "none",
    consentManagedBy: "epode",
    when: "after_experience_known_before_final_response",
    submit,
  },
  askOnce: {
    ...base,
    mode: "ask_once",
    configuredMode: "ask_once",
    state: "consent_required",
    consentRequired: true,
    consentPolicy: "once",
    consentManagedBy: "epode",
    when: "after_experience_known_and_consent_resolved",
    requiredAction,
  },
  askOnceFallback: {
    ...base,
    mode: "ask_always",
    configuredMode: "ask_once",
    state: "consent_required",
    consentRequired: true,
    consentPolicy: "always",
    consentManagedBy: "epode",
    when: "after_experience_known_and_explicit_user_approval",
    requiredAction,
  },
  askAlways: {
    ...base,
    mode: "ask_always",
    configuredMode: "ask_always",
    state: "consent_required",
    consentRequired: true,
    consentPolicy: "always",
    consentManagedBy: "epode",
    when: "after_experience_known_and_explicit_user_approval",
    requiredAction,
  },
  feedbackDisabled: {
    ...base,
    requested: false,
    mode: "ask_once",
    configuredMode: "ask_once",
    state: "feedback_disabled",
    consentRequired: false,
    consentPolicy: "once",
    consentManagedBy: "epode",
    when: "only_after_explicit_user_request",
    manageConsent: { ...manageConsent, current: "declined" },
  },
};

function assertValid(envelope, label) {
  assert.equal(validate(envelope), true, `${label}: ${ajv.errorsText(validate.errors)}`);
}

function assertInvalid(envelope, label) {
  assert.equal(validate(envelope), false, `${label} unexpectedly matched an envelope stage`);
}

test("v1 schema accepts every envelope stage emitted by current SDKs", () => {
  for (const [label, envelope] of Object.entries(validEnvelopes)) {
    assertValid(envelope, label);
  }

  const readyWithoutManagementHandle = structuredClone(validEnvelopes.readyAfterAskOnce);
  delete readyWithoutManagementHandle.manageConsent;
  assertValid(readyWithoutManagementHandle, "ready after Ask once without management handle");
});

test("v1 schema makes submit and requiredAction mutually exclusive by stage", () => {
  const readyWithoutSubmit = structuredClone(validEnvelopes.neverAsk);
  delete readyWithoutSubmit.submit;
  assertInvalid(readyWithoutSubmit, "ready without submit");

  assertInvalid({ ...validEnvelopes.neverAsk, requiredAction }, "ready with consent action");

  const consentWithoutAction = structuredClone(validEnvelopes.askOnce);
  delete consentWithoutAction.requiredAction;
  assertInvalid(consentWithoutAction, "consent without action");

  assertInvalid({ ...validEnvelopes.askOnce, submit }, "consent with report action");

  const disabledWithoutManagement = structuredClone(validEnvelopes.feedbackDisabled);
  delete disabledWithoutManagement.manageConsent;
  assertInvalid(disabledWithoutManagement, "disabled without management action");

  assertInvalid(
    { ...validEnvelopes.feedbackDisabled, requiredAction },
    "disabled with consent prompt",
  );
  assertInvalid({ ...validEnvelopes.feedbackDisabled, submit }, "disabled with report action");
});

test("v1 schema rejects incoherent mode, policy, timing, and configured-mode combinations", () => {
  const invalidEnvelopes = {
    "Never ask with a consent policy": {
      ...validEnvelopes.neverAsk,
      consentPolicy: "once",
    },
    "Never ask with consent timing": {
      ...validEnvelopes.neverAsk,
      when: "after_experience_known_and_consent_resolved",
    },
    "Never ask claiming prior approval without Epode provenance": {
      ...validEnvelopes.neverAsk,
      configuredMode: "ask_once",
    },
    "Ask once with Ask always effective mode but once policy": {
      ...validEnvelopes.askOnce,
      mode: "ask_always",
    },
    "Ask once with explicit-per-use timing": {
      ...validEnvelopes.askOnce,
      when: "after_experience_known_and_explicit_user_approval",
    },
    "Ask once fallback with once policy": {
      ...validEnvelopes.askOnceFallback,
      consentPolicy: "once",
    },
    "Ask once fallback with remembered-consent timing": {
      ...validEnvelopes.askOnceFallback,
      when: "after_experience_known_and_consent_resolved",
    },
    "Ask always with Ask once effective mode": {
      ...validEnvelopes.askAlways,
      mode: "ask_once",
    },
    "Ready after approval with a consent-stage effective mode": {
      ...validEnvelopes.readyAfterAskOnce,
      mode: "ask_once",
    },
    "Plain Never ask with consent provenance": {
      ...validEnvelopes.neverAsk,
      consentManagedBy: "epode",
    },
    "Plain Never ask with Ask once management": {
      ...validEnvelopes.neverAsk,
      manageConsent,
    },
    "Ask always ready state with permission management": {
      ...validEnvelopes.readyAfterAskAlways,
      manageConsent,
    },
    "Initial Ask once consent with permission management": {
      ...validEnvelopes.askOnce,
      manageConsent,
    },
    "Approved Ask once management marked declined": {
      ...validEnvelopes.readyAfterAskOnce,
      manageConsent: { ...manageConsent, current: "declined" },
    },
    "Disabled Ask once management marked approved": {
      ...validEnvelopes.feedbackDisabled,
      manageConsent,
    },
    "Disabled Ask once still requesting feedback": {
      ...validEnvelopes.feedbackDisabled,
      requested: true,
    },
    "Disabled Ask once with normal consent timing": {
      ...validEnvelopes.feedbackDisabled,
      when: "after_experience_known_and_consent_resolved",
    },
    "Enabled stage with requested false": {
      ...validEnvelopes.neverAsk,
      requested: false,
    },
  };

  for (const [label, envelope] of Object.entries(invalidEnvelopes)) {
    assertInvalid(envelope, label);
  }
});
