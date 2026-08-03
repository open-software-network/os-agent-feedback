import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import express from "express";
import { epode } from "@epode/node/express";
import { requiredCookieSecret } from "./cookie-secret.js";

const cookieSecret = requiredCookieSecret();
const decisions = new Map();

function signature(name, id) {
  return createHmac("sha256", cookieSecret).update(`${name}:${id}`).digest("base64url");
}

function verifiedCookie(cookie = "", name) {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) return undefined;
  const [id, supplied] = encoded.split(".");
  if (!id || !supplied) return undefined;
  const expected = signature(name, id);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right) ? id : undefined;
}

const app = express();
app.use(express.json());
app.use((request, response, next) => {
  const cookie = request.get("cookie");
  const visitor = verifiedCookie(cookie, "example_visitor");
  const journey = verifiedCookie(cookie, "example_journey");
  request.visitorId = visitor || `anon_${randomUUID()}`;
  request.journeyId = journey || `journey_${randomUUID()}`;
  if (!visitor) {
    response.append(
      "Set-Cookie",
      `example_visitor=${request.visitorId}.${signature("example_visitor", request.visitorId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
    );
  }
  if (!journey) {
    response.append(
      "Set-Cookie",
      `example_journey=${request.journeyId}.${signature("example_journey", request.journeyId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`,
    );
  }
  next();
});

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  endpoint: process.env.EPODE_API_URL,
  include: ["/api/discover", "/api/ephemeral-discover"],
  purpose: "targeted_advertising",
  identify: (request) =>
    request.path === "/api/ephemeral-discover" ? {} : { anonymousRef: request.visitorId },
  sessionRef: (request) => request.journeyId,
  runtimeHint: () => "anonymous-express/1.0",
});
app.use(customer);

async function discover(request, response) {
  const context = await customer.contextFor(request);
  const interests = new Set(context.items.map((item) => `${item.key}:${item.value}`));
  const placement = interests.has("interest.topic:outdoor_travel")
    ? { campaign: "outdoor-travel", headline: "Explore closer to nature" }
    : { campaign: "general", headline: "Explore this week's picks" };
  let decisionId;
  if (context.available && context.items.length > 0) {
    const result = await customer.personalization.decide({
      externalDecisionId: `anonymous_placement_${randomUUID()}`,
      contextRetrievalId: context.retrievalId,
      signalIds: context.items.map((item) => item.signalId),
      variant: placement.campaign,
    });
    if (result.recorded) {
      decisionId = result.decision.id;
      decisions.set(request.visitorId, decisionId);
    }
  }
  response.json({ placement, personalized: Boolean(decisionId), decisionId });
}

app.get("/api/discover", discover);
app.get("/api/ephemeral-discover", discover);

app.post("/api/ad-events", async (request, response) => {
  const decisionId = decisions.get(request.visitorId);
  if (decisionId) {
    await customer.outcomes.track({
      externalOutcomeId: `ad_event_${randomUUID()}`,
      decisionId,
      outcome: request.body?.event === "dismissed" ? "dismissal" : "engagement",
    });
  }
  response.status(202).json({ accepted: true, measured: Boolean(decisionId) });
});

app.get("/health", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT || 4305), "0.0.0.0");
