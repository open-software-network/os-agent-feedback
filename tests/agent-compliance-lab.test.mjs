import assert from "node:assert/strict";
import test from "node:test";

import { startLabServer } from "../experiments/agent-compliance/server.mjs";

test("compliance lab isolates response and llms.txt placements", async () => {
  const lab = await startLabServer();
  try {
    const responseRun = lab.createRun({
      mode: "never_ask",
      placement: "response_body",
      copy: "current",
    });
    const response = await fetch(responseRun.productUrl);
    const body = await response.json();
    assert.equal(body.recommendation.plan, "standard");
    assert.equal(body._agentFeedback.mode, "never_ask");
    assert.equal(body._agentFeedback.submit.url, `${lab.baseUrl}/submit/${responseRun.id}`);

    const llmsRun = lab.createRun({ mode: "never_ask", placement: "llms_only", copy: "current" });
    const llmsResponse = await fetch(llmsRun.productUrl);
    const llmsBody = await llmsResponse.json();
    assert.equal(llmsBody._agentFeedback, undefined);
    assert.match(llmsResponse.headers.get("link"), /llms\.txt/);
    const instructions = await (await fetch(llmsRun.llmsUrl)).text();
    assert.match(instructions, /POST exactly one JSON feedback report/);
  } finally {
    await lab.close();
  }
});

test("compliance lab enforces mode-specific consent and privacy", async () => {
  const lab = await startLabServer();
  try {
    const askRun = lab.createRun({ mode: "ask_once", placement: "response_body", copy: "current" });
    const product = await (await fetch(askRun.productUrl)).json();
    const withoutConsent = await fetch(product._agentFeedback.submit.url, {
      method: "POST",
      headers: {
        authorization: product._agentFeedback.submit.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "The queue plan recommendation was useful." }),
    });
    assert.equal(withoutConsent.status, 422);

    const sensitive = await fetch(product._agentFeedback.submit.url, {
      method: "POST",
      headers: {
        authorization: product._agentFeedback.submit.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: "The queue plan recommendation was useful.",
        prompt: "customer content",
        consent: {
          userApproved: true,
          approvalSource: "granted_now",
          consentScope: product._agentFeedback.consentScope,
        },
      }),
    });
    assert.equal(sensitive.status, 422);

    const invalidShape = await fetch(product._agentFeedback.submit.url, {
      method: "POST",
      headers: {
        authorization: product._agentFeedback.submit.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: "The queue plan recommendation was useful.",
        impact: "It was useful",
        confidence: "high",
        findings: ["Clear recommendation"],
        consent: {
          userApproved: true,
          approvalSource: "granted_now",
          consentScope: product._agentFeedback.consentScope,
        },
      }),
    });
    assert.equal(invalidShape.status, 422);

    const accepted = await fetch(product._agentFeedback.submit.url, {
      method: "POST",
      headers: {
        authorization: product._agentFeedback.submit.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: "The queue plan recommendation was clear and directly useful.",
        consent: {
          userApproved: true,
          approvalSource: "granted_now",
          consentScope: product._agentFeedback.consentScope,
        },
      }),
    });
    assert.equal(accepted.status, 201);
    assert.equal(
      lab.getRun(askRun.id).report.summary,
      "The queue plan recommendation was clear and directly useful.",
    );
  } finally {
    await lab.close();
  }
});

test("compliance lab records authenticated MCP product events", async () => {
  const lab = await startLabServer();
  try {
    const run = lab.createRun({
      mode: "never_ask",
      placement: "mcp_combined",
      copy: "full_schema",
    });
    const rejected = await fetch(`${lab.baseUrl}/event/${run.id}`, { method: "POST" });
    assert.equal(rejected.status, 401);
    const accepted = await fetch(`${lab.baseUrl}/event/${run.id}`, {
      method: "POST",
      headers: { authorization: `Bearer lab_event_${run.id}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "product_fetched", surface: "mcp" }),
    });
    assert.equal(accepted.status, 202);
    assert.equal(lab.getRun(run.id).events[0].surface, "mcp");
  } finally {
    await lab.close();
  }
});
