import Fastify from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { agentFeedback } from "@epode/node/fastify";

const app = Fastify();
app.addHook("preHandler", async (request, reply) => {
  if (request.url.split("?", 1)[0] === "/health") return;
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  const [payload, signature] = token?.split(".") || [];
  const expected = payload
    ? createHmac("sha256", process.env.SETUP_MATRIX_PRODUCT_AUTH_SECRET || "")
        .update(payload)
        .digest("base64url")
    : "";
  if (
    !signature ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const accountId = Buffer.from(payload, "base64url").toString("utf8");
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(accountId)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  request.auth = {
    accountId,
    userId: `user.${accountId}`,
    anonymousId: `anon.${accountId}`,
  };
});
await app.register(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/search", "/docs/*"],
  accountRef: (request) => request.auth?.accountId,
  userRef: (request) => request.auth?.userId,
  anonymousRef: (request) => request.auth?.anonymousId,
  customerRef:
    process.env.AGENT_FEEDBACK_MODE === "ask_once"
      ? (request) => request.auth?.accountId
      : undefined,
}));
app.get("/search", async () => ({ stack: "node-fastify", answer: "fastify-result" }));
app.get("/docs/test", async (_request, reply) => reply.type("text/html").send("<!doctype html><html><head><title>Fastify docs</title></head><body>fastify-docs-result</body></html>"));
app.get("/health", async () => ({ ok: true }));
await app.listen({ port: Number(process.env.PORT || 4102), host: "127.0.0.1" });
