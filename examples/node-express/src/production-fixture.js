#!/usr/bin/env node

import express from "express";

import { agentFeedback } from "@agent-feedback/node/express";

const apiKey = process.env.AGENT_FEEDBACK_KEY;
if (!apiKey) throw new Error("AGENT_FEEDBACK_KEY is required");
const feedbackMode = process.env.AGENT_FEEDBACK_MODE || "ask_always";
if (!new Set(["ask_once", "ask_always"]).has(feedbackMode)) {
  throw new Error("AGENT_FEEDBACK_MODE must be ask_once or ask_always");
}

const app = express();
const feedback = agentFeedback({
  apiKey,
  endpoint: process.env.AGENT_FEEDBACK_URL,
  feedbackMode,
  include: ["/json", "/html", "/header-only"],
  customerRef: (request) => request.header("x-customer-ref"),
  sessionRef: (request) => request.header("x-agent-session"),
  runtimeHint: (request) => request.header("user-agent"),
});
app.use(feedback);

app.get("/json", (_request, response) => {
  response.json({ service: "checkout", available: true, region: "us-east" });
});

app.get("/html", (_request, response) => {
  response.type("html").send(
    "<!doctype html><html><head><title>Checkout status</title></head><body><main>Checkout is available in us-east.</main></body></html>",
  );
});

app.get("/header-only", (_request, response) => {
  response.json(["checkout", "available", "us-east"]);
});

app.get("/health", (_request, response) => response.json({ status: "ok" }));

const server = app.listen(Number(process.env.PORT || 4350), "127.0.0.1");
async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await feedback.shutdown();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
