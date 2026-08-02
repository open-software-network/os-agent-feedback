import { randomUUID } from "node:crypto";

import { epode } from "@epode/node/fastify";
import Fastify from "fastify";

const app = Fastify({ logger: true });
const decisions = new Map();
const authenticateSubscriber = async (request, reply) => {
  if (request.headers.authorization !== "Bearer demo-media-subscriber-token") {
    return reply.code(401).send({ error: "unauthorized" });
  }
  request.subscriber = { accountId: "media_household_12", userId: "subscriber_88" };
};

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  endpoint: process.env.EPODE_API_URL,
  include: ["/api/feed", "/agent-home"],
  purpose: "product_personalization",
  authenticate: authenticateSubscriber,
  identify: (request) => ({
    accountRef: request.subscriber?.accountId,
    userRef: request.subscriber?.userId,
  }),
});
await app.register(customer);

const catalog = [
  { id: "documentary-1", genre: "documentary", pace: "thoughtful" },
  { id: "comedy-1", genre: "comedy", pace: "light" },
  { id: "drama-1", genre: "drama", pace: "intense" },
];

app.get("/api/feed", async (request) => {
  const identity = {
    accountRef: request.subscriber.accountId,
    userRef: request.subscriber.userId,
  };
  const context = await customer.context.get({ ...identity, purpose: "product_personalization" });
  const preferences = new Set(context.items.map((item) => `${item.key}:${item.value}`));
  const titles = [...catalog].sort((left, right) => {
    const score = (title) =>
      (preferences.has(`genre:${title.genre}`) ? 4 : 0) +
      (preferences.has(`mood:${title.pace}`) ? 2 : 0);
    return score(right) - score(left);
  });
  let decisionId;
  if (context.available && context.items.length > 0) {
    const recorded = await customer.personalization.decide({
      externalDecisionId: `feed_${randomUUID()}`,
      contextRetrievalId: context.retrievalId,
      signalIds: context.items.map((item) => item.signalId),
      variant: "subscriber-context-feed-v1",
    });
    if (recorded.recorded) {
      decisionId = recorded.decision.id;
      decisions.set(request.subscriber.userId, decisionId);
    }
  }
  return { titles, personalized: Boolean(decisionId), decisionId };
});

app.post("/api/play", async (request, reply) => {
  const decisionId = decisions.get(request.subscriber.userId);
  if (decisionId) {
    await customer.outcomes.track({
      externalOutcomeId: `play_${randomUUID()}`,
      decisionId,
      outcome: "engagement",
    });
  }
  return reply.code(202).send({ playing: request.body?.titleId, recorded: Boolean(decisionId) });
});

app.get("/agent-home", async (_request, reply) => {
  reply.header("Content-Security-Policy", "default-src 'self'; script-src 'none'");
  reply.type("text/html; charset=utf-8");
  return "<!doctype html><html><head><title>Subscriber home</title></head><body><h1>Subscriber picks</h1></body></html>";
});

app.get("/health", async () => ({ ok: true }));
await app.listen({ port: Number(process.env.PORT || 4303), host: "0.0.0.0" });
