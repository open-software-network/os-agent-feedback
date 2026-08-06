import assert from "node:assert/strict";
import test from "node:test";

process.env.LOCAL_DEMO = "true";

const { startServer } = await import("../examples/petsmart-demo/server.mjs");

const AGENT_UA = "ChatGPT-User/1.0";
const BROWSER_UA = "Mozilla/5.0";

async function fetchJson(base, path, userAgent = AGENT_UA) {
  const response = await fetch(`${base}${path}`, {
    headers: { "user-agent": userAgent },
  });
  const body = await response.json();
  return { response, body };
}

function choicePath(base, node, dimension, value, strength) {
  const groups = [
    ...(node.nextQuestion ? [node.nextQuestion] : []),
    ...(node.availableNeedEdges || []),
  ];
  for (const group of groups) {
    if (group.dimension !== dimension) continue;
    const choice = group.choices.find(
      (candidate) =>
        candidate.value === value && (strength === undefined || candidate.strength === strength),
    );
    if (choice) return choice.url.replace(base, "");
  }
  assert.fail(`no ${dimension}=${value} edge offered`);
}

function setCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""].filter(Boolean);
}

test("petsmart demo e2e: crawl → negotiate traits → decide → click → cookie drop", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    // Humans and crawlers get the PetSmart storefront, never agent JSON.
    for (const ua of [BROWSER_UA, "Googlebot/2.1", "GPTBot/1.0"]) {
      const home = await fetch(`${base}/`, { headers: { "user-agent": ua } });
      assert.equal(home.status, 200);
      assert.match(home.headers.get("content-type") ?? "", /text\/html/);
      const html = await home.text();
      assert.doesNotMatch(html, /agent-negotiate/);
      assert.match(html, /PetSmart|Pet<span/);
      assert.match(html, /Anything for Pets/);
      assert.match(html, /data-personalized="false"/);
      assert.equal(setCookies(home).length, 0, "the homepage must not drop cookies");
    }

    // The shopping agent receives the experience graph at the same URL.
    const agentHome = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } });
    assert.equal(agentHome.status, 200);
    const guide = await agentHome.text();
    assert.match(guide, /Agent experience guide/);
    const negotiateUrl = guide.match(
      /feeder: (http:\/\/127\.0\.0\.1:\d+\/agent-negotiate\/j-[a-f0-9-]+\/feeder)/i,
    )?.[1];
    assert.ok(negotiateUrl, "guide must include a concrete feeder negotiation URL");

    // Negotiate: two cats + a dog, one food-motivated, $200 target.
    let { response, body: node } = await fetchJson(base, negotiateUrl.replace(base, ""));
    assert.equal(response.status, 200);
    assert.equal(node.stage, "decision_input_required");
    assert.equal(node.nextQuestion.dimension, "decision_anchor");

    ({ body: node } = await fetchJson(base, choicePath(base, node, "decision_anchor", "pets")));
    assert.equal(node.needState.requestedDimension, "pets");
    ({ body: node } = await fetchJson(base, choicePath(base, node, "pets", "cats_and_dog")));
    assert.equal(node.stage, "express_more_or_decide");
    assert.equal(node.needState.values.pets.value, "cats_and_dog");
    ({ body: node } = await fetchJson(
      base,
      choicePath(base, node, "motivation", "one_food_motivated"),
    ));
    assert.equal(node.needState.values.motivation.value, "one_food_motivated");
    ({ body: node } = await fetchJson(base, choicePath(base, node, "budget", "200", "target")));
    assert.ok(node.resultsUrl);

    // Decide: the RFID multi-pet feeder is the only exact match.
    let decision;
    ({ response, body: decision } = await fetchJson(base, node.resultsUrl.replace(base, "")));
    assert.equal(response.status, 200);
    assert.equal(decision.stage, "decision_support");
    assert.equal(decision.exactMatchCount, 1);
    assert.equal(decision.exactMatches[0].itemId, "smarttag-rfid-multi-pet-feeder");
    assert.ok(decision.nearMissCount >= 4, "competing feeders must surface as near misses");

    // Item detail carries the ordinary product link for the user.
    const detailPath = decision.exactMatches[0].detailUrl.replace(base, "");
    const detail = await fetchJson(base, detailPath);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.itemId, "smarttag-rfid-multi-pet-feeder");
    const productLink = detail.body.humanProductLink?.url;
    assert.ok(productLink, "item detail must include the human product link");
    assert.match(productLink, /\/product\/smarttag-rfid-multi-pet-feeder\?journey=j-/);

    // The user's click drops the signed first-party visitor + session cookies.
    const click = await fetch(productLink, { headers: { "user-agent": BROWSER_UA } });
    assert.equal(click.status, 200);
    const clickCookies = setCookies(click);
    assert.ok(
      clickCookies.some((cookie) => cookie.startsWith("ps_visitor=")),
      "the product click must drop the visitor cookie",
    );
    assert.ok(
      clickCookies.some((cookie) => cookie.startsWith("ps_session=")),
      "the product click must drop the session cookie",
    );
    const pdpHtml = await click.text();
    assert.match(pdpHtml, /SmartTag RFID Multi-Pet Feeder/);
    assert.match(pdpHtml, /RFID collar-tag access control/);

    // A returning visitor with valid cookies keeps their identity.
    const cookie = clickCookies.map((entry) => entry.split(";")[0]).join("; ");
    const returnClick = await fetch(productLink, {
      headers: { "user-agent": BROWSER_UA, cookie },
    });
    assert.equal(returnClick.status, 200);
    assert.equal(
      setCookies(returnClick).length,
      0,
      "verified cookies must not be re-minted on return visits",
    );

    // Cart works offline; the outcome is only recorded against a live backend.
    const cart = await fetch(`${base}/api/cart`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ itemId: "smarttag-rfid-multi-pet-feeder" }),
    });
    assert.equal(cart.status, 201);
    const order = await cart.json();
    assert.match(order.orderId, /^order_/);
    assert.equal(order.recorded, false);
  } finally {
    await started.close();
  }
});

test("petsmart demo e2e: gating and counterfactuals stay honest", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    // Decisions without any decision input stay gated.
    const gated = await fetchJson(base, "/agent-decide/j-gated/feeder");
    assert.equal(gated.response.status, 422);
    assert.equal(gated.body.error, "decision_input_required");

    // A hard budget below every viable feeder produces counterfactuals.
    const impossible = await fetchJson(
      base,
      "/agent-decide/j-impossible/feeder/pets-cats-and-dog/motivation-one-food-motivated/budget-hard-50",
    );
    assert.equal(impossible.response.status, 200);
    assert.equal(impossible.body.exactMatchCount, 0);
    assert.ok(impossible.body.counterfactuals.length > 0);
    assert.match(impossible.body.counterfactuals[0].change, /raise_budget/);

    // Unknown items 404 with the catalog surfaced.
    const missing = await fetchJson(base, "/agent-item/j-missing?item_id=unknown-item");
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, "item_not_found");
  } finally {
    await started.close();
  }
});
