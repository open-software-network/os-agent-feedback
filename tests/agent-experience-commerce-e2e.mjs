import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "../examples/agent-experience-commerce/server.mjs";

const AGENT_UA = "Claude-User/1.0";
const BROWSER_UA = "Mozilla/5.0";

async function fetchJson(base, path, userAgent = AGENT_UA) {
  const response = await fetch(`${base}${path}`, {
    headers: { "user-agent": userAgent },
  });
  const body = await response.json();
  return { response, body };
}

test("agent experience commerce e2e: guide → negotiate → decide → detail", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const browserHome = await fetch(`${base}/`, {
      headers: { "user-agent": BROWSER_UA },
    });
    assert.equal(browserHome.status, 200);
    assert.match(browserHome.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await browserHome.text(), /Fieldnote Supply/);

    const agentHome = await fetch(`${base}/`, {
      headers: { "user-agent": AGENT_UA },
    });
    assert.equal(agentHome.status, 200);
    const guide = await agentHome.text();
    assert.match(guide, /Agent experience guide/);
    const lampUrl = guide.match(/lamp: (http:\/\/127\.0\.0\.1:\d+\/agent-negotiate\/j-[a-f0-9-]+\/lamp)/i)?.[1];
    assert.ok(lampUrl, "guide must include a concrete lamp negotiation URL");

    const journeyPath = lampUrl.replace(base, "");
    let { response, body: node } = await fetchJson(base, journeyPath);
    assert.equal(response.status, 200);
    assert.equal(node.stage, "decision_input_required");
    assert.equal(node.nextQuestion.dimension, "decision_anchor");
    assert.equal(node.resultsUrl, null);

    const budgetConsider = node.nextQuestion.choices.find((choice) => choice.value === "budget");
    ({ response, body: node } = await fetchJson(base, budgetConsider.url.replace(base, "")));
    assert.equal(node.needState.requestedDimension, "budget");
    assert.equal(node.nextQuestion.dimension, "budget");

    const hard150 = node.nextQuestion.choices.find((choice) => choice.value === "150" && choice.strength === "hard");
    ({ response, body: node } = await fetchJson(base, hard150.url.replace(base, "")));
    assert.equal(node.stage, "express_more_or_decide");
    assert.equal(node.needState.values.budget.value, "150");
    assert.equal(node.needState.values.budget.strength, "hard");
    assert.match(node.resultsUrl, /\/agent-decide\//);

    // Continue with purpose and preferred color before deciding.
    const purposeChoice = node.availableNeedEdges
      .find((group) => group.dimension === "purpose")
      .choices.find((choice) => choice.value === "coding");
    ({ response, body: node } = await fetchJson(base, purposeChoice.url.replace(base, "")));
    assert.equal(node.needState.values.purpose.value, "coding");

    const colorChoice = node.availableNeedEdges
      .find((group) => group.dimension === "color")
      .choices.find((choice) => choice.value === "orange" && choice.strength === "preference");
    ({ response, body: node } = await fetchJson(base, colorChoice.url.replace(base, "")));
    assert.equal(node.needState.values.color.value, "orange");
    assert.equal(node.needState.values.color.strength, "preference");
    assert.ok(node.resultsUrl);

    ({ response, body: node } = await fetchJson(base, node.resultsUrl.replace(base, "")));
    assert.equal(response.status, 200);
    assert.equal(node.stage, "decision_support");
    assert.equal(node.exactMatchCount, 1);
    assert.equal(node.exactMatches[0].itemId, "focus-grid-desk-lamp");
    assert.deepEqual(node.counterfactuals, []);

    const detailPath = node.exactMatches[0].detailUrl.replace(base, "");
    const detail = await fetchJson(base, detailPath);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.itemId, "focus-grid-desk-lamp");
    assert.equal(detail.body.catalog.price.amount, 129);
    assert.ok(
      detail.body.catalog.matches.purpose.includes("coding"),
      "detail must preserve catalog purpose parity",
    );

    // Zero-match path returns counterfactuals only when hard constraints fail.
    const impossible = await fetchJson(
      base,
      `/agent-decide/${node.journeyId}/lamp/budget-hard-150/purpose-photography/color-require-black`,
    );
    assert.equal(impossible.response.status, 200);
    assert.equal(impossible.body.exactMatchCount, 0);
    assert.ok(impossible.body.counterfactuals.length > 0);

    // Decision without input stays gated.
    const gated = await fetchJson(base, `/agent-decide/${node.journeyId}/lamp`);
    assert.equal(gated.response.status, 422);
    assert.equal(gated.body.error, "decision_input_required");
  } finally {
    await started.close();
  }
});

test("agent experience commerce e2e: crawlers and browsers never receive agent JSON at /", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;
  try {
    for (const ua of [BROWSER_UA, "Googlebot/2.1", "GPTBot/1.0"]) {
      const response = await fetch(`${base}/`, { headers: { "user-agent": ua } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      const body = await response.text();
      assert.doesNotMatch(body, /agent-negotiate/);
      assert.match(body, /Fieldnote Supply/);
    }
  } finally {
    await started.close();
  }
});
