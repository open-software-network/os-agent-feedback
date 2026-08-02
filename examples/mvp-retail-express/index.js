import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import express from "express";
import { epode } from "@epode/node/express";
import { requiredCookieSecret } from "./cookie-secret.js";

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

const app = express();
app.use(express.json());
app.use((request, response, next) => {
  const cookie = request.get("cookie");
  const visitor = verifiedCookie(cookie, "retail_visitor");
  const journey = verifiedCookie(cookie, "retail_journey");
  request.visitorId = visitor || `visitor_${randomUUID()}`;
  request.journeyId = journey || `journey_${randomUUID()}`;
  if (!visitor) {
    response.append(
      "Set-Cookie",
      `retail_visitor=${signedCookie("retail_visitor", request.visitorId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    );
  }
  if (!journey) {
    response.append(
      "Set-Cookie",
      `retail_journey=${signedCookie("retail_journey", request.journeyId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`,
    );
  }
  if (request.get("authorization") === "Bearer demo-retail-customer-token") {
    request.customer = { accountId: "retail_household_42", userId: "retail_user_7" };
  }
  next();
});

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  endpoint: process.env.EPODE_API_URL,
  include: ["/api/recommendations"],
  purpose: "product_personalization",
  identify: (request) => ({
    accountRef: request.customer?.accountId,
    userRef: request.customer?.userId,
    anonymousRef: request.visitorId,
  }),
  sessionRef: (request) => request.journeyId,
  runtimeHint: () => "retail-express/1.0",
});
app.use(customer);

const products = [
  { id: "gift-fast", name: "Express gift box", price: 129, sustainable: true, days: 2 },
  { id: "gift-value", name: "Classic gift box", price: 79, sustainable: false, days: 5 },
  { id: "gift-premium", name: "Premium gift box", price: 220, sustainable: true, days: 3 },
];
const decisions = new Map();

app.get("/api/recommendations", async (request, response) => {
  const identity = {
    accountRef: request.customer?.accountId,
    userRef: request.customer?.userId,
    anonymousRef: request.visitorId,
  };
  const context = await customer.context.get({ ...identity, purpose: "product_personalization" });
  const values = new Set(context.items.map((item) => `${item.key}:${item.value}`));
  const ranked = [...products].sort((left, right) => {
    const score = (product) =>
      (values.has("shopping.priority:sustainability") && product.sustainable ? 10 : 0) +
      (values.has("shopping.budget_band:50_150") && product.price <= 150 ? 5 : 0) +
      (values.has("shopping.delivery_window:within_week") && product.days <= 3 ? 3 : 0);
    return score(right) - score(left);
  });
  let decisionId;
  if (context.available && context.items.length > 0) {
    const externalDecisionId = `retail_recommendation_${randomUUID()}`;
    const recorded = await customer.personalization.decide({
      externalDecisionId,
      contextRetrievalId: context.retrievalId,
      signalIds: context.items.map((item) => item.signalId),
      variant: "customer-context-ranking-v1",
    });
    if (recorded.recorded) {
      decisionId = recorded.decision.id;
      decisions.set(request.visitorId, decisionId);
    }
  }
  response.json({ products: ranked, personalized: Boolean(decisionId), decisionId });
});

app.post("/api/orders", async (request, response) => {
  const decisionId = request.body?.decisionId || decisions.get(request.visitorId);
  if (decisionId) {
    await customer.outcomes.track({
      externalOutcomeId: `retail_order_${randomUUID()}`,
      decisionId,
      outcome: "conversion",
    });
  }
  response.status(201).json({ orderId: `order_${randomUUID()}`, recorded: Boolean(decisionId) });
});

app.get("/health", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT || 4301), "0.0.0.0");
