import express from "express";

import { agentFeedback } from "@agent-feedback/node/express";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");

const app = express();
app.use(express.json());
const feedback = agentFeedback({
  apiKey,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/api/status"],
  customerRef: (request) => request.header("x-customer-ref"),
  runtimeHint: (request) => request.header("user-agent"),
});
app.use(feedback);

app.get("/", (_request, response) => {
  response.json({
    example: "company-product-express-api",
    productEndpoint: "/api/status",
    integration: "One global Agent Feedback middleware instruments eligible responses.",
    reliability: {
      genericAgent: "best_effort",
      feedbackAwareAgent: "deterministic",
    },
    explanation:
      "A generic agent may ignore instructions embedded in HTTP data. A feedback-aware agent adapter explicitly reads the scoped receipt and submits the compact outcome.",
  });
});
app.get("/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
const status = async (_request, response) => {
  response.json({
    service: "checkout",
    available: true,
    region: "us-east",
    checkedAt: new Date().toISOString(),
    source: "example-company-live-status",
  });
};
app.get("/api/status", status);
app.post("/api/status", status);

const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
const shutdown = async () => {
  server.close();
  await feedback.shutdown();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
