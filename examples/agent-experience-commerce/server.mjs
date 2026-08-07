import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import express from "express";

import { AgentFeedbackRuntime } from "@epode/node";
import {
  createExperienceGraph,
  experienceTelemetryDetails,
  experienceTelemetryForNode,
} from "@epode/node/experience-graph";

import {
  humanCatalogSummary,
  lightingCatalog,
  productCatalog,
  productGraph,
} from "./catalog.mjs";

const PORT = Number(process.env.PORT || 4311);
const AGENT_UA =
  /claude-user|anthropic-ai|chatgpt-user|perplexity-user|cohere-ai|gemini-agent/i;
const RUNTIME_HINT = "agent-experience-commerce/1.0";
// Agent JSON hops carry no request observation, so the runtime hint is the
// only vendor evidence the backend's agent-mix insight can classify. Append
// the matched agent family (mirroring AGENT_UA) to the base hint.
const AGENT_VENDOR_HINTS = [
  [/claude-user|anthropic-ai/i, "claude-user"],
  [/chatgpt-user/i, "chatgpt-user"],
  [/perplexity-user/i, "perplexity-user"],
  [/cohere-ai/i, "cohere-ai"],
  [/gemini-agent/i, "gemini-agent"],
];

function runtimeHintFor(request) {
  const userAgent = request?.get("user-agent") || "";
  const vendor = AGENT_VENDOR_HINTS.find(([pattern]) => pattern.test(userAgent));
  return vendor ? `${RUNTIME_HINT} ${vendor[1]}` : RUNTIME_HINT;
}

const graph = createExperienceGraph(lightingCatalog);

const runtime = process.env.EPODE_API_KEY
  ? new AgentFeedbackRuntime({
      apiKey: process.env.EPODE_API_KEY,
      endpoint: process.env.EPODE_API_URL || process.env.AGENT_FEEDBACK_URL,
      feedbackMode: process.env.AGENT_FEEDBACK_MODE || "never_ask",
      include: [
        "/agent-negotiate/**",
        "/agent-decide/**",
        "/agent-product/**",
        "/agent-item",
        "/",
      ],
      runtimeHint: (request) => runtimeHintFor(request),
    })
  : null;

function json(response, status, body) {
  response.status(status);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.json(body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.status(status);
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.send(body);
}

function isAgent(request) {
  return AGENT_UA.test(request.get("user-agent") || "");
}

function originFor(request) {
  const host = request.get("x-forwarded-host") || request.get("host") || `127.0.0.1:${PORT}`;
  const proto = request.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

function recordHop(request, operation, journeyId, statusCode, durationMs, experience) {
  if (!runtime) return;
  try {
    const prepared = runtime.prepare();
    runtime.record(
      prepared,
      experienceTelemetryDetails({
        operation,
        journeyId,
        statusCode,
        durationMs,
        runtimeHint: runtimeHintFor(request),
        experience,
      }),
    );
    void runtime.flush().catch(() => {});
  } catch {
    // Product responses must never depend on telemetry delivery.
  }
}

function parseJourneyPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/").filter(Boolean);
  const [journeyId, category, ...tokens] = segments;
  if (!journeyId || !category) return null;
  return { journeyId, category, tokens };
}

function parseProductPath(pathname) {
  const prefix = "/agent-product/";
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/").filter(Boolean);
  const [journeyId, itemId, ...rest] = segments;
  if (!journeyId || !itemId) return null;
  const terminal = rest.at(-1);
  const tokens = terminal === "evaluate-fit" || terminal === "alternatives" ? rest.slice(0, -1) : rest;
  return { journeyId, itemId, tokens, terminal };
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    json(response, 200, { ok: true, product: "agent-experience-commerce" });
  });

  app.get("/", (request, response) => {
    const started = performance.now();
    const origin = originFor(request);
    if (isAgent(request)) {
      const journeyId = `j-${randomUUID()}`;
      const guide = graph.buildGuide(origin, journeyId);
      recordHop(request, "/agent-guide", journeyId, 200, Math.round(performance.now() - started));
      response.setHeader("vary", "User-Agent");
      return text(response, 200, guide);
    }

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Fieldnote Supply</title>
  <style>
    body { font-family: Georgia, serif; margin: 2rem auto; max-width: 42rem; color: #1c1917; }
    h1 { font-weight: 500; }
    .item { border-top: 1px solid #e7e5e4; padding: 1rem 0; }
    .muted { color: #78716c; }
  </style>
</head>
<body>
  <h1>Fieldnote Supply</h1>
  <p class="muted">Human storefront. Agent clients receive a machine-readable experience graph at this same URL.</p>
  ${humanCatalogSummary()
    .map(
      (item) => `<article class="item"><strong>${item.title}</strong><div class="muted">${item.brand} · $${item.price?.amount}</div></article>`,
    )
    .join("")}
</body>
</html>`;
    response.setHeader("vary", "User-Agent");
    return text(response, 200, html, "text/html; charset=utf-8");
  });

  app.get("/agent-negotiate/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseJourneyPath(request.path, "/agent-negotiate/");
    if (!parsed) return json(response, 400, { error: "invalid_negotiation_path" });
    if (parsed.category !== graph.definition.category) {
      return json(response, 404, {
        error: "unknown_category",
        available: [graph.definition.category],
      });
    }
    if (parsed.tokens.some((token) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token))) {
      return json(response, 400, {
        error: "invalid_need_token",
        message: "Need-state tokens use lowercase letters, numbers, and single hyphens.",
      });
    }
    try {
      const node = graph.buildNegotiation({
        origin: originFor(request),
        journeyId: parsed.journeyId,
        tokens: parsed.tokens,
      });
      recordHop(
        request,
        node.operation,
        parsed.journeyId,
        200,
        Math.round(performance.now() - started),
        experienceTelemetryForNode(node, { channel: "native_graph" }),
      );
      return json(response, 200, node);
    } catch (error) {
      return json(response, 400, { error: "invalid_negotiation", message: String(error) });
    }
  });

  app.get("/agent-decide/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseJourneyPath(request.path, "/agent-decide/");
    if (!parsed) return json(response, 400, { error: "invalid_decision_path" });
    if (parsed.category !== graph.definition.category) {
      return json(response, 404, {
        error: "unknown_category",
        available: [graph.definition.category],
      });
    }
    try {
      const node = graph.buildDecision({
        origin: originFor(request),
        journeyId: parsed.journeyId,
        tokens: parsed.tokens,
        searchId: randomUUID(),
      });
      const status = node.error ? 422 : 200;
      recordHop(
        request,
        node.operation,
        parsed.journeyId,
        status,
        Math.round(performance.now() - started),
        experienceTelemetryForNode(node, { channel: "native_graph" }),
      );
      return json(response, status, node);
    } catch (error) {
      return json(response, 400, { error: "invalid_decision", message: String(error) });
    }
  });

  app.get("/agent-product/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseProductPath(request.path);
    if (!parsed) return json(response, 400, { error: "invalid_product_graph_path" });
    if (parsed.tokens.some((token) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token))) {
      return json(response, 400, {
        error: "invalid_need_token",
        message: "Need-state tokens use lowercase letters, numbers, and single hyphens.",
      });
    }
    try {
      const options = {
        origin: originFor(request),
        journeyId: parsed.journeyId,
        itemId: parsed.itemId,
        tokens: parsed.tokens,
        searchId: randomUUID(),
      };
      const node =
        parsed.terminal === "evaluate-fit"
          ? productGraph.buildProductFit(options)
          : parsed.terminal === "alternatives"
            ? productGraph.buildProductAlternatives(options)
            : productGraph.buildProductGraph(options);
      if (!node) {
        return json(response, 404, {
          error: "item_not_found",
          requestedItemId: parsed.itemId,
          available: productCatalog.map((item) => item.id),
        });
      }
      const status = node.error === "alternatives_not_applicable" ? 409 : node.error ? 422 : 200;
      recordHop(
        request,
        node.operation,
        parsed.journeyId,
        status,
        Math.round(performance.now() - started),
        experienceTelemetryForNode(node, { channel: "native_graph" }),
      );
      return json(response, status, node);
    } catch (error) {
      return json(response, 400, { error: "invalid_product_graph", message: String(error) });
    }
  });

  app.get("/agent-item", (request, response) => {
    const started = performance.now();
    const itemId = String(request.query.item_id || "");
    const searchId = request.query.search_id ? String(request.query.search_id) : undefined;
    const position = request.query.position ? String(request.query.position) : undefined;
    const detail = graph.itemDetail(itemId, searchId, position);
    const status = detail.error ? 404 : 200;
    const journeyId = searchId ? `j-search-${searchId.slice(0, 8)}` : `j-item-${itemId || "unknown"}`;
    recordHop(
      request,
      detail.operation || "/agent-item",
      journeyId,
      status,
      Math.round(performance.now() - started),
      experienceTelemetryForNode(detail, { channel: "native_graph" }),
    );
    if (detail.error) return json(response, status, detail);
    const productJourneyId = `j-${randomUUID()}`;
    const productBase = `${originFor(request)}/agent-product/${productJourneyId}/${encodeURIComponent(itemId)}`;
    return json(response, status, {
      ...detail,
      evaluationGraph: {
        description:
          "Evaluate this product against the current task using fact-backed matches, conflicts, and unknowns.",
        startUrl: productBase,
        initialDimensions: ["purpose", "budget", "capability", "finish", "evidence"].map(
          (dimension) => ({
            dimension,
            url: `${productBase}/consider-${dimension}`,
          }),
        ),
      },
    });
  });

  return app;
}

export function startServer(port = PORT) {
  const app = createApp();
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        app,
        server,
        port: server.address().port,
        close: async () => {
          if (runtime) await runtime.shutdown().catch(() => {});
          await new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          });
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = await startServer(PORT);
  console.log(`agent-experience-commerce listening on http://127.0.0.1:${started.port}`);
}
