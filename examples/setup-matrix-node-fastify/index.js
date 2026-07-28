import Fastify from "fastify";
import { agentFeedback } from "@agent-feedback/node/fastify";

const app = Fastify();
await app.register(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/search", "/docs/*"],
}));
app.get("/search", async () => ({ stack: "node-fastify", answer: "fastify-result" }));
app.get("/docs/test", async (_request, reply) => reply.type("text/html").send("<!doctype html><html><head><title>Fastify docs</title></head><body>fastify-docs-result</body></html>"));
app.get("/health", async () => ({ ok: true }));
await app.listen({ port: Number(process.env.PORT || 4102), host: "127.0.0.1" });
