import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

process.env.LOCAL_DEMO = "true";

const { startServer } = await import("../examples/petsmart-demo/server.mjs");

const AGENT_UA = "ChatGPT-User/1.0";
const BROWSER_UA = "Mozilla/5.0";
const COMPACT_RENDER_JOURNEY_RE = /^w-[A-Za-z0-9_-]{22}$/;
const NAV_HEADERS = {
  "user-agent": BROWSER_UA,
  "sec-fetch-user": "?1",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

function navigate(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { ...NAV_HEADERS, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: {
            get(name) {
              const value = response.headers[String(name).toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : (value ?? null);
            },
            getSetCookie() {
              return response.headers["set-cookie"] || [];
            },
          },
          text: async () => body,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

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

function listingUrls(html, base) {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => new URL(match[1].replaceAll("&amp;", "&"), base))
    .filter(({ pathname }) =>
      [
        /^\/feeders$/,
        /^\/shop\/automatic-feeders\/[^/]+\/[^/]+(?:\/product\/[^/]+)?$/,
        /^\/s\/[^/]+(?:\/product\/[^/]+)?$/,
        /^\/c\/[^/]+\/product\/[^/]+$/,
        /^\/p\/[^/]+\/[^/]+$/,
        /^\/product\/[^/]+$/,
      ].some((pattern) => pattern.test(pathname)),
    );
}

function listingJourney(url) {
  const queryJourney = url.searchParams.get("journey");
  if (queryJourney) return queryJourney;
  const pathJourney = url.pathname.match(/^\/(?:shop\/automatic-feeders|p)\/([^/]+)/)?.[1];
  return pathJourney ? decodeURIComponent(pathJourney) : undefined;
}

function assertOneListingJourney(html, base, label) {
  const urls = listingUrls(html, base);
  assert.ok(urls.length > 0, `${label} must expose listing links`);
  const journeys = urls.map((url) => listingJourney(url));
  assert.ok(
    journeys.every(Boolean),
    `${label} has a clean listing URL: ${urls.find((url) => !listingJourney(url))}`,
  );
  assert.equal(new Set(journeys).size, 1, `${label} must use exactly one journey value per render`);
  assert.match(journeys[0], COMPACT_RENDER_JOURNEY_RE, `${label} journey must be compact`);
  assert.equal(journeys[0].length, 24, `${label} journey must have 24 visible characters`);
  return journeys[0];
}

test("petsmart demo e2e: crawl → negotiate traits → decide → click → cookie drop", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    // Humans and crawlers get the PetSmart storefront, never agent JSON.
    for (const ua of [BROWSER_UA, "Googlebot/2.1", "GPTBot/1.0", "UnknownFetcher/1.0"]) {
      const home = await fetch(`${base}/`, { headers: { "user-agent": ua } });
      assert.equal(home.status, 200);
      assert.match(home.headers.get("content-type") ?? "", /text\/html/);
      const html = await home.text();
      assert.doesNotMatch(html, /agent-negotiate/);
      assert.match(html, /PetSmart|Pet<span/);
      assert.match(html, /Anything for Pets/);
      assert.match(html, /data-personalized="false"/);
      // Work-mode cloud browsers browse the human storefront with a real
      // Chrome UA, so the human page carries the same situation links and one
      // public-provenance signed journey through every listing edge.
      assert.match(html, /Shop by situation/);
      assert.match(html, /\/s\/multiple-cats-one-steals-food-under-200/);
      assert.match(html, /href="\/agent-experience\.json"/);
      assert.doesNotMatch(html, /\/shop\/automatic-feeders\//);
      const renderJourney = assertOneListingJourney(html, base, `human root for ${ua}`);
      assert.match(
        html,
        /<details class="treats assistant-note">\s*<summary>For AI shopping assistants<\/summary>/,
      );
      assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
      assert.match(html, /budget=&lt;2-5 digit USD amount&gt;/);
      assert.match(html, /budget_kind=&lt;hard\|target&gt;/);
      assert.match(html, /Requests that reuse one <code>journey<\/code> value stay one errand/);
      assert.ok(html.includes(`journey=${renderJourney}`));
      assert.equal(setCookies(home).length, 0, "the homepage must not drop cookies");
    }

    const publicGraphEntry = await fetch(`${base}/agent-experience.json`, {
      headers: { "user-agent": BROWSER_UA },
    });
    assert.match(publicGraphEntry.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(setCookies(publicGraphEntry).length, 0);
    const publicGraph = await publicGraphEntry.json();
    assert.equal(publicGraph.stage, "decision_input_required");
    assert.match(
      publicGraph.nextQuestion.choices[0].url,
      /\/agent-negotiate\/w-[A-Za-z0-9_-]{22}\/feeder\//,
    );

    const secureLanding = await navigate(`${base}/s/multiple-cats-one-steals-food-under-200`, {
      "x-forwarded-proto": "https",
    });
    assert.ok(
      setCookies(secureLanding).every((cookie) => /; Secure(?:;|$)/.test(cookie)),
      "browser-facing HTTPS must add Secure to every first-party cookie",
    );

    // The shopping agent receives the faceted storefront at the same URL:
    // plain HTML whose anchors ARE the experience graph.
    const agentHome = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } });
    assert.equal(agentHome.status, 200);
    assert.match(agentHome.headers.get("content-type") ?? "", /text\/html/);
    const guide = await agentHome.text();
    assertOneListingJourney(guide, base, "ChatGPT root");
    // ChatGPT gets the exact faceted-query grammar proven in PR #119: the
    // anchor itself exposes the need dimensions while carrying a signed
    // journey capability. Other agents can keep the shorter signed paths.
    assert.match(
      guide,
      /href="http:\/\/127\.0\.0\.1:\d+\/feeders\?pets=multiple_cats&motivation=one_food_motivated&budget=200&journey=w-[A-Za-z0-9_-]{22}"/,
    );
    // Prices at root guarantee a correct one-fetch answer; stock lives only
    // behind the situation pages (the value asymmetry that earns the tokened
    // second fetch).
    assert.match(guide, /\$189\.99/);
    assert.doesNotMatch(guide, /in stock/i);
    assert.ok(
      guide.indexOf("Start here — live availability by situation") < guide.indexOf("Full catalog"),
    );
    assert.match(
      guide,
      /href="[^"]+\/product\/smarttag-rfid-multi-pet-feeder\?journey=w-[A-Za-z0-9_-]{22}"/,
    );
    assert.doesNotMatch(guide, /Agent clients|When you recommend|you must/i);

    const kimiHome = await fetch(`${base}/`, { headers: { "user-agent": "KimiBot/1.0" } });
    const kimiGuide = await kimiHome.text();
    assertOneListingJourney(kimiGuide, base, "Kimi root");
    assert.match(kimiGuide, /agent-negotiate/);
    assert.match(kimiGuide, /\$189\.99/);

    // The structured JSON negotiation graph stays for API-capable agents.
    const negotiateUrl = guide.match(
      /feeder: (http:\/\/127\.0\.0\.1:\d+\/agent-negotiate\/w-[A-Za-z0-9_-]{22}\/feeder)/,
    )?.[1];
    assert.ok(negotiateUrl, "the agent storefront must keep the JSON negotiation entry URL");
    const graphJourneyCapability = new URL(negotiateUrl).pathname.split("/")[2];

    // Gemini's live user-triggered fetcher sends the literal UA "Google".
    // It gets the same journey-carrying anchors, but product details stay
    // behind the exact-situation page so it cannot stop after one fetch.
    const geminiHome = await fetch(`${base}/`, { headers: { "user-agent": "Google" } });
    const geminiGuide = await geminiHome.text();
    assertOneListingJourney(geminiGuide, base, "Gemini root");
    assert.match(
      geminiGuide,
      /\/shop\/automatic-feeders\/w-[A-Za-z0-9_-]{22}\/multiple-cats-food-stealing-under-200/,
    );
    assert.match(geminiGuide, /Product names, exact fit evidence, live stock/);
    assert.doesNotMatch(geminiGuide, /\$189\.99/);

    const claudeHome = await fetch(`${base}/`, {
      headers: { "user-agent": "Claude-User/1.0" },
    });
    const claudeGuide = await claudeHome.text();
    assertOneListingJourney(claudeGuide, base, "Claude root");
    assert.match(claudeGuide, /\$189\.99/);
    assert.match(claudeGuide, /one-cat-scheduled-portions-under-90/);
    assert.doesNotMatch(claudeGuide, /href="[^"]+\/product\/smarttag-rfid-multi-pet-feeder/);

    const metaHome = await fetch(`${base}/`, {
      headers: { "user-agent": "meta-externalfetcher/1.1" },
    });
    const metaGuide = await metaHome.text();
    assertOneListingJourney(metaGuide, base, "Meta agent root");
    assert.match(
      metaGuide,
      /\/shop\/automatic-feeders\/w-[A-Za-z0-9_-]{22}\/multiple-cats-food-stealing-under-200/,
    );
    assert.match(metaGuide, /agent-negotiate/);

    const metaIndexerHome = await fetch(`${base}/`, {
      headers: {
        "user-agent":
          "meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
      },
    });
    const metaIndexerGuide = await metaIndexerHome.text();
    assertOneListingJourney(metaIndexerGuide, base, "Meta indexer root");
    assert.match(metaIndexerGuide, /\/s\/multiple-cats-one-steals-food-under-200/);
    assert.doesNotMatch(metaIndexerGuide, /\/shop\/automatic-feeders\//);
    assert.doesNotMatch(metaIndexerGuide, /agent-negotiate/);
    assert.match(metaIndexerGuide, /\$189\.99/);

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
    const decisionResult = await fetchJson(base, node.resultsUrl.replace(base, ""));
    response = decisionResult.response;
    const decision = decisionResult.body;
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
    assert.match(
      productLink,
      /\/c\/[^/]+\.[A-Za-z0-9_-]+\/product\/smarttag-rfid-multi-pet-feeder/,
    );
    assert.equal(
      new URL(productLink).searchParams.get("journey"),
      graphJourneyCapability,
      "the shopper PDP must retain the render journey",
    );

    const tamperedNeedLink = new URL(productLink);
    const needSegments = tamperedNeedLink.pathname.split("/");
    needSegments[2] = needSegments[2].replace(/.$/, (last) => (last === "a" ? "b" : "a"));
    tamperedNeedLink.pathname = needSegments.join("/");
    assert.equal(
      (await navigate(tamperedNeedLink)).status,
      404,
      "a caller cannot forge durable need facets",
    );

    // The user's click drops the signed first-party visitor + session cookies.
    const click = await navigate(productLink);
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
    const returnClick = await navigate(productLink, { cookie });
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

test("personalized hero retains the render journey on its PDP edge", async () => {
  const calls = { context: 0, personalization: 0 };
  const customer = (_request, _response, next) => next();
  customer.context = {
    get: async ({ anonymousRef, purpose }) => {
      calls.context += 1;
      assert.match(anonymousRef, /^psv_/);
      assert.equal(purpose, "product_personalization");
      return {
        available: true,
        retrievalId: "ctx-personalized-hero",
        items: [
          {
            key: "pet.household_mix",
            value: "multiple_cats",
            signalId: "signal-household",
          },
          {
            key: "pet.food_motivation",
            value: "one_food_motivated",
            signalId: "signal-motivation",
          },
        ],
      };
    },
  };
  customer.personalization = {
    decide: async ({ contextRetrievalId, signalIds, variant }) => {
      calls.personalization += 1;
      assert.equal(contextRetrievalId, "ctx-personalized-hero");
      assert.deepEqual(signalIds, ["signal-household", "signal-motivation"]);
      assert.equal(variant, "pet-household-hero-v1");
      return { recorded: true, decision: { id: "decision-personalized-hero" } };
    },
  };
  customer.outcomes = { track: async () => ({ recorded: true }) };

  const started = await startServer(0, { customer });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const home = await navigate(`${base}/`, {
      referer: "https://chatgpt.com/c/personalized-hero-test",
    });
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /data-personalized="true"/);
    assert.match(html, /data-decision-id="decision-personalized-hero"/);
    const renderJourney = assertOneListingJourney(html, base, "personalized human root");
    const heroProductUrl = html.match(/<a href="([^"]+)">Meet the SmartTag RFID Feeder<\/a>/)?.[1];
    assert.ok(heroProductUrl, "personalized hero must expose its PDP edge");
    assert.equal(listingJourney(new URL(heroProductUrl, base)), renderJourney);
    assert.deepEqual(calls, { context: 1, personalization: 1 });
  } finally {
    await started.close();
  }
});

test("petsmart demo e2e: gating and counterfactuals stay honest", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const guide = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } }).then((r) =>
      r.text(),
    );
    const journeyCapability = guide.match(/agent-negotiate\/(w-[A-Za-z0-9_-]{22})\/feeder/)?.[1];
    assert.ok(journeyCapability, "the agent root must issue a journey before graph traversal");

    // Decisions without any decision input stay gated.
    const gated = await fetchJson(base, `/agent-decide/${journeyCapability}/feeder`);
    assert.equal(gated.response.status, 422);
    assert.equal(gated.body.error, "decision_input_required");

    // A hard budget below every viable feeder produces counterfactuals.
    const impossible = await fetchJson(
      base,
      `/agent-decide/${journeyCapability}/feeder/pets-cats-and-dog/motivation-one-food-motivated/budget-hard-50`,
    );
    assert.equal(impossible.response.status, 200);
    assert.equal(impossible.body.exactMatchCount, 0);
    assert.ok(impossible.body.counterfactuals.length > 0);
    assert.match(impossible.body.counterfactuals[0].change, /raise_budget/);

    // Unknown items 404 with the catalog surfaced.
    const missing = await fetchJson(base, `/agent-item/${journeyCapability}?item_id=unknown-item`);
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, "item_not_found");
  } finally {
    await started.close();
  }
});

test("signed graph capabilities survive a restart or another server instance", async () => {
  const firstModule = await import("../examples/petsmart-demo/server.mjs?capability-instance-a");
  const secondModule = await import("../examples/petsmart-demo/server.mjs?capability-instance-b");
  const first = await firstModule.startServer(0);
  const second = await secondModule.startServer(0);
  const firstBase = `http://127.0.0.1:${first.port}`;
  const secondBase = `http://127.0.0.1:${second.port}`;

  try {
    const guide = await fetch(`${firstBase}/`, { headers: { "user-agent": AGENT_UA } }).then((r) =>
      r.text(),
    );
    const negotiationPath = guide.match(
      /feeder: http:\/\/127\.0\.0\.1:\d+(\/agent-negotiate\/w-[A-Za-z0-9_-]{22}\/feeder)/,
    )?.[1];
    assert.ok(negotiationPath, "the first instance must publish a signed graph entry");

    const resumed = await fetchJson(secondBase, negotiationPath);
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.body.stage, "decision_input_required");
    assert.match(resumed.body.nextQuestion.choices[0].url, new RegExp(`^${secondBase}/`));
  } finally {
    await first.close();
    await second.close();
  }
});

test("compatibility lab isolates every page-shape method behind LOCAL_DEMO", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const full = await fetch(`${base}/lab/full`).then((response) => response.text());
    assert.match(full, /Full catalog/);
    assert.match(full, /\/shop\/automatic-feeders\/w-[A-Za-z0-9_-]{22}\//);
    assertOneListingJourney(full, base, "full compatibility lab");

    const linkFirst = await fetch(`${base}/lab/link-first`).then((response) => response.text());
    assert.match(linkFirst, /Product names, exact fit evidence, live stock/);
    assert.doesNotMatch(linkFirst, /\$189\.99/);
    assertOneListingJourney(linkFirst, base, "link-first compatibility lab");

    const linkFirstQuery = await fetch(`${base}/lab/link-first-query`).then((response) =>
      response.text(),
    );
    assert.doesNotMatch(linkFirstQuery, /<h2>Full catalog<\/h2>/);
    assert.match(
      linkFirstQuery,
      /\/feeders\?pets=multiple_cats&motivation=one_food_motivated&budget=90&journey=/,
    );
    assertOneListingJourney(linkFirstQuery, base, "link-first query compatibility lab");

    const facetsFirstQuery = await fetch(`${base}/lab/facets-first-query`).then((response) =>
      response.text(),
    );
    assert.match(facetsFirstQuery, /<h2>Full catalog<\/h2>/);
    assert.ok(
      facetsFirstQuery.indexOf("Live availability — by situation") <
        facetsFirstQuery.indexOf("Full catalog"),
    );
    assert.match(
      facetsFirstQuery,
      /\/feeders\?pets=multiple_cats&motivation=one_food_motivated&budget=90&journey=/,
    );
    assertOneListingJourney(facetsFirstQuery, base, "facets-first compatibility lab");

    const legacy = await fetch(`${base}/lab/legacy-query`).then((response) => response.text());
    assert.match(legacy, /\/feeders\?pets=multiple_cats&amp;motivation=one_food_motivated/);
    assert.match(legacy, /journey=w-[A-Za-z0-9_-]{22}/);
    assertOneListingJourney(legacy, base, "legacy query compatibility lab");

    const stable = await fetch(`${base}/lab/stable-public`).then((response) => response.text());
    assert.match(stable, /\/s\/multiple-cats-one-steals-food-under-200/);
    assert.doesNotMatch(stable, /\/shop\/automatic-feeders\//);
    assertOneListingJourney(stable, base, "stable public compatibility lab");

    const human = await fetch(`${base}/lab/human`).then((response) => response.text());
    assert.match(human, /data-personalized="false"/);
    assert.match(human, /Shop by situation/);
    assertOneListingJourney(human, base, "human compatibility lab");

    const plainResponse = await fetch(`${base}/lab/plain-text`);
    assert.match(plainResponse.headers.get("content-type") || "", /text\/plain/);
    const plainText = await plainResponse.text();
    assert.match(plainText, /\/s\/multiple-cats-one-steals-food-under-200/);
    assert.match(plainText, /[?&]journey=w-[A-Za-z0-9_-]{22}/);

    const graphResponse = await fetch(`${base}/lab/json-graph`);
    assert.match(graphResponse.headers.get("content-type") || "", /application\/json/);
    const graphNode = await graphResponse.json();
    assert.match(graphNode.nextQuestion.choices[0].url, /\/agent-negotiate\/w-[A-Za-z0-9_-]{22}\//);
  } finally {
    await started.close();
  }
});

test("petsmart demo: robots.txt stays permissive for assistant preflight checks", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    // Chat-mode assistants check robots.txt before opening any link, and
    // work-mode cloud browsers respect a disallow outright.
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    const body = await robots.text();
    assert.match(body, /User-agent: \*/);
    assert.match(body, /Allow: \//);
    assert.doesNotMatch(body, /Disallow/);
  } finally {
    await started.close();
  }
});

test("request diagnostics bound headers and redact journey capabilities and queries", async () => {
  process.env.PETSMART_REQUEST_LOG = "1";
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  const loggingModule = await import("../examples/petsmart-demo/server.mjs?request-log-redaction");
  const started = await loggingModule.startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const guide = await fetch(`${base}/`, {
      headers: { "user-agent": "meta-externalfetcher/1.1" },
    }).then((r) => r.text());
    const situationUrl = guide.match(
      /href="(http:\/\/127\.0\.0\.1:\d+\/shop\/automatic-feeders\/w-[A-Za-z0-9_-]{22}\/multiple-cats-food-stealing-under-200)"/,
    )?.[1];
    assert.ok(situationUrl);
    const queryCapability = new URL(situationUrl).pathname.split("/")[3];
    await fetch(`${situationUrl}?email=private%40example.com&journey=${queryCapability}`, {
      headers: { "user-agent": `Google ${"x".repeat(300)}` },
    });
  } finally {
    await started.close();
    console.log = originalLog;
    delete process.env.PETSMART_REQUEST_LOG;
  }

  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const situationEntry = entries.find((entry) =>
    entry.path?.startsWith("/shop/automatic-feeders/"),
  );
  assert.equal(
    situationEntry.path,
    "/shop/automatic-feeders/:journey/multiple-cats-food-stealing-under-200",
  );
  assert.equal(situationEntry.query, "?email=%3Avalue&journey=%3Ajourney");
  assert.doesNotMatch(JSON.stringify(situationEntry), /private|j-[a-f0-9-]+\./);
  assert.doesNotMatch(JSON.stringify(situationEntry), /w-[A-Za-z0-9_-]{22}/);
  assert.equal(situationEntry.userAgent.length, 160);
});

const batchSchema = JSON.parse(
  await readFile(new URL("../protocol/v1/telemetry-batch.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateBatch = ajv.compile(batchSchema);

function startCollector() {
  const batches = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/api/v2/telemetry/batches") {
        const parsed = JSON.parse(body);
        batches.push(parsed);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: parsed.events.length, dropped: 0 }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        batches,
        port: server.address().port,
        close: () => new Promise((closeResolve) => server.close(closeResolve)),
      });
    });
  });
}

function collectedEvents(batches) {
  return batches.flatMap((batch) => batch.events);
}

async function waitForEvents(batches, predicate, deadlineMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate(collectedEvents(batches))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `telemetry deadline: only saw ${JSON.stringify(collectedEvents(batches), null, 2)}`,
  );
}

test("petsmart demo telemetry: hops carry experience payloads, vendor hints, and one handoff name", async () => {
  const collector = await startCollector();
  process.env.EPODE_API_KEY =
    "af_live_0123456789abcdef0123456789abcdef_secretsecretsecretsecretsecretse";
  process.env.EPODE_API_URL = `http://127.0.0.1:${collector.port}`;
  const telemetryServer = await import("../examples/petsmart-demo/server.mjs?telemetry-e2e");
  const started = await telemetryServer.startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const guide = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } }).then((r) =>
      r.text(),
    );
    const negotiateUrl = guide.match(
      /feeder: (http:\/\/127\.0\.0\.1:\d+\/agent-negotiate\/w-[A-Za-z0-9_-]{22}\/feeder)/,
    )?.[1];
    assert.ok(negotiateUrl, "guide must include a feeder negotiation URL");

    let { body: node } = await fetchJson(base, negotiateUrl.replace(base, ""));
    ({ body: node } = await fetchJson(base, choicePath(base, node, "decision_anchor", "pets")));
    ({ body: node } = await fetchJson(base, choicePath(base, node, "pets", "cats_and_dog")));
    ({ body: node } = await fetchJson(
      base,
      choicePath(base, node, "motivation", "one_food_motivated"),
    ));
    const suggestedBudgetPath = choicePath(base, node, "budget", "200", "target");
    const exactBudgetPath = suggestedBudgetPath.replace(/budget-target-200$/, "budget-target-137");
    ({ body: node } = await fetchJson(base, exactBudgetPath));
    assert.equal(node.needState.values.budget.value, "137");
    assert.ok(node.resultsUrl);

    const { body: decision } = await fetchJson(base, node.resultsUrl.replace(base, ""));
    assert.equal(decision.exactMatchCount, 1);
    const detailUrl = new URL(decision.exactMatches[0].detailUrl);
    assert.match(detailUrl.searchParams.get("ctx"), /(?:^|\.)budget-target-137(?:\.|$)/);
    const { body: detail } = await fetchJson(base, detailUrl.toString().replace(base, ""));
    const productLink = detail.humanProductLink?.url;
    assert.ok(productLink, "item detail must include the human product link");
    assert.match(productLink, /\/c\/[^/]+\/product\/smarttag-rfid-multi-pet-feeder/);
    assert.match(productLink, /budget-target-137/);
    const journeyId = decision.journeyId;
    assert.equal(new URL(productLink).searchParams.get("journey"), journeyId);

    const click = await navigate(productLink, {
      referer: "https://chatgpt.com/c/live-shopping-test",
    });
    assert.equal(click.status, 200);
    assert.match(
      await click.text(),
      /<meta name="epode-customer-context"/,
      "the durable need-state PDP must keep the customer-context contract",
    );

    await waitForEvents(collector.batches, (seen) => {
      return (
        seen.some(
          (event) =>
            event.operation === "/agent-negotiate/feeder" &&
            event.experience?.needState?.expressedDimensions,
        ) &&
        seen.some(
          (event) => event.operation === "/agent-decide/feeder" && event.experience?.decision,
        ) &&
        seen.some((event) => event.operation === "/agent-item" && event.experience?.search) &&
        seen.some((event) => event.customerLinkSource === "product_link_click")
      );
    });

    for (const batch of collector.batches) {
      assert.ok(
        validateBatch(batch),
        `batch must satisfy the telemetry schema: ${JSON.stringify(validateBatch.errors)}`,
      );
    }

    const seen = collectedEvents(collector.batches);
    const negotiation = seen.find(
      (event) =>
        event.operation === "/agent-negotiate/feeder" &&
        event.experience?.needState?.expressedDimensions?.length === 3,
    );
    assert.ok(negotiation, "the final negotiation hop must carry all expressed dimensions");
    assert.deepEqual(negotiation.experience.needState.expressedDimensions.sort(), [
      "budget",
      "motivation",
      "pets",
    ]);

    const decide = seen.find((event) => event.operation === "/agent-decide/feeder");
    assert.equal(decide.experience.stage, "decision_support");
    assert.equal(decide.experience.decision.exactMatchCount, 1);
    assert.ok(decide.experience.decision.nearMissCount >= 4);

    const item = seen.find((event) => event.operation === "/agent-item");
    assert.equal(item.experience.search.resultPosition, 1);

    for (const event of [negotiation, decide, item]) {
      assert.equal(event.experience.channel, "native_graph");
    }
    assert.ok(item.experience.search.searchId);

    // Agent JSON hops append the matched agent family to the runtime hint so
    // the backend's agent-mix insight can classify vendor traffic.
    for (const event of [negotiation, decide, item]) {
      assert.equal(event.runtimeHint, "petsmart-demo/1.0 chatgpt-user");
    }

    // The human handoff lands under the same normalized operation as the
    // durable need-state product page — never a hardcoded item alias — while
    // retaining the signed render journey from the agent surface.
    const handoff = seen.find((event) => event.customerLinkSource === "product_link_click");
    assert.equal(handoff.operation, "/c/:need/product/:id");
    assert.equal(handoff.sessionRef, journeyId);
    assert.match(handoff.anonymousRef, /^psv_/);
    assert.equal(handoff.runtimeHint, "petsmart-demo/1.0 chatgpt-referrer");
    assert.deepEqual(handoff.experience.needState.expressedDimensions.sort(), [
      "budget",
      "motivation",
      "pets",
    ]);
  } finally {
    await started.close();
    await collector.close();
    delete process.env.EPODE_API_KEY;
    delete process.env.EPODE_API_URL;
  }
});

test("petsmart demo faceted telemetry: /feeders records the parsed need dims", async () => {
  const collector = await startCollector();
  process.env.EPODE_API_KEY =
    "af_live_0123456789abcdef0123456789abcdef_secretsecretsecretsecretsecretse";
  process.env.EPODE_API_URL = `http://127.0.0.1:${collector.port}`;
  const facetedServer = await import("../examples/petsmart-demo/server.mjs?faceted-telemetry");
  const started = await facetedServer.startServer(0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    // The agent-UA root is the faceted storefront; take a situation anchor
    // exactly as an assistant would.
    const root = await fetch(`${base}/`, { headers: { "user-agent": AGENT_UA } });
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    const storefront = await root.text();
    const situationUrl = storefront.match(
      /href="(http:\/\/127\.0\.0\.1:\d+\/feeders\?pets=multiple_cats&motivation=one_food_motivated&budget=200&journey=w-[A-Za-z0-9_-]{22})"/,
    )?.[1];
    assert.ok(situationUrl, "the storefront must anchor a tokened situation URL");
    const journeyCapability = new URL(situationUrl).searchParams.get("journey");
    assert.ok(journeyCapability);
    const journeyId = journeyCapability.split(".")[0];

    const plain = await fetch(situationUrl, { headers: { "user-agent": AGENT_UA } });
    assert.equal(plain.status, 200);
    const plainHtml = await plain.text();
    // Value asymmetry: live stock appears only on the situation page.
    assert.match(plainHtml, /in stock nearby/);
    assert.doesNotMatch(storefront, /in stock/i);
    assert.match(plainHtml, /Exact matches \(2\)/);
    // The private agent hop and every shopper-facing PDP retain the same
    // signed journey; signed need facets remain the durable context carrier.
    assert.match(
      plainHtml,
      /\/c\/pets-multiple-cats\.motivation-one-food-motivated\.budget-hard-200\.[A-Za-z0-9_-]+\/product\/[a-z0-9-]+/,
    );
    assert.equal(
      assertOneListingJourney(plainHtml, base, "ChatGPT faceted results"),
      journeyCapability,
    );

    const tampered = new URL(situationUrl);
    tampered.searchParams.set(
      "journey",
      journeyCapability.replace(/.$/, (last) => (last === "a" ? "b" : "a")),
    );
    assert.equal(
      (await fetch(tampered)).status,
      200,
      "a tampered query capability may still render useful public results",
    );

    // ChatGPT's fetched situation URL becomes the user handoff. A real click
    // on that exact URL joins first-party intent to the same signed journey.
    const handoff = await navigate(situationUrl, {
      referer: "https://chatgpt.com/c/pr119-regression",
    });
    assert.equal(handoff.status, 200);
    assert.ok(setCookies(handoff).some((cookie) => cookie.startsWith("ps_visitor=")));

    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 25 * 60 * 60 * 1000;
    try {
      assert.equal(
        (await fetch(situationUrl)).status,
        200,
        "an expired query capability must degrade to an unattributed public result",
      );
    } finally {
      Date.now = originalDateNow;
    }

    // Some chat products percent-encode nested query separators. The legacy
    // route must recover them while still requiring the signed capability.
    const encoded = await fetch(
      `${base}/feeders?pets=multiple_cats%26motivation%3Done_food_motivated%26budget%3D200%26journey%3D${journeyCapability}`,
      { headers: { "user-agent": AGENT_UA } },
    );
    assert.equal(encoded.status, 200);
    assert.match(await encoded.text(), /Exact matches \(2\)/);

    await waitForEvents(
      collector.batches,
      (seen) =>
        seen.filter(
          (event) =>
            event.sessionRef === journeyId &&
            event.operation === "/agent-decide/feeder" &&
            event.experience?.needState?.expressedDimensions?.length === 3,
        ).length >= 2 &&
        seen.some(
          (event) =>
            event.sessionRef === journeyId &&
            event.operation === "/feeders" &&
            event.anonymousRef &&
            event.runtimeHint === "petsmart-demo/1.0 first-party-situation" &&
            event.requestObservation?.referrerOrigin === "https://chatgpt.com",
        ),
    );

    for (const batch of collector.batches) {
      assert.ok(
        validateBatch(batch),
        `batch must satisfy the telemetry schema: ${JSON.stringify(validateBatch.errors)}`,
      );
    }

    const seen = collectedEvents(collector.batches);
    for (const sessionRef of [journeyId]) {
      const hop = seen.find(
        (event) => event.sessionRef === sessionRef && event.operation === "/agent-decide/feeder",
      );
      assert.ok(hop, `the ${sessionRef} fetch must record a decision hop`);
      assert.deepEqual(hop.experience.needState.expressedDimensions.sort(), [
        "budget",
        "motivation",
        "pets",
      ]);
      assert.equal(hop.experience.stage, "decision_support");
      assert.equal(hop.experience.decision.exactMatchCount, 2);
      // Faceted HTML-link traversals declare the faceted channel.
      assert.equal(hop.experience.channel, "faceted_html");
      assert.equal(hop.runtimeHint, "petsmart-demo/1.0 chatgpt-user");
    }
  } finally {
    await started.close();
    await collector.close();
    delete process.env.EPODE_API_KEY;
    delete process.env.EPODE_API_URL;
  }
});

test("petsmart demo keeps a strict $90 multi-cat budget exact and exposes its zero-match facet", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const root = await fetch(`${base}/`, {
      headers: { "user-agent": "ChatGPT-User/1.0" },
    });
    const html = await root.text();
    const match = html.match(
      /href="([^"]+\/feeders\?pets=multiple_cats&motivation=one_food_motivated&budget=90&journey=[^"]+)"/,
    );
    assert.ok(match, "ChatGPT root should publish the exact strict-$90 composite facet");

    const result = await fetch(match[1], {
      headers: { "user-agent": "ChatGPT-User/1.0" },
    });
    const resultHtml = await result.text();
    assert.match(resultHtml, /Exact matches \(0\)/);
    assert.match(resultHtml, /SureFeed Microchip Cat Feeder/);
    assert.match(resultHtml, /budget: needs 90/);
    assert.match(
      resultHtml,
      /\/c\/[^"/]*budget-hard-90[^"/]*\/product\/surefeed-microchip-cat-feeder/,
    );
  } finally {
    await started.close();
  }
});

test("petsmart demo preserves arbitrary exact-dollar hard and target budgets", async () => {
  const started = await startServer(0);
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const hard = await fetch(
      `${base}/feeders?pets=cats_and_dog&motivation=one_food_motivated&budget=137`,
      { headers: { "user-agent": "ChatGPT-User/1.0" } },
    );
    const hardHtml = await hard.text();
    assert.match(hardHtml, /Exact matches \(0\)/);
    assert.match(hardHtml, /SmartTag RFID Multi-Pet Feeder/);
    assert.match(hardHtml, /budget: needs 137, this is 189\.99/);
    assert.match(hardHtml, /\/c\/[^"/]*budget-hard-137[^"/]*\/product\/smarttag/);

    const target = await fetch(
      `${base}/feeders?pets=cats_and_dog&motivation=one_food_motivated&budget=137&budget_kind=target`,
      { headers: { "user-agent": "ChatGPT-User/1.0" } },
    );
    const targetHtml = await target.text();
    assert.doesNotMatch(targetHtml, /Exact matches \(0\)/);
    assert.match(targetHtml, /SmartTag RFID Multi-Pet Feeder/);
    assert.match(targetHtml, /\/c\/[^"/]*budget-target-137[^"/]*\/product\/smarttag/);

    for (const rejectedBudget of ["9", "010", "100000"]) {
      const rejected = await fetch(
        `${base}/feeders?pets=cats_and_dog&motivation=one_food_motivated&budget=${rejectedBudget}`,
      );
      const rejectedHtml = await rejected.text();
      const coercedBudget = String(Number(rejectedBudget));
      assert.doesNotMatch(rejectedHtml, new RegExp(`budget-(?:hard|target)-${coercedBudget}`));
      assert.doesNotMatch(rejectedHtml, new RegExp(`budget: needs ${coercedBudget}`));
    }

    const named = await fetch(`${base}/s/cats-and-dog-one-food-obsessed-under-175`);
    const namedHtml = await named.text();
    assert.match(namedHtml, /Exact matches \(0\)/);
    assert.match(namedHtml, /budget: needs 175, this is 189\.99/);

    const targetSituation = await fetch(`${base}/s/multiple-cats-one-steals-food-target-150`);
    const targetSituationHtml = await targetSituation.text();
    assert.doesNotMatch(targetSituationHtml, /Exact matches \(0\)/);
    assert.match(
      targetSituationHtml,
      /\/s\/multiple-cats-one-steals-food-target-150\/product\/surefeed/,
    );

    const scheduled = await fetch(`${base}/s/one-cat-scheduled-portions-under-90`);
    const scheduledHtml = await scheduled.text();
    assert.match(scheduledHtml, /Exact matches \(1\)/);
    assert.match(scheduledHtml, /Whisker City Programmable Feeder/);
    assert.match(scheduledHtml, /Near miss: motivation: needs all_balanced, this is grazers/);
    assert.match(scheduledHtml, /never account or identity data/);
  } finally {
    await started.close();
  }
});

test("petsmart demo browse paths require user activation before starting a journey", async () => {
  const collector = await startCollector();
  process.env.EPODE_API_KEY =
    "af_live_0123456789abcdef0123456789abcdef_secretsecretsecretsecretsecretse";
  process.env.EPODE_API_URL = `http://127.0.0.1:${collector.port}`;
  const browseServer = await import("../examples/petsmart-demo/server.mjs?browse-activation");
  const started = await browseServer.startServer(0);
  const base = `http://127.0.0.1:${started.port}`;
  const browsePath = "/s/multiple-cats-one-steals-food-under-200";

  try {
    const preview = await fetch(base + browsePath, {
      headers: { "user-agent": BROWSER_UA },
    });
    assert.equal(preview.status, 200);
    assert.equal(setCookies(preview).length, 0, "a preview must not mint shopper identity");

    const organicClick = await navigate(base + browsePath);
    assert.equal(organicClick.status, 200);
    assert.ok(
      setCookies(organicClick).some((cookie) => cookie.startsWith("ps_visitor=")),
      "the activated browse path must mint first-party identity",
    );

    await waitForEvents(collector.batches, (seen) =>
      seen.some((event) => event.operation === "/s/:situation"),
    );

    const organicIntent = collectedEvents(collector.batches).find(
      (event) => event.operation === "/s/:situation",
    );
    assert.equal(organicIntent.customerLinkSource, undefined);
    assert.match(organicIntent.anonymousRef, /^psv_/);
    assert.deepEqual(organicIntent.experience.needState.expressedDimensions.sort(), [
      "budget",
      "motivation",
      "pets",
    ]);
    assert.equal(organicIntent.runtimeHint, "petsmart-demo/1.0 first-party-situation");
    assert.equal(
      collectedEvents(collector.batches).filter(
        (event) => event.customerLinkSource === "product_link_click",
      ).length,
      0,
      "organic situation intent must not be labeled as an AI handoff",
    );

    const chatClick = await navigate(base + browsePath, {
      referer: "https://grok.com/c/live-shopping-test",
    });
    assert.equal(chatClick.status, 200);
    const chatLandingHtml = await chatClick.text();
    const publicSituationJourney = assertOneListingJourney(
      chatLandingHtml,
      base,
      "public situation results",
    );
    const browseProductUrl = listingUrls(chatLandingHtml, base).find((url) =>
      url.pathname.endsWith("/product/surefeed-microchip-cat-feeder"),
    );
    assert.ok(browseProductUrl, "public situation results must list journey-bearing PDPs");
    assert.equal(listingJourney(browseProductUrl), publicSituationJourney);
    const chatCookie = setCookies(chatClick)
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.match(chatCookie, /ps_journey=/);

    await waitForEvents(
      collector.batches,
      (events) => events.filter((event) => event.operation === "/s/:situation").length === 2,
    );
    const chatIntent = collectedEvents(collector.batches).filter(
      (event) => event.operation === "/s/:situation",
    )[1];
    assert.equal(chatIntent.runtimeHint, "petsmart-demo/1.0 grok-referrer");

    const productPreview = await fetch(browseProductUrl, {
      headers: { "user-agent": BROWSER_UA },
    });
    assert.equal(productPreview.status, 200);
    assert.equal(
      setCookies(productPreview).length,
      0,
      "a PDP preview must not mint shopper identity",
    );

    const productClick = await navigate(browseProductUrl, { cookie: chatCookie });
    assert.equal(productClick.status, 200);
    const productHtml = await productClick.text();
    assert.match(
      productHtml,
      /<meta name="epode-customer-context"/,
      "the short public PDP must keep the customer-context contract",
    );

    await waitForEvents(collector.batches, (events) =>
      events.some(
        (event) =>
          event.customerLinkSource === "product_link_click" &&
          event.operation === "/s/:situation/product/:id",
      ),
    );

    const productClicks = collectedEvents(collector.batches).filter(
      (event) =>
        event.customerLinkSource === "product_link_click" &&
        event.operation === "/s/:situation/product/:id",
    );
    assert.equal(productClicks.length, 1, "the product preview must not create a handoff");
    assert.equal(productClicks[0].sessionRef, chatIntent.sessionRef);
    assert.equal(productClicks[0].runtimeHint, "petsmart-demo/1.0 grok-referrer");
    assert.deepEqual(productClicks[0].experience.needState.expressedDimensions.sort(), [
      "budget",
      "motivation",
      "pets",
    ]);
    assert.equal(productClicks[0].experience.decision?.violatedHardConstraints, undefined);

    const humanRootHtml = await fetch(`${base}/`, {
      headers: { "user-agent": BROWSER_UA },
    }).then((response) => response.text());
    const humanRootJourney = assertOneListingJourney(humanRootHtml, base, "human root");
    assert.match(humanRootJourney, COMPACT_RENDER_JOURNEY_RE);
    const humanRootProductUrl = listingUrls(humanRootHtml, base).find((url) =>
      url.pathname.startsWith("/product/"),
    );
    assert.ok(humanRootProductUrl);
    await navigate(humanRootProductUrl);
    const humanRootJourneyId = humanRootJourney;
    await waitForEvents(collector.batches, (events) =>
      events.some(
        (event) => event.operation === "/product/:id" && event.sessionRef === humanRootJourneyId,
      ),
    );
    const humanRootIntent = collectedEvents(collector.batches).find(
      (event) => event.operation === "/product/:id" && event.sessionRef === humanRootJourneyId,
    );
    assert.equal(
      humanRootIntent.customerLinkSource,
      undefined,
      "a signed public-render journey must not claim AI attribution by itself",
    );

    const directProduct = await navigate(`${base}/product/smarttag-rfid-multi-pet-feeder`, {
      referer: "https://meta.ai/c/live-shopping-test",
    });
    assert.equal(directProduct.status, 200);
    await waitForEvents(collector.batches, (events) =>
      events.some(
        (event) =>
          event.customerLinkSource === "product_link_click" &&
          event.operation === "/product/:id" &&
          event.runtimeHint === "petsmart-demo/1.0 meta-ai-referrer",
      ),
    );
    const directProductClicks = collectedEvents(collector.batches).filter(
      (event) =>
        event.customerLinkSource === "product_link_click" && event.operation === "/product/:id",
    );
    assert.equal(directProductClicks.length, 1);
    assert.match(directProductClicks[0].anonymousRef, /^psv_/);

    const customPath =
      "/feeders?pets=multiple_cats&motivation=one_food_motivated&budget=150&budget_kind=hard";
    const customPreview = await fetch(base + customPath, {
      headers: { "user-agent": BROWSER_UA },
    });
    assert.equal(customPreview.status, 200);
    assert.equal(setCookies(customPreview).length, 0);
    const customPreviewHtml = await customPreview.text();
    assert.match(customPreviewHtml, /\/c\/[^/]+\/product\/surefeed-microchip-cat-feeder/);
    assertOneListingJourney(customPreviewHtml, base, "custom faceted results");

    const customClick = await navigate(base + customPath, {
      referer: "https://grok.com/c/custom-shopping-test",
    });
    assert.equal(customClick.status, 200);
    await waitForEvents(collector.batches, (events) =>
      events.some(
        (event) =>
          event.operation === "/feeders" && event.runtimeHint === "petsmart-demo/1.0 grok-referrer",
      ),
    );
    const customIntent = collectedEvents(collector.batches).find(
      (event) =>
        event.operation === "/feeders" && event.runtimeHint === "petsmart-demo/1.0 grok-referrer",
    );
    assert.deepEqual(customIntent.experience.needState.expressedDimensions.sort(), [
      "budget",
      "motivation",
      "pets",
    ]);
    assert.equal(customIntent.experience.channel, "faceted_html");

    const rootClick = await navigate(`${base}/`, {
      referer: "https://chatgpt.com/c/root-shopping-test",
    });
    assert.equal(rootClick.status, 200);
    assert.ok(setCookies(rootClick).some((cookie) => cookie.startsWith("ps_visitor=")));
    await waitForEvents(collector.batches, (events) =>
      events.some(
        (event) =>
          event.operation === "/" && event.runtimeHint === "petsmart-demo/1.0 chatgpt-referrer",
      ),
    );
  } finally {
    await started.close();
    await collector.close();
    delete process.env.EPODE_API_KEY;
    delete process.env.EPODE_API_URL;
  }
});

test("petsmart demo faceted gating: only request-carried journeys reach telemetry", async () => {
  const collector = await startCollector();
  process.env.EPODE_API_KEY =
    "af_live_0123456789abcdef0123456789abcdef_secretsecretsecretsecretsecretse";
  process.env.EPODE_API_URL = `http://127.0.0.1:${collector.port}`;
  const gatedServer = await import("../examples/petsmart-demo/server.mjs?feeders-gate");
  const started = await gatedServer.startServer(0);
  const base = `http://127.0.0.1:${started.port}`;
  const situation = "pets=multiple_cats&motivation=one_food_motivated&budget=200";

  try {
    // Preview and crawler fetches must fabricate no telemetry at all.
    for (const ua of [BROWSER_UA, "Googlebot/2.1"]) {
      const organic = await fetch(`${base}/feeders?${situation}`, {
        headers: { "user-agent": ua },
      });
      assert.equal(organic.status, 200);
    }
    // A real organic navigation gets the cookie drop and an honestly labeled
    // first-party custom-situation event.
    const organicHuman = await navigate(`${base}/feeders?${situation}`);
    assert.ok(
      setCookies(organicHuman).some((cookie) => cookie.startsWith("ps_visitor=")),
      "the organic /feeders visit must still mint the visitor cookie",
    );

    const forgedJourney = `j-${randomUUID()}`;
    const forged = await navigate(`${base}/feeders?${situation}&journey=${forgedJourney}`);
    assert.equal(forged.status, 200);
    assert.equal(
      (await fetch(`${base}/agent-negotiate/${forgedJourney}/feeder`)).status,
      400,
      "unissued raw journey IDs must not enter the agent graph",
    );
    const indexer = await fetch(`${base}/`, {
      headers: { "user-agent": "meta-webindexer/1.1" },
    });
    const indexerHtml = await indexer.text();
    assert.match(indexerHtml, /\/s\/multiple-cats-one-steals-food-under-200/);
    assert.doesNotMatch(indexerHtml, /\/shop\/automatic-feeders\//);
    assert.doesNotMatch(indexerHtml, /<meta name="epode-customer-context"/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const organicEvents = collectedEvents(collector.batches);
    assert.equal(organicEvents.length, 1);
    assert.equal(organicEvents[0].operation, "/feeders");
    assert.equal(organicEvents[0].customerLinkSource, undefined);
    assert.equal(
      organicEvents[0].runtimeHint,
      "petsmart-demo/1.0 first-party-situation",
      "an unsigned UUID-looking journey and indexer must add no attribution",
    );

    const guide = await fetch(`${base}/`, {
      headers: { "user-agent": "meta-externalfetcher/1.1" },
    }).then((r) => r.text());
    const signedSituation = guide.match(
      /href="(http:\/\/127\.0\.0\.1:\d+\/shop\/automatic-feeders\/(w-[A-Za-z0-9_-]{22})\/multiple-cats-food-stealing-under-200)"/,
    );
    assert.ok(signedSituation, "the agent guide must issue a signed situation path");
    const [, signedSituationUrl, journeyId] = signedSituation;
    const signedCapability = new URL(signedSituationUrl).pathname.split("/")[3];

    assert.equal(
      (
        await fetch(
          `${base}/shop/automatic-feeders/${forgedJourney}/multiple-cats-food-stealing-under-200`,
        )
      ).status,
      404,
      "unsigned journey path segments must be rejected",
    );

    const situationClick = await navigate(signedSituationUrl);
    assert.equal(situationClick.status, 200);
    const situationHtml = await situationClick.text();
    assert.equal(
      assertOneListingJourney(situationHtml, base, "signed-path situation results"),
      signedCapability,
    );
    const cookies = setCookies(situationClick)
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.match(cookies, /ps_journey=/);
    const stableProductUrl = listingUrls(situationHtml, base).find((url) =>
      url.pathname.startsWith("/s/multiple-cats-one-steals-food-under-200/product/"),
    );
    assert.ok(stableProductUrl, "the private agent page must emit a shopper PDP");
    assert.equal(listingJourney(stableProductUrl), signedCapability);

    const productClick = await navigate(stableProductUrl, { cookie: cookies });
    assert.equal(productClick.status, 200);
    assert.match(
      await productClick.text(),
      /<meta name="epode-customer-context"/,
      "the signed situation PDP must keep the customer-context contract",
    );

    await waitForEvents(collector.batches, (seen) => {
      return (
        seen.some(
          (event) =>
            event.customerLinkSource === "product_link_click" && event.sessionRef === journeyId,
        ) &&
        seen.some(
          (event) =>
            event.operation === "/shop/automatic-feeders/:journey/:situation" &&
            event.sessionRef === journeyId,
        )
      );
    });

    const seen = collectedEvents(collector.batches);
    // Apart from the honest organic custom-situation event, every later event
    // belongs to the signed carried journey.
    const signedEvents = seen.filter(
      (event) => event.runtimeHint !== "petsmart-demo/1.0 first-party-situation",
    );
    assert.ok(
      signedEvents.every((event) => event.sessionRef === journeyId),
      `signed events must retain their journey, saw ${JSON.stringify(signedEvents.map((event) => [event.operation, event.sessionRef]))}`,
    );
    const clicks = seen.filter((event) => event.customerLinkSource === "product_link_click");
    assert.equal(clicks.length, 1, "only the journey-carrying visit may record a click");
    assert.equal(clicks[0].operation, "/s/:situation/product/:id");
    assert.match(clicks[0].anonymousRef, /^psv_/);
    const situationIntent = seen.find(
      (event) => event.operation === "/shop/automatic-feeders/:journey/:situation",
    );
    assert.equal(situationIntent.customerLinkSource, undefined);
    assert.deepEqual(situationIntent.experience.needState.expressedDimensions.sort(), [
      "budget",
      "motivation",
      "pets",
    ]);
    assert.equal(situationIntent.experience.channel, "faceted_html");
  } finally {
    await started.close();
    await collector.close();
    delete process.env.EPODE_API_KEY;
    delete process.env.EPODE_API_URL;
  }
});
