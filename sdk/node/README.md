# `@epode/node`

Serve agent experience graphs, learn useful permissioned context about known, anonymous, or ephemeral
customers through the AI agents acting for them, personalize the product, and link the business outcome to the
exact context used.

The customer does not install Epode, create an Epode account, or receive a company product key.

## Agent experience graph

```ts
import {
  createExperienceGraph,
  createLightingExperienceCatalog,
  experienceTelemetryDetails,
} from "@epode/node/experience-graph";

const graph = createExperienceGraph(createLightingExperienceCatalog());
const negotiation = graph.buildNegotiation({
  origin: "https://shop.example",
  journeyId: "j-...",
  tokens: ["budget-hard-150", "purpose-coding"],
});
const decision = graph.buildDecision({
  origin: "https://shop.example",
  journeyId: "j-...",
  tokens: ["budget-hard-150", "purpose-coding", "color-prefer-orange"],
});
```

Need state stays in the product response and merchant-authored path. Map each hop onto ordinary Epode telemetry
with `experienceTelemetryDetails({ operation, journeyId })` so the closed telemetry schema does not need a
free-form need-state field.

See `examples/agent-experience-commerce` for a complete Fieldnote reference product.

### Programmable domains

For categories with custom state and decision semantics, implement
`AgentExperienceDomain<State>` and use `parseDomainNeedTokens`,
`buildDomainNegotiationNode`, `buildDomainDecisionNode`, and `buildDomainItemNode`. The programmable
builders use the v2 identifiers in `AGENT_EXPERIENCE_PROTOCOLS`; the existing
`createExperienceGraph` v1 wire contract is unchanged. Catalog records include a summary, explicit
`notSpecified` facts, and typed, attributed seller claims.

### Product reverse search

```ts
import { createProductExperienceGraph } from "@epode/node/product-graph";

const productGraph = createProductExperienceGraph(productDefinition);
const graphNode = productGraph.buildProductGraph({
  origin: "https://shop.example",
  journeyId: "j-...",
  itemId: "desk-lamp",
  tokens: [],
});
const fitNode = productGraph.buildProductFit({
  origin: "https://shop.example",
  journeyId: "j-...",
  itemId: "desk-lamp",
  tokens: ["purpose-coding"],
});
```

The returned graph exposes exact merchant-authored hops. Fit results separate fact-backed matches,
hard conflicts, soft conflicts, and unknowns that matter; evidence is tagged as `catalog_fact`,
`seller_claim`, or `unknown`. Seller claims cannot establish a fully suitable verdict, and
`buildProductAlternatives` succeeds only after a non-suitable fit.

## Express customer enrichment

```sh
npm install @epode/node express
```

```ts
import { epode } from "@epode/node/express";

app.use(express.json());
app.use(issueOrVerifyFirstPartyVisitor);

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  include: ["/api/recommendations"],
  purpose: "product_personalization",
  authenticate: authenticateProductRequest,
  identify: req => ({
    accountRef: req.user?.accountId,
    userRef: req.user?.id,
    anonymousRef: req.firstPartyVisitorId,
  }),
  sessionRef: req => req.productJourney?.id,
  runtimeHint: req => req.verifiedAgentRuntime,
});
app.use(customer);
```

The middleware preserves the original JSON shape and adds `_epode.customerContext` only when Epode returns a
useful request. It automatically mounts the fixed same-origin permission and answer routes. On timeout or Epode
failure, it sends the original product response unchanged.

Pass rejecting product authentication through `authenticate`. It runs only on included business routes and is
bypassed only by the exact capability-authenticated relay paths. Successful bounded HTML strings receive a
non-executable `epode-customer-context` meta marker; CSP, visible content, streams, buffers, and oversized pages
are preserved.

The selected response waits up to `timeoutMs` (250 ms by default) for enrichment, then fails open. For an
ephemeral customer, use `customer.contextFor(req)`: it validates the bounded `Epode-Context-Interaction` header
that the agent returns on the immediate retry. That handle does not persist across unrelated interactions.
The same enrichment call records response status and duration. `sessionRef` must be a product-issued journey;
`runtimeHint` is an optional bounded label. Neither should come from an untrusted request parameter.

Express and Fastify also record the framework-resolved peer IP, HTTP method, user agent, accepted language,
referrer origin, and User-Agent Client Hints automatically. The allowlist excludes cookies, authorization,
request bodies, full referrer URLs, query strings, forwarding chains, and arbitrary headers. MAC addresses are
not visible across routed HTTP. Proxy-derived IPs are honored only when the host app explicitly configures the
framework to trust that proxy. These request facts follow the product's interaction-retention period and are
never used to merge customers or infer sessions.

Retrieve and use context inside the company:

```ts
const context = await customer.contextFor(req);

const products = context.available
  ? rankForCustomer(catalog, context.items)
  : rankNormally(catalog);
```

Record exactly which signals affected the experience, then link its outcome:

```ts
const result = await customer.personalization.decide({
  externalDecisionId: recommendation.id,
  contextRetrievalId: context.retrievalId,
  signalIds: context.items.map(item => item.signalId),
  variant: "customer-context-ranking-v1",
});

if (result.recorded) {
  await customer.outcomes.track({
    externalOutcomeId: order.id,
    decisionId: result.decision.id,
    outcome: "conversion",
  });
}
```

`product_personalization` and `targeted_advertising` are separate purposes. Approval, retrieval, decisions, and
audit history never cross between them.

## MCP customer enrichment

```ts
import { epode } from "@epode/node/mcp";

const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  includeTools: ["search_products"],
  purpose: "product_personalization",
  identify: (_args, context) => ({
    accountRef: context.http?.authInfo?.extra?.accountId,
    userRef: context.http?.authInfo?.extra?.userId,
  }),
  sessionRef: context => context.http?.authInfo?.extra?.journeyId,
  runtimeHint: context => context.http?.authInfo?.extra?.runtimeHint,
});

customer.instrument(server);
```

This registers `record_customer_context_consent` and `share_customer_context` on the company's MCP server and
decorates only selected complete, successful business-tool results. The `surface: "mcp"` enrichment request also
confirms that initial product interaction immediately; no second Epode instrumentation layer is needed. The agent
never calls Epode directly.
The session and runtime callbacks receive only the server context, never model-authored tool arguments or output.

`fields` narrows what the product may ask for. Pass a static key list, or an async planner that reads company
state and returns the missing field keys for the completed operation:

```ts
const customer = epode({
  apiKey: process.env.EPODE_API_KEY,
  includeTools: ["search_products"],
  fields: async ({ name }) => {
    const known = await customerGraph.contextKeys(currentIdentity());
    return eligibleFields(name).filter((key) => !known.has(key));
  },
});
```

The planner runs only after a complete, successful result. Returning an empty array skips enrichment for that
call; a planner error preserves the business result and skips enrichment. Keys are validated server-side against
the product's field definitions and operation bindings, so an unknown or unbound key fails closed.

## Legacy structured outcome feedback

The `agentFeedback`, `createMcpInstrumentation`, and feedback-agent helper exports remain available for the
existing structured product-feedback workflow. New company onboarding should start with customer enrichment.

## Express

Until the npm registry release is connected, install the signed build directly from the production service:

```sh
npm install https://app.epode.ai/static/agent-feedback-node-0.4.0.tgz
```

```ts
import { agentFeedback } from "@epode/node/express";

app.use(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  include: ["/search", "/docs/*"],
  accountRef: req => req.user?.accountId,
  userRef: req => req.user?.id,
  anonymousRef: req => req.firstPartyVisitorId,
  customerRef: req => req.user?.accountId, // stable opaque ID; required for durable Ask once
}));
```

Use `accountRef` and `userRef` for new integrations. `anonymousRef` supports a first-party pre-login
journey, and co-supplying it after authentication authorizes deterministic progressive resolution.
`customerRef` remains the compatible opaque Ask-once subject and legacy customer reference. Never
derive any of these from agent arguments, names, emails, or untrusted raw request values. They travel
only in background telemetry and are never exposed to the agent.

Compatible JSON objects receive `_agentFeedback`. HTML receives an embedded `application/json` handoff. Arrays and scalar JSON responses use `Agent-Feedback` and `Link` headers. Errors, redirects, streams, binary responses, assets, health routes, and unrelated routes are untouched. These HTTP opportunities remain unclassified unless the scoped receipt returns.

The default `cacheMode: "safe"` skips responses with an explicit shared-cache policy instead of silently disabling their CDN behavior. Use `cacheMode: "request"` to instrument only requests carrying `Agent-Feedback-Request: 1`; it emits `Vary: Agent-Feedback-Request` on both variants and a same-path-and-query discovery `Link` on eligible ordinary 2xx `GET`/`HEAD` responses. The opted-in capability is `private, no-store`. Use `cacheMode: "private"` when every included response is intentionally private. Use `shouldInstrument(req, response)` for terminal async-job results. `*` matches one path segment and `**` matches any depth.

The returned Express middleware and Fastify plugin expose `flush()`. In serverless runtimes, pass that promise to the platform's post-response `waitUntil` hook. Keep product responses independent of telemetry delivery.

## Fastify

```ts
import { agentFeedback } from "@epode/node/fastify";

await app.register(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  include: ["/search", "/docs/*"],
}));
```

## Static sites and hosted docs at a trusted edge

`createStaticDocsProxy` provides a Cloudflare Worker-compatible reverse proxy for finite static HTML. It keeps
the product key in the edge runtime, leaves the upstream body byte-for-byte, preserves ordinary public caching,
and gives only an explicit `Agent-Feedback-Request: 1` refetch a private capability header. Reports still submit
directly to Epode; the edge is not a feedback relay.

The proxy is cross-origin and fail-closed: it forwards only safe representation/conditional headers, never caller
credentials, cookies, origin/referrer, forwarding metadata, or hop-by-hop headers. It strips upstream cookies,
authentication challenges, `Clear-Site-Data`, and hop-by-hop headers from every response and redirect. For a private
origin, pass a separate edge-secret `upstreamAuthorization`; callers cannot override it.

Bind the Worker only to dedicated public docs routes, never a hostname-wide catch-all. The `include` list is a
second fail-closed boundary: unmatched paths return 404 and methods other than GET or HEAD return 405 without
contacting the upstream origin.

```ts
import { createStaticDocsProxy } from "@epode/node/edge";

let proxy;
export default {
  fetch(request, env, context) {
    // The edge platform must route only dedicated public docs paths here.
    proxy ??= createStaticDocsProxy({
      apiKey: env.AGENT_FEEDBACK_KEY,
      upstreamOrigin: "https://docs-origin.example.com",
      upstreamAuthorization: env.DOCS_UPSTREAM_AUTHORIZATION || undefined,
      include: ["/docs", "/docs/**"],
    });
    return proxy.fetch(request, context);
  },
};
```

The upstream and public origins must differ. Explicit streams, attachments, non-HTML and error responses remain
untouched. Store the key with the edge platform's secret manager, never in a static build or client script.

## MCP 2026-07-28

The current MCP transport is stateless and creates a fresh server for each HTTP request. Create one process-level Epode runtime so telemetry remains batched, then instrument each server before registering business tools:

```ts
import { createMcpInstrumentation } from "@epode/node/mcp";
import { originValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  includeTools: ["browser_*"],
  feedbackTools: ["browser_close"],
  customerRef: (_args, context) => context.http?.authInfo?.extra?.accountId,
  sessionRef: (args, context, result) => {
    const accountId = verifiedAccountId(context);
    const candidate = result?.structuredContent?.journeyId ?? args.journeyId;
    return journeyRegistry.resolve(accountId, candidate);
  },
});

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name: "my-product", version: "1.0.0" });
  feedback.instrument(server);
  // Register your product tools after instrumentation.
  return server;
}, { legacy: "stateless" });

// [] rejects browser Origin requests; add only trusted browser client hostnames.
app.use("/mcp", originValidation([]));
const handleMcp = toNodeHandler(mcp);
app.all("/mcp", (req, res) => handleMcp(req, res, req.body));
```

The official handler implements `server/discover`, per-request protocol metadata, `Mcp-Method`/`Mcp-Name` validation, cache hints, and the required `resultType` field. Its legacy fallback keeps 2025-era clients working without transport-session state. Business-tool results are decorated automatically and both feedback tools are registered for the customer agent. Schema-less object results use `structuredContent._agentFeedback`; tools with `outputSchema` keep their business `structuredContent` untouched and receive the same envelope in a standalone JSON `TextContent` block. MCP tool use is a confirmed agent interaction.

`includeTools` controls which business tools become interactions. `feedbackTools` narrows feedback requests to meaningful outcome boundaries while retaining the whole journey in Sessions. `shouldRequestFeedback` can make that decision from the completed result. Extractors receive `(arguments, context, result?)`, which supports grouping a session-creation call by the ID it returns.

Treat IDs in typed arguments and results as candidates only. Resolve them through durable, authenticated,
account-scoped product state before returning a `sessionRef`; never return a candidate directly. The create call
can register and return a canonical journey, and follow-ups, cache hits, and deduplicated calls then reuse it.
Each completed call still receives a fresh telemetry interaction UUID. A failed call may remain linked when the
registry proves ownership; missing, malformed, unknown, or cross-account proof stays unlinked. An MCP transport
session ID is never a fallback. `createMcpInstrumentation` is the recommended public completion path;
instrumentation creates telemetry internally rather than exposing a manual recorder or raw telemetry API.

Background telemetry uses a bounded queue, a 30-second background-only timeout, and bounded exponential retry. The MCP report tool uses a 10-second timeout and tells the agent to retry exactly once when a transient failure is safe to retry. Neither path delays or fails the normal product result.

`instrumentMcp(server, options)` remains available for existing long-lived or legacy server objects.

## Optional feedback-aware HTTP agent adapter

Agent runtimes that want deterministic HTTP/HTML feedback can explicitly consume the contract:

```ts
import {
  feedbackFromResponse,
  inspectProductFeedback,
  submitFeedbackConsent,
  submitProductFeedback,
} from "@epode/node/agent";

const response = await fetch(productUrl);
const body = await response.json();
const feedback = feedbackFromResponse(response, body);

if (feedback) {
  const inspection = await inspectProductFeedback(feedback);
  if (inspection.action === "ask") {
    const approved = await askUser(inspection.canonicalQuestion);
    const decision = await submitFeedbackConsent(feedback, approved ? "approved" : "declined");
    if (decision.state !== "approved") return;
  }
  if (inspection.action === "skip") return;
  await submitProductFeedback(
    feedback,
    {
      summary: "The product completed the task, but required a retry.",
      impact: "helped_with_friction",
      findings: [{ kind: "friction", topic: "reliability", severity: "minor", detail: "The first request timed out." }],
      workaround: { used: true, detail: "The agent retried once." },
    },
    { allowedSubmitOrigins: ["https://app.epode.ai"] },
  );
}
```

The adapter requires an allow-listed HTTPS destination, never follows redirects, and submits only the structured report fields. `inspectProductFeedback`, `submitFeedbackConsent`, and `submitProductFeedback` all resolve the current capability state before side effects, so a stale response cannot repeat a permission question or overwrite a remembered decision. In Ask once mode, Epode stores only the decision and the SDK-derived opaque subject; the agent runtime has no consent preference store.

## Verify the whole loop

```sh
npx agent-feedback-doctor https://your-product.example/search?q=test
```

The doctor sends `Agent-Feedback-Request: 1`, so the same command verifies request-mode handoffs without
compromising shared caches. For a product route protected by your own authentication, keep that test credential
in an environment variable and pass only its header mapping:

```sh
export PRODUCT_TEST_AUTHORIZATION="Bearer $PRODUCT_TEST_TOKEN"
npx agent-feedback-doctor \
  --header-env Authorization=PRODUCT_TEST_AUTHORIZATION \
  https://your-product.example/private-search?q=test
```

The doctor refuses an `af_live_...` or `af_read_...` value, never forwards product-route headers to Epode, and
never follows a redirect with authentication. Do not use `AGENT_FEEDBACK_KEY` here.

In `never_ask` mode, the doctor verifies response injection and submits a real synthetic review with the scoped
receipt. In either consent mode, it validates the consent contract but does not submit a review because a
diagnostic cannot impersonate user approval. Set `AGENT_FEEDBACK_ENABLED=false` as an emergency kill switch.
