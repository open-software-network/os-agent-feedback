import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { agentFeedback } from "@epode/node/express";

const app = express();
function authenticate(request, response, next) {
  if (request.path === "/health") return next();
  const token = request.get("authorization")?.replace(/^Bearer\s+/i, "");
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
    return response.status(401).json({ error: "unauthorized" });
  }
  const accountId = Buffer.from(payload, "base64url").toString("utf8");
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(accountId)) {
    return response.status(401).json({ error: "unauthorized" });
  }
  request.auth = {
    accountId,
    userId: `user.${accountId}`,
    anonymousId: `anon.${accountId}`,
  };
  next();
}
app.use(authenticate);
const feedback = agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  include: ["/search", "/docs/*"],
  accountRef: (request) => request.auth?.accountId,
  userRef: (request) => request.auth?.userId,
  anonymousRef: (request) => request.auth?.anonymousId,
  // Ask once still uses the legacy stable subject while consent storage moves
  // to scoped customer grants. It is derived from the same verified auth.
  customerRef:
    process.env.AGENT_FEEDBACK_MODE === "ask_once"
      ? (request) => request.auth?.accountId
      : undefined,
});
app.use(feedback);
app.get("/search", (_request, response) => response.json({ stack: "node-express", answer: "express-result" }));
app.get("/docs/test", (_request, response) => response.type("html").send("<!doctype html><html><head><title>Express docs</title></head><body>express-docs-result</body></html>"));
app.get("/health", (_request, response) => response.json({ ok: true }));

const server = app.listen(Number(process.env.PORT || 4101), "127.0.0.1");
const shutdown = () => server.close(async () => feedback.shutdown());
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
