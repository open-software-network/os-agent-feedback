import assert from "node:assert/strict";
import test from "node:test";

import {
  feedbackConsentAction,
  feedbackFromResponse,
  submitFeedbackConsent,
  submitProductFeedback,
} from "../dist/agent.js";

const reportSchema = {
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
};

const envelope = {
  v: 1,
  mode: "never_ask",
  state: "feedback_ready",
  requested: true,
  consentRequired: false,
  consentPolicy: "none",
  reliability: "best_effort_without_agent_adapter",
  when: "after_experience_known_before_final_response",
  instruction: "Submit one feedback report.",
  submit: {
    url: "https://feedback.test/api/v2/reports",
    method: "POST",
    authorization: "Bearer afr2_test.payload.signature",
    contentType: "application/json",
    reportSchema,
  },
  privacy: "No user data.",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const consentEnvelope = {
  v: 1,
  mode: "ask_once",
  configuredMode: "ask_once",
  state: "consent_required",
  requested: true,
  consentRequired: true,
  consentPolicy: "once",
  consentManagedBy: "epode",
  reliability: "best_effort_without_agent_adapter",
  when: "after_experience_known_and_consent_resolved",
  instruction: "Answer the product task, then ask the exact question and wait.",
  requiredAction: {
    type: "ask_user",
    question: "May I send feedback?",
    submitDecision: {
      url: "https://feedback.test/api/v2/consent/decisions",
      method: "POST",
      authorization: "Bearer afr2_test.payload.signature",
      contentType: "application/json",
      bodySchema: { decision: ["approved", "declined"] },
    },
  },
  privacy: "No user data.",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

test("feedback-aware adapter reads JSON, HTML, and header metadata", () => {
  const headers = new Headers();
  assert.equal(
    feedbackFromResponse({ headers }, { answer: "ok", _agentFeedback: envelope }),
    envelope,
  );
  const html = `<!doctype html><script id="agent-feedback" type="application/json">${JSON.stringify(envelope)}</script>`;
  assert.deepEqual(feedbackFromResponse({ headers }, html), envelope);
  headers.set("agent-feedback", Buffer.from(JSON.stringify(envelope)).toString("base64url"));
  assert.deepEqual(feedbackFromResponse({ headers }, ["ok"]), envelope);
});

test("feedback-aware adapter submits a structured report without a consent attestation", async () => {
  let request;
  const result = await submitProductFeedback(
    envelope,
    {
      summary: "The product response completed the task with one workaround.",
      impact: "helped_with_friction",
      confidence: 0.9,
      findings: [
        {
          kind: "friction",
          topic: "pagination",
          severity: "minor",
          detail: "A second request was needed.",
        },
      ],
      workaround: { used: true, detail: "The agent requested the next page." },
    },
    {
      allowedSubmitOrigins: ["https://feedback.test"],
      fetch: async (url, init) => {
        request = { url: String(url), init };
        return new Response('{"accepted":true,"interactionId":"interaction_1"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(result.accepted, true);
  assert.equal(JSON.parse(request.init.body).findings[0].topic, "pagination");
  assert.equal(JSON.parse(request.init.body).consent, undefined);
});

test("answer-first consent records only a decision and reveals reporting after approval", async () => {
  assert.equal(feedbackConsentAction(consentEnvelope), "ask");
  let decisionBody;
  const approved = await submitFeedbackConsent(consentEnvelope, "approved", {
    allowedSubmitOrigins: ["https://feedback.test"],
    fetch: async (_url, init) => {
      decisionBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ state: "approved", feedback: envelope }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(decisionBody, { decision: "approved" });
  assert.equal(approved.state, "approved");
  assert.equal(feedbackConsentAction(approved.feedback), "submit");

  const declined = await submitFeedbackConsent(consentEnvelope, "declined", {
    allowedSubmitOrigins: ["https://feedback.test"],
    fetch: async () =>
      new Response('{"state":"declined","feedback":null}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(declined.state, "declined");
  assert.equal(declined.feedback, undefined);
});

test("feedback-aware adapter rejects wrong-stage and untrusted contracts", async () => {
  await assert.rejects(
    submitProductFeedback(consentEnvelope, { summary: "This report summary is long enough." }),
    /Invalid Agent Feedback submission contract/,
  );
  await assert.rejects(
    submitProductFeedback(
      { ...envelope, submit: { ...envelope.submit, url: "https://evil.test/collect" } },
      { summary: "This report summary is long enough." },
      { allowedSubmitOrigins: ["https://feedback.test"] },
    ),
    /untrusted origin/,
  );
  assert.equal(feedbackConsentAction({ ...consentEnvelope, requiredAction: undefined }), "skip");
  assert.equal(feedbackConsentAction({ ...consentEnvelope, consentPolicy: "always" }), "skip");
  assert.equal(
    feedbackConsentAction({
      ...consentEnvelope,
      when: "after_experience_known_and_explicit_user_approval",
    }),
    "skip",
  );
  assert.equal(
    feedbackConsentAction({
      ...consentEnvelope,
      requiredAction: {
        ...consentEnvelope.requiredAction,
        submitDecision: {
          ...consentEnvelope.requiredAction.submitDecision,
          authorization: "Bearer untrusted",
        },
      },
    }),
    "skip",
  );
  assert.equal(
    feedbackConsentAction({
      ...consentEnvelope,
      requiredAction: {
        ...consentEnvelope.requiredAction,
        submitDecision: {
          ...consentEnvelope.requiredAction.submitDecision,
          bodySchema: { decision: ["approved", "declined", "unsure"] },
        },
      },
    }),
    "skip",
  );
  assert.equal(
    feedbackConsentAction({ ...envelope, when: "after_experience_known_and_consent_resolved" }),
    "skip",
  );
  assert.equal(
    feedbackConsentAction({ ...envelope, requiredAction: consentEnvelope.requiredAction }),
    "skip",
  );
  assert.equal(
    feedbackConsentAction({
      ...consentEnvelope,
      requiredAction: {
        ...consentEnvelope.requiredAction,
        submitDecision: {
          ...consentEnvelope.requiredAction.submitDecision,
          bodySchema: {
            decision: ["approved", "declined"],
            foreign: ["unexpected"],
          },
        },
      },
    }),
    "skip",
  );
});

test("feedback-aware adapter accepts the safe per-use fallback for unscoped ask-once", () => {
  assert.equal(
    feedbackConsentAction({
      ...consentEnvelope,
      mode: "ask_always",
      configuredMode: "ask_once",
      consentPolicy: "always",
      when: "after_experience_known_and_explicit_user_approval",
    }),
    "ask",
  );
});
