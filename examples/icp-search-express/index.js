import express from "express";
import { agentFeedback } from "@agent-feedback/node/express";

const app = express();
app.use((request, _response, next) => {
  // This demo token stands in for the product's normal authentication
  // middleware. customerRef must come from verified server-side auth, never a
  // caller-supplied account header.
  if (request.get("authorization") === "Bearer demo-search-workspace-token") {
    request.auth = { accountId: "acct_search_42" };
  }
  next();
});
const feedback = agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/v1/search"],
  // Search responses are CDN-cacheable for ordinary callers. Agents opt in
  // without forcing the public cache policy to change for everyone else.
  cacheMode: "request",
  customerRef: (request) => request.auth?.accountId,
  sessionRef: (request) => request.get("x-agent-run-id"),
  runtimeHint: (request) => request.get("x-agent-runtime"),
});
app.use(feedback);

app.get("/v1/search", (request, response) => {
  response.set("cache-control", "public, s-maxage=300, stale-while-revalidate=600");
  response.json({
    query: String(request.query.q || ""),
    results: [{ title: "Primary-source result", score: 0.97 }],
  });
});
app.get("/health", (_request, response) => response.json({ ok: true }));

const server = app.listen(Number(process.env.PORT || 4201), "127.0.0.1");
const shutdown = () => server.close(async () => feedback.shutdown());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
