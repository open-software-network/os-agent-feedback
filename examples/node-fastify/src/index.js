import Fastify from "fastify";

import { agentFeedback } from "@epode/node/fastify";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");

const app = Fastify({ logger: true });
await app.register(agentFeedback({
  apiKey,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/agent-docs", "/api/search"],
  // This public example is anonymous. Add customerRef only from identity that
  // product authentication has verified; never trust an account header here.
  runtimeHint: (request) => request.headers["user-agent"],
}));

app.get("/health", async () => ({ status: "ok" }));
app.get("/api/health", async () => ({ status: "ok" }));
app.get("/", async () => {
  return {
    example: "company-product-fastify-website",
    agentReadablePage: "/agent-docs",
    structuredEndpoint: "/api/search",
    integration: "One global Agent Feedback plugin instruments eligible responses.",
    reliability: {
      genericAgent: "best_effort",
      feedbackAwareAgent: "deterministic",
    },
  };
});
app.get("/agent-docs", async (_request, reply) => {
  reply.type("text/html; charset=utf-8");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Checkout status docs</title></head>
<body><main><h1>Checkout status documentation</h1><p>The checkout service is available in us-east.</p><p>Use <code>POST /api/search</code> with JSON <code>{"query":"checkout"}</code> for a structured result.</p><aside><strong>Feedback behavior:</strong> the embedded scoped feedback receipt is advisory for generic agents and deterministic when their runtime installs the feedback-aware HTTP adapter.</aside></main></body></html>`;
});
app.post("/api/search", async (request) => ({
  query: request.body?.query || "checkout",
  answer: "Checkout is available in us-east.",
  source: "live example product",
}));

await app.listen({ port: Number(process.env.PORT || 3001), host: "0.0.0.0" });
const shutdown = async () => app.close();
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
