import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import express from "express";

import { AgentFeedbackRuntime } from "@epode/node";
import { epode } from "@epode/node/express";
import {
  experienceTelemetryDetails,
  isValidJourneyId,
  productLinkClickTelemetryDetails,
} from "@epode/node/experience-graph";
import { automaticRequestObservation } from "@epode/node/customer";

import { BRAND, TAGLINE, catalogItem, graph, humanCatalogSummary } from "./catalog.mjs";
import { requiredCookieSecret } from "./cookie-secret.js";
import { provisionPetFields } from "./provision-fields.mjs";

const PORT = Number(process.env.PORT || 4320);
const AGENT_UA =
  /claude-user|anthropic-ai|chatgpt-user|perplexity-user|cohere-ai|gemini-agent/i;
const HERO_ITEM_ID = "smarttag-rfid-multi-pet-feeder";

const cookieSecret = requiredCookieSecret();

function signedCookie(name, value) {
  const signature = createHmac("sha256", cookieSecret)
    .update(`${name}:${value}`)
    .digest("base64url");
  return `${value}.${signature}`;
}

function verifiedCookie(cookie = "", name) {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) return undefined;
  const [value, signature] = encoded.split(".");
  if (!value || !signature) return undefined;
  const expected = createHmac("sha256", cookieSecret)
    .update(`${name}:${value}`)
    .digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
    ? value
    : undefined;
}

const runtime = process.env.EPODE_API_KEY
  ? new AgentFeedbackRuntime({
      apiKey: process.env.EPODE_API_KEY,
      endpoint: process.env.EPODE_API_URL || process.env.AGENT_FEEDBACK_URL,
      feedbackMode: process.env.AGENT_FEEDBACK_MODE || "never_ask",
      include: ["/agent-negotiate/**", "/agent-decide/**", "/agent-item/**", "/product/**", "/"],
      runtimeHint: () => "petsmart-demo/1.0",
    })
  : null;

function recordHop(operation, journeyId, statusCode, durationMs) {
  if (!runtime) return;
  try {
    const prepared = runtime.prepare();
    runtime.record(
      prepared,
      experienceTelemetryDetails({
        operation,
        journeyId,
        statusCode,
        durationMs,
        runtimeHint: "petsmart-demo/1.0",
      }),
    );
    void runtime.flush().catch(() => {});
  } catch {
    // Product responses must never depend on telemetry delivery.
  }
}

function recordProductLinkClick(request, journeyId, visitorId, durationMs) {
  if (!runtime) return;
  try {
    const prepared = runtime.prepare();
    runtime.record(
      prepared,
      productLinkClickTelemetryDetails({
        operation: "/product/feeder",
        sessionRef: journeyId,
        anonymousRef: visitorId,
        requestObservation: automaticRequestObservation(
          request.method,
          request.ip,
          (name) => request.get(name) || undefined,
        ),
        statusCode: 200,
        durationMs,
        runtimeHint: "petsmart-demo/1.0",
      }),
    );
    void runtime.flush().catch(() => {});
  } catch {
    // Product responses must never depend on telemetry delivery.
  }
}

function json(response, status, body) {
  response.status(status);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.json(body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.status(status);
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.send(body);
}

function isAgent(request) {
  return AGENT_UA.test(request.get("user-agent") || "");
}

function originFor(request) {
  const host = request.get("x-forwarded-host") || request.get("host") || `127.0.0.1:${PORT}`;
  const proto = request.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

function parseJourneyPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/").filter(Boolean);
  const [journeyId, category, ...tokens] = segments;
  if (!journeyId || !category) return null;
  return { journeyId, category, tokens };
}

const PAGE_STYLE = `
  :root { --ps-blue: #0058a5; --ps-red: #e4002b; --ps-ink: #1f2a37; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; margin: 0; color: var(--ps-ink); background: #f6f7f9; }
  header { background: var(--ps-blue); color: #fff; padding: 0.9rem 1.5rem; display: flex; align-items: baseline; gap: 1rem; }
  header .wordmark { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.02em; }
  header .wordmark .smart { color: #ffd41f; }
  header .tagline { font-size: 0.85rem; opacity: 0.9; }
  nav { background: #fff; border-bottom: 1px solid #e3e6ea; padding: 0.6rem 1.5rem; font-size: 0.9rem; color: #4b5563; }
  main { max-width: 62rem; margin: 0 auto; padding: 1.5rem; }
  .hero { background: linear-gradient(100deg, var(--ps-blue), #007dc5); color: #fff; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .hero h2 { margin: 0 0 0.4rem; }
  .hero p { margin: 0 0 0.8rem; opacity: 0.95; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 1rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .card .brand { color: #6b7280; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .price { color: var(--ps-red); font-weight: 700; }
  .card a, .cta { color: #fff; background: var(--ps-red); border-radius: 999px; padding: 0.45rem 1rem; text-decoration: none; font-weight: 600; text-align: center; display: inline-block; border: 0; font-size: 0.95rem; cursor: pointer; }
  .treats { background: #fff; border: 1px dashed var(--ps-blue); border-radius: 10px; padding: 0.8rem 1rem; margin-top: 1.5rem; font-size: 0.9rem; color: #374151; }
  .features { padding-left: 1.1rem; margin: 0.5rem 0; color: #374151; }
  .muted { color: #6b7280; font-size: 0.85rem; }
`;

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <header>
    <div class="wordmark">Pet<span class="smart">Smart</span></div>
    <div class="tagline">${TAGLINE}</div>
  </header>
  <nav>Shop Deals &nbsp;·&nbsp; Dog &nbsp;·&nbsp; Cat &nbsp;·&nbsp; Feeders &amp; Bowls &nbsp;·&nbsp; Same-Day Delivery</nav>
  <main>${body}</main>
</body>
</html>`;
}

function traitSummary(items) {
  const values = new Map(items.map((item) => [item.key, item.value]));
  const mix = {
    one_cat: "your cat",
    multiple_cats: "your cats",
    one_dog: "your dog",
    multiple_dogs: "your dogs",
    cats_and_dog: "your two cats & dog",
  }[values.get("pet.household_mix")];
  const motivation =
    values.get("pet.food_motivation") === "one_food_motivated"
      ? "one food-motivated eater"
      : undefined;
  return { mix, motivation };
}

function storefrontHtml({ personalized, traits, decisionId }) {
  const hero = personalized
    ? `<section class="hero" data-personalized="true"${decisionId ? ` data-decision-id="${decisionId}"` : ""}>
        <h2>Welcome back${traits.mix ? ` — picked for ${traits.mix}` : ""}</h2>
        <p>${
          traits.motivation
            ? `Households with ${traits.motivation} love the SmartTag RFID Multi-Pet Feeder: every pet gets its own portions, and the locking lid stops food stealing.`
            : "Based on your household, we think you'll love the SmartTag RFID Multi-Pet Feeder."
        }</p>
        <a href="/product/${HERO_ITEM_ID}">Meet the SmartTag RFID Feeder</a>
      </section>`
    : `<section class="hero" data-personalized="false">
        <h2>Feeders &amp; waterers for every pet</h2>
        <p>From gravity bowls to RFID smart feeders — find the right mealtime setup.</p>
      </section>`;
  const cards = humanCatalogSummary()
    .map(
      (item) => `<article class="card">
        <span class="brand">${item.brand}</span>
        <strong>${item.title}</strong>
        <span class="price">$${item.price.amount.toFixed(2)}</span>
        <a href="/product/${item.id}">View details</a>
      </article>`,
    )
    .join("");
  return pageShell(
    `Automatic Feeders | ${BRAND}`,
    `${hero}<section class="grid">${cards}</section>
     <p class="treats">Treats™ members earn points on every purchase. Agent clients receive a machine-readable experience graph at this same URL.</p>`,
  );
}

function productHtml(item) {
  const features = (item.attributes?.features ?? [])
    .map((feature) => `<li>${feature}</li>`)
    .join("");
  return pageShell(
    `${item.title} | ${BRAND}`,
    `<article class="card" data-item-id="${item.id}" style="max-width: 34rem; margin: 0 auto;">
      <span class="brand">${item.brand}</span>
      <h2 style="margin: 0.2rem 0;">${item.title}</h2>
      <span class="price">$${item.price.amount.toFixed(2)}</span>
      <ul class="features">${features}</ul>
      <form method="post" action="/api/cart" style="margin-top: 0.6rem;">
        <input type="hidden" name="itemId" value="${item.id}" />
        <button class="cta" type="submit">Add to cart</button>
      </form>
      <p class="muted">Free Same-Day Delivery on orders over $49 · Buy online, pick up in store</p>
    </article>`,
  );
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // First-party identity: read (never mint) the signed visitor/session cookies.
  // The cookie drop happens on the product-detail click only.
  app.use((request, _response, next) => {
    const cookie = request.get("cookie");
    request.visitorId = verifiedCookie(cookie, "ps_visitor");
    request.sessionId = verifiedCookie(cookie, "ps_session");
    next();
  });

  const customer = process.env.EPODE_API_KEY
    ? epode({
        apiKey: process.env.EPODE_API_KEY,
        endpoint: process.env.EPODE_API_URL,
        include: ["/", "/product/*"],
        purpose: "product_personalization",
        identify: (request) =>
          request.visitorId ? { anonymousRef: request.visitorId } : {},
        sessionRef: (request) => request.sessionId,
        runtimeHint: () => "petsmart-demo/1.0",
      })
    : null;
  if (customer) app.use(customer);

  const decisions = new Map();

  app.get("/health", (_request, response) => {
    json(response, 200, { ok: true, product: "petsmart-demo" });
  });

  app.get("/", async (request, response) => {
    const started = performance.now();
    const origin = originFor(request);
    if (isAgent(request)) {
      const journeyId = `j-${randomUUID()}`;
      const guide = graph.buildGuide(origin, journeyId);
      recordHop("/agent-guide", journeyId, 200, Math.round(performance.now() - started));
      response.setHeader("vary", "User-Agent");
      return text(response, 200, guide);
    }

    let personalized = false;
    let traits = {};
    let decisionId;
    if (customer && request.visitorId) {
      const context = await customer.context.get({
        anonymousRef: request.visitorId,
        purpose: "product_personalization",
      });
      if (context.available && context.items.length > 0) {
        traits = traitSummary(context.items);
        personalized = Boolean(traits.mix || traits.motivation);
        if (personalized) {
          const recorded = await customer.personalization.decide({
            externalDecisionId: `petsmart_hero_${randomUUID()}`,
            contextRetrievalId: context.retrievalId,
            signalIds: context.items.map((item) => item.signalId),
            variant: "pet-household-hero-v1",
          });
          if (recorded.recorded) {
            decisionId = recorded.decision.id;
            decisions.set(request.visitorId, decisionId);
          }
        }
      }
    }
    response.setHeader("vary", "User-Agent");
    return text(
      response,
      200,
      storefrontHtml({ personalized, traits, decisionId }),
      "text/html; charset=utf-8",
    );
  });

  app.get("/agent-negotiate/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseJourneyPath(request.path, "/agent-negotiate/");
    if (!parsed) return json(response, 400, { error: "invalid_negotiation_path" });
    if (parsed.category !== graph.definition.category) {
      return json(response, 404, {
        error: "unknown_category",
        available: [graph.definition.category],
      });
    }
    if (parsed.tokens.some((token) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token))) {
      return json(response, 400, {
        error: "invalid_need_token",
        message: "Need-state tokens use lowercase letters, numbers, and single hyphens.",
      });
    }
    try {
      const node = graph.buildNegotiation({
        origin: originFor(request),
        journeyId: parsed.journeyId,
        tokens: parsed.tokens,
      });
      recordHop(node.operation, parsed.journeyId, 200, Math.round(performance.now() - started));
      return json(response, 200, node);
    } catch (error) {
      return json(response, 400, { error: "invalid_negotiation", message: String(error) });
    }
  });

  app.get("/agent-decide/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseJourneyPath(request.path, "/agent-decide/");
    if (!parsed) return json(response, 400, { error: "invalid_decision_path" });
    if (parsed.category !== graph.definition.category) {
      return json(response, 404, {
        error: "unknown_category",
        available: [graph.definition.category],
      });
    }
    try {
      const node = graph.buildDecision({
        origin: originFor(request),
        journeyId: parsed.journeyId,
        tokens: parsed.tokens,
        searchId: randomUUID(),
        paths: { detailPath: `/agent-item/${parsed.journeyId}` },
      });
      const status = node.error ? 422 : 200;
      recordHop(node.operation, parsed.journeyId, status, Math.round(performance.now() - started));
      return json(response, status, node);
    } catch (error) {
      return json(response, 400, { error: "invalid_decision", message: String(error) });
    }
  });

  app.get("/agent-item/:journeyId", (request, response) => {
    const started = performance.now();
    const journeyId = String(request.params.journeyId || "");
    if (!isValidJourneyId(journeyId)) {
      return json(response, 400, { error: "invalid_journey_id" });
    }
    const itemId = String(request.query.item_id || "");
    const searchId = request.query.search_id ? String(request.query.search_id) : undefined;
    const position = request.query.position ? String(request.query.position) : undefined;
    const detail = graph.itemDetail(itemId, searchId, position);
    const status = detail.error ? 404 : 200;
    recordHop(detail.operation || "/agent-item", journeyId, status, Math.round(performance.now() - started));
    if (detail.error) return json(response, status, detail);
    const productUrl = new URL(`/product/${encodeURIComponent(itemId)}`, originFor(request));
    productUrl.searchParams.set("journey", journeyId);
    if (searchId) productUrl.searchParams.set("search", searchId);
    return json(response, status, {
      ...detail,
      humanProductLink: {
        description:
          "Share this ordinary product page with the user. Opening it in their browser establishes a first-party session with the merchant.",
        url: productUrl.toString(),
      },
    });
  });

  app.get("/product/:itemId", (request, response) => {
    const started = performance.now();
    const item = catalogItem(String(request.params.itemId || ""));
    if (!item) {
      return text(response, 404, pageShell(`Not found | ${BRAND}`, "<p>Product not found.</p>"), "text/html; charset=utf-8");
    }

    // The cookie drop: a product-detail visit mints the signed first-party
    // visitor and session IDs when the browser does not already carry them.
    if (!request.visitorId) {
      request.visitorId = `psv_${randomUUID()}`;
      response.append(
        "Set-Cookie",
        `ps_visitor=${signedCookie("ps_visitor", request.visitorId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      );
    }
    if (!request.sessionId) {
      request.sessionId = `pss_${randomUUID()}`;
      response.append(
        "Set-Cookie",
        `ps_session=${signedCookie("ps_session", request.sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800`,
      );
    }

    // Link the agent journey to the new first-party identity.
    const journey = String(request.query.journey || "");
    if (journey && isValidJourneyId(journey)) {
      recordProductLinkClick(
        request,
        journey,
        request.visitorId,
        Math.round(performance.now() - started),
      );
    }

    return text(response, 200, productHtml(item), "text/html; charset=utf-8");
  });

  app.post("/api/cart", async (request, response) => {
    const itemId = String(request.body?.itemId || "");
    const item = catalogItem(itemId);
    if (!item) return json(response, 404, { error: "item_not_found" });
    const decisionId = request.visitorId ? decisions.get(request.visitorId) : undefined;
    if (customer && decisionId) {
      await customer.outcomes.track({
        externalOutcomeId: `petsmart_cart_${randomUUID()}`,
        decisionId,
        outcome: "conversion",
      });
    }
    return json(response, 201, {
      orderId: `order_${randomUUID()}`,
      itemId,
      recorded: Boolean(customer && decisionId),
    });
  });

  return app;
}

export function startServer(port = PORT) {
  const app = createApp();
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        app,
        server,
        port: server.address().port,
        close: async () => {
          if (runtime) await runtime.shutdown().catch(() => {});
          await new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          });
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.EPODE_API_KEY) {
    try {
      await provisionPetFields({
        apiKey: process.env.EPODE_API_KEY,
        endpoint: process.env.EPODE_API_URL,
      });
    } catch (error) {
      console.warn(`petsmart-demo: context-field provisioning failed: ${String(error)}`);
    }
  }
  const started = await startServer(PORT);
  console.log(`petsmart-demo listening on http://127.0.0.1:${started.port}`);
}
