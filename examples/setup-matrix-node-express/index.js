import express from "express";
import { agentFeedback } from "@agent-feedback/node/express";

const app = express();
const feedback = agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/search", "/docs/*"],
});
app.use(feedback);
app.get("/search", (_request, response) => response.json({ stack: "node-express", answer: "express-result" }));
app.get("/docs/test", (_request, response) => response.type("html").send("<!doctype html><html><head><title>Express docs</title></head><body>express-docs-result</body></html>"));
app.get("/health", (_request, response) => response.json({ ok: true }));

const server = app.listen(Number(process.env.PORT || 4101), "127.0.0.1");
const shutdown = () => server.close(async () => feedback.shutdown());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
