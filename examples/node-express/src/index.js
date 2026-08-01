import express from "express";

import { agentFeedback } from "@agent-feedback/node/express";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");
const feedbackMode = process.env.AGENT_FEEDBACK_MODE || "never_ask";
const experimentRefsEnabled = process.env.EPODE_EXAMPLE_ENABLE_EXPERIMENT_REFS === "1";
if (!["never_ask", "ask_once", "ask_always", "off"].includes(feedbackMode)) {
  throw new Error("AGENT_FEEDBACK_MODE must be never_ask, ask_once, ask_always, or off");
}

const app = express();
app.use(express.json());
const feedback = agentFeedback({
  apiKey,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  feedbackMode,
  include: ["/api/status", "/api/recommendation"],
  // This hosted playground is anonymous. A real product should add customerRef
  // only after its authentication middleware has established a stable account.
  // Never turn a caller-supplied header into durable Ask-once identity.
  sessionRef: experimentRefsEnabled ? (request) => request.header("x-agent-session") : undefined,
  runtimeHint: (request) => request.header("user-agent"),
});
app.use(feedback);

app.get("/", (_request, response) => {
  response.json({
    example: "company-product-express-api",
    productEndpoints: ["/api/status", "/api/recommendation?priority=reliability"],
    sessionHeader: "x-agent-session",
    feedbackMode,
    integration: "One global Agent Feedback middleware instruments eligible responses.",
    reliability: {
      genericAgent: "best_effort",
      feedbackAwareAgent: "deterministic",
    },
    explanation:
      "A generic agent may ignore instructions embedded in HTTP data. A feedback-aware agent adapter explicitly reads the scoped receipt and submits the structured report.",
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

const recommendations = {
  reliability: {
    choice: "stable-channel",
    reason: "It has the strongest availability history and automatic fallback.",
    tradeoff: "Updates arrive less frequently.",
  },
  speed: {
    choice: "edge-channel",
    reason: "It has the lowest measured response latency.",
    tradeoff: "Regional behavior can vary during failover.",
  },
  cost: {
    choice: "batch-channel",
    reason: "It has the lowest cost per completed operation.",
    tradeoff: "Results may take up to five minutes.",
  },
};

app.get("/api/recommendation", (request, response) => {
  const priority = String(request.query.priority || "reliability").toLowerCase();
  const recommendation = recommendations[priority];
  if (!recommendation) {
    return response.status(400).json({
      error: "priority must be reliability, speed, or cost",
    });
  }
  return response.json({
    priority,
    recommendation,
    evaluatedAt: new Date().toISOString(),
    source: "epode-agent-playground",
  });
});

const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
const shutdown = async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await feedback.shutdown();
};
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
