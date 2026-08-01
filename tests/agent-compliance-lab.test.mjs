import assert from "node:assert/strict";
import test from "node:test";

import { mcpClientArguments } from "../experiments/agent-compliance/runtime-config.mjs";
import { startLabServer } from "../experiments/agent-compliance/server.mjs";

test("agent evaluator preserves the exact MCP server across initial and resumed turns", () => {
  const run = {
    id: "run-consent-1",
    baseUrl: "http://127.0.0.1:43210",
    placement: "mcp_mrtr",
    copy: "native_input_required",
    surface: "mcp",
  };
  const server = "/repo/experiments/agent-compliance/mcp-server.mjs";
  const codex = mcpClientArguments("codex", run, server);
  assert.deepEqual(JSON.parse(codex[3].replace("mcp_servers.acme.args=", "")), [
    server,
    "--run-id",
    run.id,
    "--base-url",
    run.baseUrl,
    "--placement",
    run.placement,
    "--copy",
    run.copy,
  ]);
  const claude = JSON.parse(mcpClientArguments("claude", run, server)[1]);
  assert.deepEqual(claude.mcpServers.acme.args, JSON.parse(codex[3].split("=", 2)[1]));
  assert.deepEqual(mcpClientArguments("codex", { ...run, surface: "http" }, server), []);
});

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

test("Epode-managed ask once turns later responses into never ask", async () => {
  const lab = await startLabServer();
  try {
    const firstRun = lab.createRun({
      mode: "ask_once",
      consentOwner: "epode",
      placement: "response_body",
      copy: "full_schema",
      customerRef: "customer_approved",
    });
    const firstProduct = await (await fetch(firstRun.productUrl)).json();
    assert.equal(firstProduct._agentFeedback.mode, "ask_once");
    assert.equal(firstProduct._agentFeedback.consentManagedBy, "epode");

    const approved = await fetch(firstProduct._agentFeedback.submit.url, {
      method: "POST",
      headers: {
        authorization: firstProduct._agentFeedback.submit.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        summary: "The queue recommendation was useful and clear.",
        consent: {
          userApproved: true,
          approvalSource: "granted_now",
          consentScope: firstProduct._agentFeedback.consentScope,
        },
      }),
    });
    assert.equal(approved.status, 201);
    assert.equal(lab.getConsent("acme_queue", "customer_approved"), "approved");

    const secondRun = lab.createRun({
      mode: "ask_once",
      consentOwner: "epode",
      placement: "response_body",
      copy: "full_schema",
      customerRef: "customer_approved",
    });
    const secondProduct = await (await fetch(secondRun.productUrl)).json();
    assert.equal(secondProduct._agentFeedback.configuredMode, "ask_once");
    assert.equal(secondProduct._agentFeedback.mode, "never_ask");
    assert.equal(secondProduct._agentFeedback.consentRequired, false);

    const automatic = await fetch(secondProduct._agentFeedback.submit.url, {
      method: "POST",
      headers: {
        authorization: secondProduct._agentFeedback.submit.authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "The second queue recommendation was also useful." }),
    });
    assert.equal(automatic.status, 201);
    assert.equal(lab.getRun(secondRun.id).report.consent, undefined);

    const declinedRun = lab.createRun({
      mode: "ask_once",
      consentOwner: "epode",
      placement: "response_body",
      copy: "full_schema",
      customerRef: "customer_declined",
      preseedConsent: "declined",
    });
    const declinedProduct = await (await fetch(declinedRun.productUrl)).json();
    assert.equal(declinedProduct._agentFeedback, undefined);
  } finally {
    await lab.close();
  }
});

test("consent-only handoff records a decision before revealing the report contract", async () => {
  const lab = await startLabServer();
  try {
    const run = lab.createRun({
      mode: "ask_once",
      consentOwner: "epode",
      placement: "response_body",
      copy: "consent_only",
      customerRef: "customer_split_consent",
    });
    const product = await (await fetch(run.productUrl)).json();
    assert.equal(product._agentFeedback.state, "consent_required");
    assert.equal(product._agentFeedback.requiredAction.type, "ask_user");
    assert.equal(product._agentFeedback.submit, undefined);

    const action = product._agentFeedback.requiredAction.submitDecision;
    const decision = await fetch(action.url, {
      method: action.method,
      headers: {
        authorization: action.authorization,
        "content-type": action.contentType,
      },
      body: JSON.stringify({ decision: "approved" }),
    });
    assert.equal(decision.status, 200);
    const approved = await decision.json();
    assert.equal(approved.state, "approved");
    assert.equal(approved.feedback.mode, "never_ask");
    assert.equal(approved.feedback.consentRequired, false);

    const report = await fetch(approved.feedback.submit.url, {
      method: approved.feedback.submit.method,
      headers: {
        authorization: approved.feedback.submit.authorization,
        "content-type": approved.feedback.submit.contentType,
      },
      body: JSON.stringify({ summary: "The split consent flow produced a usable recommendation." }),
    });
    assert.equal(report.status, 201);
    assert.equal(lab.getConsent("acme_queue", "customer_split_consent"), "approved");
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
