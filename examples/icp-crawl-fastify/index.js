import Fastify from "fastify";
import { agentFeedback } from "@agent-feedback/node/fastify";

const app = Fastify({ logger: false });
const jobs = new Map();
const feedback = agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/v1/crawls/*"],
  // Polling is not an outcome. Only a terminal crawl result should ask the
  // customer agent to evaluate the product.
  shouldInstrument: (_request, response) => response.body?.status === "completed",
  customerRef: (request) => request.headers["x-team-id"],
  sessionRef: (request) => request.headers["x-agent-run-id"],
});
await app.register(feedback);

app.post("/v1/crawls", async (request, reply) => {
  const id = `crawl_${jobs.size + 1}`;
  jobs.set(id, { polls: 0, url: request.body?.url || "https://example.test" });
  return reply.code(202).send({ id, status: "running" });
});
app.get("/v1/crawls/:id", async (request, reply) => {
  const job = jobs.get(request.params.id);
  if (!job) return reply.code(404).send({ error: "not_found" });
  job.polls += 1;
  if (job.polls < 2) return { id: request.params.id, status: "running" };
  return {
    id: request.params.id,
    status: "completed",
    pages: [{ url: job.url, markdown: "# Extracted page" }],
  };
});
app.get("/health", async () => ({ ok: true }));

await app.listen({ port: Number(process.env.PORT || 4202), host: "127.0.0.1" });
