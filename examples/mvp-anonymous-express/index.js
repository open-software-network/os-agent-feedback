import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import express from "express";
import { epode } from "@epode/node/express";
import { requiredCookieSecret } from "./cookie-secret.js";

const cookieSecret = requiredCookieSecret();
const decisions = new Map();

function signature(id) {
  return createHmac("sha256", cookieSecret).update(id).digest("base64url");
}

function visitor(cookie = "") {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("example_visitor="))
    ?.slice("example_visitor=".length);
  if (!encoded) return undefined;
  const [id, supplied] = encoded.split(".");
  if (!id || !supplied) return undefined;
  const expected = signature(id);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right) ? id : undefined;
}

const app = express();
app.use(express.json());
app.use((request, response, next) => {
  request.visitorId = visitor(request.get("cookie")) || `anon_${randomUUID()}`;
  if (!visitor(request.get("cookie"))) {
    response.setHeader(
      "Set-Cookie",
      `example_visitor=${request.visitorId}.${signature(request.visitorId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
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
});
app.use(customer);

async function discover(request, response) {
  const context = await customer.contextFor(request);
  const interests = new Set(context.items.map((item) => `${item.key}:${item.value}`));
  const placement = interests.has("interest:outdoor_travel")
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
