import assert from "node:assert/strict";
import test from "node:test";

import {
  feedbackConsentAction,
  feedbackFromResponse,
  submitProductFeedback,
} from "../dist/agent.js";

const envelope = {
  v: 1,
  mode: "never_ask",
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
    reportSchema: {
      required: ["summary"],
      optional: ["sessionLabel", "impact", "confidence", "findings", "workaround", "consent"],
      impacts: ["helped", "helped_with_friction", "neutral", "hindered", "blocked", "unknown"],
      findingKinds: ["strength", "friction", "defect", "gap", "suggestion", "uncertainty", "other"],
      findingSeverities: ["minor", "major", "blocking"],
      maxFindings: 8,
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

test("feedback-aware adapter submits a structured report to a trusted origin", async () => {
  const requests = [];
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
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ accepted: true, interactionId: "interaction_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.equal(result.accepted, true);
  assert.equal(JSON.parse(requests[0].init.body).findings[0].topic, "pagination");
  assert.equal(requests[0].init.headers.authorization, envelope.submit.authorization);
});

test("feedback-aware adapter rejects untrusted submission origins", async () => {
  await assert.rejects(
    submitProductFeedback(
      { ...envelope, submit: { ...envelope.submit, url: "https://evil.test/collect" } },
      { summary: "This report summary is long enough." },
      { allowedSubmitOrigins: ["https://feedback.test"] },
    ),
    /untrusted origin/,
  );
});

test("session labels use Unicode code-point limits and reject supplied blanks", async () => {
  for (const sessionLabel of ["", "   ", "😀", "😀".repeat(81)]) {
    await assert.rejects(
      submitProductFeedback(envelope, {
        summary: "This report summary is long enough.",
        sessionLabel,
      }),
      /sessionLabel must contain 2 to 80 characters/,
    );
  }
  for (const sessionLabel of ["😀😀", "😀".repeat(80)]) {
    const requests = [];
    await submitProductFeedback(
      envelope,
      { summary: "This report summary is long enough.", sessionLabel },
      {
        allowedSubmitOrigins: ["https://feedback.test"],
        fetch: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          return Response.json({ accepted: true });
        },
      },
    );
    assert.equal(requests[0].sessionLabel, sessionLabel);
  }
});

test("feedback-aware adapter resolves and enforces both consent modes", async () => {
  const askOnceEnvelope = {
    ...envelope,
    mode: "ask_once",
    consentRequired: true,
    consentPolicy: "once",
    consentScope: "afcs1_0123456789abcdef0123456789abcdef",
    when: "after_experience_known_and_consent_resolved",
  };
  const report = {
    summary: "The product response completed the task.",
    impact: "helped",
  };
  await assert.rejects(
    submitProductFeedback(askOnceEnvelope, report, {
      allowedSubmitOrigins: ["https://feedback.test"],
    }),
    /Explicit user approval is required/,
  );

  assert.equal(feedbackConsentAction(askOnceEnvelope), "ask");
  assert.equal(feedbackConsentAction(askOnceEnvelope, "approved"), "submit");
  assert.equal(feedbackConsentAction(askOnceEnvelope, "refused"), "skip");

  let submitted;
  await submitProductFeedback(askOnceEnvelope, report, {
    allowedSubmitOrigins: ["https://feedback.test"],
    userApproved: true,
    approvalSource: "stored_grant",
    fetch: async (_url, init) => {
      submitted = JSON.parse(init.body);
      return new Response('{"accepted":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(submitted.consent, {
    userApproved: true,
    approvalSource: "stored_grant",
    consentScope: askOnceEnvelope.consentScope,
  });

  const askAlwaysEnvelope = {
    ...askOnceEnvelope,
    mode: "ask_always",
    consentPolicy: "always",
    consentScope: undefined,
    when: "after_experience_known_and_explicit_user_approval",
  };
  assert.equal(feedbackConsentAction(askAlwaysEnvelope, "approved"), "ask");
  await assert.rejects(
    submitProductFeedback(askAlwaysEnvelope, report, {
      allowedSubmitOrigins: ["https://feedback.test"],
      userApproved: true,
      approvalSource: "stored_grant",
    }),
    /fresh approval/,
  );

  let alwaysSubmitted;
  await submitProductFeedback(askAlwaysEnvelope, report, {
    allowedSubmitOrigins: ["https://feedback.test"],
    userApproved: true,
    approvalSource: "granted_now",
    fetch: async (_url, init) => {
      alwaysSubmitted = JSON.parse(init.body);
      return new Response('{"accepted":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(alwaysSubmitted.consent, {
    userApproved: true,
    approvalSource: "granted_now",
  });
});

test("feedback-aware adapter rejects malformed consent contracts", () => {
  const malformedAlways = {
    ...envelope,
    mode: "ask_always",
    consentRequired: false,
    consentPolicy: "always",
    when: "after_experience_known_and_explicit_user_approval",
  };
  assert.equal(
    feedbackFromResponse({ headers: new Headers() }, { _agentFeedback: malformedAlways }),
    undefined,
  );
  assert.equal(feedbackConsentAction(malformedAlways, "approved"), "skip");

  const missingScope = {
    ...envelope,
    mode: "ask_once",
    consentRequired: true,
    consentPolicy: "once",
    when: "after_experience_known_and_consent_resolved",
  };
  assert.equal(feedbackConsentAction(missingScope), "skip");
});
