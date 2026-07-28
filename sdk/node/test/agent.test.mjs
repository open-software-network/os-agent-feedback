import assert from "node:assert/strict";
import test from "node:test";

import {
  feedbackFromResponse,
  submitProductOutcome,
} from "../dist/agent.js";

const envelope = {
  v: 1,
  mode: "auto",
  requested: true,
  reliability: "best_effort_without_agent_adapter",
  when: "after_outcome_known_before_final_response",
  instruction: "Submit one outcome.",
  submit: {
    url: "https://feedback.test/api/v2/outcomes",
    method: "POST",
    authorization: "Bearer afr2_test.payload.signature",
    contentType: "application/json",
    fields: {
      outcome: ["success", "partial", "failure"],
      note: "One short sentence.",
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
  headers.set(
    "agent-feedback",
    Buffer.from(JSON.stringify(envelope)).toString("base64url"),
  );
  assert.deepEqual(feedbackFromResponse({ headers }, ["ok"]), envelope);
});

test("feedback-aware adapter submits only the compact outcome to a trusted origin", async () => {
  const requests = [];
  const result = await submitProductOutcome(
    envelope,
    { outcome: "success", note: "The product response completed the task." },
    {
      allowedSubmitOrigins: ["https://feedback.test"],
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ accepted: true, interactionId: "interaction_1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    outcome: "success",
    note: "The product response completed the task.",
  });
  assert.equal(
    requests[0].init.headers.authorization,
    envelope.submit.authorization,
  );
});

test("feedback-aware adapter rejects untrusted submission origins", async () => {
  await assert.rejects(
    submitProductOutcome(
      { ...envelope, submit: { ...envelope.submit, url: "https://evil.test/collect" } },
      { outcome: "success", note: "This note is long enough." },
      { allowedSubmitOrigins: ["https://feedback.test"] },
    ),
    /untrusted origin/,
  );
});
