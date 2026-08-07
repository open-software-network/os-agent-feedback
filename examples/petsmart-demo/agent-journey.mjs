#!/usr/bin/env node

/**
 * Plays the full PetSmart demo journey against a running petsmart-demo server:
 *
 *   1. A shopping agent (ChatGPT/Claude) crawls the storefront and receives
 *      the faceted agent storefront — plain HTML whose links ARE the
 *      experience graph, plus the structured JSON negotiation entry.
 *   2. It negotiates the household's needs: two cats and a dog, one of them
 *      strongly food-motivated, with a target budget.
 *   3. The graph ranks the SmartTag RFID Multi-Pet Feeder as the only exact
 *      match and hands back an ordinary product link for the user.
 *   4. The user clicks the link: the merchant drops its signed first-party
 *      visitor + session cookies and links them to the agent journey.
 *   5. The agent reads the customer-context contract embedded in the product
 *      page, obtains permission, and submits the household traits as signals.
 *   6. On the next visit the shopper is discoverable: the homepage greets the
 *      household, features the feeder, and records a personalization decision.
 *   7. Add-to-cart records a conversion outcome against that decision.
 *
 * Usage: node agent-journey.mjs [--base http://127.0.0.1:4320]
 */

const AGENT_UA = "ChatGPT-User/1.0";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const baseFlag = process.argv.indexOf("--base");
const base = (
  (baseFlag > -1 && process.argv[baseFlag + 1]) ||
  process.env.PETSMART_DEMO_URL ||
  "http://127.0.0.1:4320"
).replace(/\/$/, "");

function step(title) {
  console.log(`\n▸ ${title}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function agentJson(url) {
  const response = await fetch(url, { headers: { "user-agent": AGENT_UA } });
  const body = await response.json();
  if (!response.ok) fail(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function choiceUrl(node, dimension, value, strength) {
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
    if (choice) return choice.url;
  }
  fail(`No ${dimension}=${value} edge offered by the merchant graph`);
}

function decodeContextMarker(html) {
  const match = html.match(/<meta name="epode-customer-context" content="([^"]+)">/);
  if (!match) return undefined;
  const decoded = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  return decoded?._epode?.customerContext;
}

function cookiesFrom(response) {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") || ""];
  return ["ps_visitor", "ps_session"]
    .map((name) => {
      const match = setCookies.join(",").match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
      return match ? `${name}=${match[1]}` : "";
    })
    .filter(Boolean)
    .join("; ");
}

step(`Agent crawls ${base}/ and receives the faceted agent storefront`);
const guideResponse = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } });
const guide = await guideResponse.text();
const negotiateUrl = guide.match(/feeder: (\S+\/agent-negotiate\/j-[a-z0-9-]+\/feeder)/i)?.[1];
if (!negotiateUrl) fail("The agent storefront did not include a feeder negotiation URL");
console.log(`  entry: ${negotiateUrl}`);

step("Agent negotiates the household's needs through merchant-supplied edges");
let node = await agentJson(negotiateUrl);
node = await agentJson(choiceUrl(node, "decision_anchor", "pets"));
node = await agentJson(choiceUrl(node, "pets", "cats_and_dog"));
console.log("  expressed: two cats + a dog share the home");
node = await agentJson(choiceUrl(node, "motivation", "one_food_motivated"));
console.log("  expressed: one pet is highly food-motivated");
node = await agentJson(choiceUrl(node, "budget", "200", "target"));
console.log("  expressed: $200 preferred target");
if (!node.resultsUrl) fail("The negotiation never reached a decidable state");

step("Merchant ranks the catalog against the expressed needs");
const decision = await agentJson(node.resultsUrl);
if (decision.exactMatchCount !== 1) {
  fail(`Expected exactly one exact match, saw ${decision.exactMatchCount}`);
}
const match = decision.exactMatches[0];
console.log(
  `  exact match: ${match.title} ($${match.price.amount}) — ${decision.nearMissCount} near misses with evidence`,
);

step("Agent opens the item detail and receives the human product link");
const detail = await agentJson(match.detailUrl);
const productLink = detail.humanProductLink?.url;
if (!productLink) fail("Item detail did not include a human product link");
console.log(`  product link: ${productLink}`);

step("User clicks the product link — first-party cookie + session drop");
const clickResponse = await fetch(productLink, { headers: { "user-agent": BROWSER_UA } });
const productHtml = await clickResponse.text();
const cookie = cookiesFrom(clickResponse);
if (!cookie.includes("ps_visitor=")) fail("The product page did not drop the visitor cookie");
if (!cookie.includes("ps_session=")) fail("The product page did not drop the session cookie");
const visitorId = cookie.match(/ps_visitor=([^.;]+)/)?.[1];
console.log(`  visitor: ${visitorId}`);
console.log(`  session: ${cookie.match(/ps_session=([^.;]+)/)?.[1]}`);

const contract = decodeContextMarker(productHtml);
if (!contract) {
  console.log(
    "\n  The product page carried no customer-context contract — the server is running" +
      "\n  without EPODE_API_KEY (offline mode). Crawl, ranking, and cookie drop verified;" +
      "\n  start the server against a live backend to complete the discoverability loop.",
  );
  process.exit(0);
}

let submitAction = contract.submit;
if (!submitAction) {
  // Older backends gate submission on a consent decision through the relay.
  step("Agent obtains permission through the merchant's same-origin relay");
  if (contract.state !== "consent_required") fail(`Unexpected contract state: ${contract.state}`);
  const consentResponse = await fetch(`${base}${contract.consent.url}`, {
    method: "POST",
    headers: {
      authorization: contract.consent.authorization,
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ decision: "approved" }),
  });
  const consent = await consentResponse.json();
  if (!consentResponse.ok || consent.state !== "answer_ready") {
    fail(`Consent failed: HTTP ${consentResponse.status} ${JSON.stringify(consent)}`);
  }
  submitAction = consent.submit;
}
console.log(`  identity level: ${contract.identityLevel}`);

step("Agent submits the household traits it learned during the task");
const catalog = submitAction.bodySchema?.items?.catalog || [];
const wanted = [
  { key: "pet.household_mix", value: "cats_and_dog", provenance: "agent_reports_user_statement" },
  {
    key: "pet.food_motivation",
    value: "one_food_motivated",
    provenance: "agent_reports_user_statement",
  },
  { key: "pet.life_stage", value: "adult", provenance: "agent_reports_current_task" },
  { key: "shopping.budget_band", value: "150_500", provenance: "agent_reports_current_task" },
];
const items = wanted.flatMap((item) => {
  const field = catalog.find((entry) => entry.key === item.key);
  if (!field || !field.allowedValues?.includes(item.value)) return [];
  return [
    {
      key: item.key,
      type: field.type,
      value: item.value,
      provenance: item.provenance,
      confidence: 1,
      remember: true,
    },
  ];
});
if (items.length < 3) {
  fail(
    `The product's context-field catalog is missing the pet fields (found ${items.length}); ` +
      "run node provision-fields.mjs against the same backend first",
  );
}
const answerResponse = await fetch(`${base}${submitAction.url}`, {
  method: "POST",
  headers: {
    authorization: submitAction.authorization,
    "content-type": "application/json",
    cookie,
  },
  body: JSON.stringify({ status: "answered", items }),
});
const answer = await answerResponse.json();
if (!answerResponse.ok || !answer.accepted) {
  fail(`Answer rejected: HTTP ${answerResponse.status} ${JSON.stringify(answer)}`);
}
console.log(
  `  accepted signals: ${answer.signals.map((signal) => `${signal.key}=${signal.value}`).join(", ")}`,
);

step("Return visit — the shopper is now discoverable");
const returnResponse = await fetch(`${base}/`, {
  headers: { "user-agent": BROWSER_UA, cookie },
});
const returnHtml = await returnResponse.text();
if (!returnHtml.includes('data-personalized="true"')) {
  fail("The homepage did not personalize for the returning visitor");
}
const decisionId = returnHtml.match(/data-decision-id="([^"]+)"/)?.[1];
console.log(`  personalized hero shown; decision ${decisionId || "(not recorded)"}`);

step("User adds the feeder to the cart — conversion outcome recorded");
const cartResponse = await fetch(`${base}/api/cart`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ itemId: match.itemId }),
});
const cart = await cartResponse.json();
if (!cartResponse.ok) fail(`Cart failed: HTTP ${cartResponse.status} ${JSON.stringify(cart)}`);
console.log(`  order ${cart.orderId} (outcome recorded: ${cart.recorded})`);

console.log(
  `\n✓ Journey complete.\n\n${JSON.stringify(
    {
      journey: negotiateUrl.match(/\/(j-[a-z0-9-]+)\//)?.[1],
      visitor: visitorId,
      recommended: match.itemId,
      signals: answer.signals.length,
      decisionId,
      outcome: cart.recorded ? "conversion" : "not recorded",
    },
    null,
    2,
  )}\n\nOpen the dashboard: the session timeline shows the agent journey, the\ncustomer view shows the pet-household traits, and Data destinations can\nstream the same signals to the warehouse.`,
);
