import express from "express";
import { agentFeedback } from "@agent-feedback/node/express";

const app = express();
app.use((request, _response, next) => {
  // These demo tokens stand in for the product's normal verified account and
  // signed first-party anonymous-session authentication.
  if (request.get("authorization") === "Bearer demo-search-workspace-token") {
    request.auth = {
      accountId: "acct_search_42",
      userId: "user_search_7",
      anonymousId: "anon_search_99",
      sessionId: "run_search_42",
    };
  } else if (request.get("authorization") === "Bearer demo-search-anonymous-token") {
    request.auth = {
      anonymousId: "anon_search_99",
      sessionId: "run_search_42",
    };
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
  accountRef: (request) => request.auth?.accountId,
  userRef: (request) => request.auth?.userId,
  anonymousRef: (request) => request.auth?.anonymousId,
  customerRef:
    process.env.AGENT_FEEDBACK_MODE === "ask_once"
      ? (request) => request.auth?.accountId
      : undefined,
  sessionRef: (request) => request.auth?.sessionId,
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
