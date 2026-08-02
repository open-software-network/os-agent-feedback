import { randomUUID } from "node:crypto";

import { epode } from "@epode/node/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const app = createMcpExpressApp({ host: "0.0.0.0", allowedOrigins: [] });
const decisions = new Map();
const verifiedExtra = (context, key) => {
  const value = context.http?.authInfo?.extra?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};
const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  endpoint: process.env.EPODE_API_URL,
  includeTools: ["search_stays"],
  purpose: "product_personalization",
  identify: (_arguments, context) => ({
    accountRef: verifiedExtra(context, "accountId"),
    userRef: verifiedExtra(context, "userId"),
  }),
  sessionRef: (context) => verifiedExtra(context, "journeyId"),
  runtimeHint: (context) => verifiedExtra(context, "runtimeHint"),
});

function createProductServer() {
  const server = new McpServer(
    { name: "example-travel-company", version: "1.0.0" },
    {
      instructions:
        "Use the travel tools to complete the customer's task. Customer-context actions are company-owned tools: finish the travel result first, ask only the exact returned permission question, and never infer approval or sensitive attributes.",
    },
  );
  customer.instrument(server);
  server.registerTool(
    "search_stays",
    {
      description: "Search and personalize hotel options for the authenticated traveler.",
      inputSchema: z.object({ city: z.string(), checkIn: z.string(), checkOut: z.string() }),
    },
    async ({ city, checkIn, checkOut }, context) => {
      const identity = {
        accountRef: context.http?.authInfo?.extra?.accountId,
        userRef: context.http?.authInfo?.extra?.userId,
      };
      const profile = await customer.context.get({
        ...identity,
        purpose: "product_personalization",
      });
      const preferences = new Set(profile.items.map((item) => `${item.key}:${item.value}`));
      const stays = [
        { id: "central-flex", area: "central", nightly: 285, flexible: true, quiet: true },
        { id: "value-stay", area: "airport", nightly: 170, flexible: false, quiet: true },
        { id: "social-stay", area: "central", nightly: 240, flexible: true, quiet: false },
      ].sort((left, right) => {
        const score = (stay) =>
          (preferences.has("location:central") && stay.area === "central" ? 5 : 0) +
          (preferences.has("cancellation:flexible") && stay.flexible ? 4 : 0) +
          (preferences.has("room:quiet") && stay.quiet ? 3 : 0);
        return score(right) - score(left);
      });
      let decisionId;
      if (profile.available && profile.items.length > 0) {
        const recorded = await customer.personalization.decide({
          externalDecisionId: `travel_search_${randomUUID()}`,
          contextRetrievalId: profile.retrievalId,
          signalIds: profile.items.map((item) => item.signalId),
          variant: "traveler-preference-ranking-v1",
        });
        if (recorded.recorded) {
          decisionId = recorded.decision.id;
          decisions.set(String(identity.userRef), decisionId);
        }
      }
      const result = { city, checkIn, checkOut, stays, personalized: Boolean(decisionId), decisionId };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );
  server.registerTool(
    "book_stay",
    {
      description: "Book a selected stay and record the outcome of any personalization used.",
      inputSchema: z.object({ stayId: z.string() }),
    },
    async ({ stayId }, context) => {
      const userId = String(context.http?.authInfo?.extra?.userId || "");
      const decisionId = decisions.get(userId);
      if (decisionId) {
        await customer.outcomes.track({
          externalOutcomeId: `booking_${randomUUID()}`,
          decisionId,
          outcome: "conversion",
        });
      }
      const result = { bookingId: `booking_${randomUUID()}`, stayId, personalized: Boolean(decisionId) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );
  return server;
}

const handleMcp = toNodeHandler(
  createMcpHandler(createProductServer, { legacy: "stateless", responseMode: "json" }),
);
app.use("/mcp", (request, response, next) => {
  if (request.get("authorization") !== "Bearer demo-travel-customer-token") {
    return response.status(401).json({ error: "unauthorized" });
  }
  request.auth = {
    token: "verified-travel-token",
    clientId: "travel-client",
    scopes: ["mcp"],
    extra: {
      accountId: "travel_loyalty_42",
      userId: "traveler_7",
      journeyId: "travel_journey_7",
      runtimeHint: "travel-mcp-client/1.0",
    },
  };
  next();
});
app.all("/mcp", (request, response) => handleMcp(request, response, request.body));
app.get("/health", (_request, response) => response.json({ ok: true }));
app.listen(Number(process.env.PORT || 4302), "0.0.0.0");
