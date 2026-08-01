# `@agent-feedback/node`

Collect one structured feedback report from the independent customer agents using your product. The SDK never identifies an agent or sends prompts or product payloads. Telemetry and Ask once state resolution never block the HTTP response. Eligible Ask once responses always carry a subject-bound receipt; Epode Companion verifies that receipt and resolves the remembered decision before it asks or reports.

There are two reliability levels:

- **MCP is protocol-backed.** The SDK registers explicit `record_product_feedback_consent` and `report_product_feedback` tools. Each product result directs compatible agents to the action currently allowed.
- **Ask once is Epode-managed.** Unknown customers receive only the exact question and an `approved|declined` action. Epode remembers the answer by product plus an opaque subject derived from `customerRef`; agents store nothing.
- **Ask every time is also two phase.** Approval reveals a report action for that interaction only. Silence or refusal never reveals it.
- **Consent is enforced end to end.** Ask-mode report schemas are withheld until approval, and report bodies never contain consent attestations.
- **HTTP and HTML are best-effort by default.** Generic agents may treat response metadata as untrusted and ignore its side-effect instruction. A feedback-aware agent adapter can make submission deterministic.

## Express

Until the npm registry release is connected, install the signed build directly from the production service:

```sh
npm install https://app.epode.ai/static/agent-feedback-node-0.1.0.tgz
```

```ts
import { agentFeedback } from "@agent-feedback/node/express";

app.use(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  include: ["/search", "/docs/*"],
  customerRef: req => req.user?.accountId, // stable opaque ID; required for durable Ask once
}));
```

Compatible JSON objects receive `_agentFeedback`. HTML receives an embedded `application/json` handoff. Arrays and scalar JSON responses use `Agent-Feedback` and `Link` headers. Errors, redirects, streams, binary responses, assets, health routes, and unrelated routes are untouched. These HTTP opportunities remain unclassified unless the scoped receipt returns.

The default `cacheMode: "safe"` skips responses with an explicit shared-cache policy instead of silently disabling their CDN behavior. Use `cacheMode: "request"` to instrument only requests carrying `Agent-Feedback-Request: 1`; it also emits `Vary: Agent-Feedback-Request` so a shared cache cannot hide an opted-in request. Use `cacheMode: "private"` when every included response is intentionally private. Use `shouldInstrument(req, response)` for terminal async-job results. `*` matches one path segment and `**` matches any depth.

The returned Express middleware and Fastify plugin expose `flush()`. In serverless runtimes, pass that promise to the platform's post-response `waitUntil` hook. Keep product responses independent of telemetry delivery.

## Fastify

```ts
import { agentFeedback } from "@agent-feedback/node/fastify";

await app.register(agentFeedback({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  include: ["/search", "/docs/*"],
}));
```

## MCP 2026-07-28

The current MCP transport is stateless and creates a fresh server for each HTTP request. Create one process-level Epode runtime so telemetry remains batched, then instrument each server before registering business tools:

```ts
import { createMcpInstrumentation } from "@agent-feedback/node/mcp";
import { originValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const feedback = createMcpInstrumentation({
  apiKey: process.env.AGENT_FEEDBACK_KEY!,
  includeTools: ["browser_*"],
  feedbackTools: ["browser_close"],
  customerRef: (_args, context) => context.http?.authInfo?.extra?.accountId,
  sessionRef: (args, _context, result) =>
    args.sessionId || result?.structuredContent?.sessionId,
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

The official handler implements `server/discover`, per-request protocol metadata, `Mcp-Method`/`Mcp-Name` validation, cache hints, and the required `resultType` field. Its legacy fallback keeps 2025-era clients working without transport-session state. Business-tool results are decorated automatically and both feedback tools are registered for the customer agent. MCP tool use is a confirmed agent interaction.

`includeTools` controls which business tools become interactions. `feedbackTools` narrows feedback requests to meaningful outcome boundaries while retaining the whole journey in Sessions. `shouldRequestFeedback` can make that decision from the completed result. Extractors receive `(arguments, context, result?)`, which supports grouping a session-creation call by the ID it returns.

Background telemetry uses a bounded queue, a 30-second background-only timeout, and bounded exponential retry. The MCP report tool uses a 10-second timeout and tells the agent to retry exactly once when a transient failure is safe to retry. Neither path delays or fails the normal product result.

`instrumentMcp(server, options)` remains available for existing long-lived or legacy server objects.

## Optional feedback-aware HTTP agent adapter

Agent runtimes that want deterministic HTTP/HTML feedback can explicitly consume the contract:

```ts
import {
  feedbackConsentAction,
  feedbackFromResponse,
  submitFeedbackConsent,
  submitProductFeedback,
} from "@agent-feedback/node/agent";

const response = await fetch(productUrl);
const body = await response.json();
const feedback = feedbackFromResponse(response, body);

if (feedback) {
  let reportContract = feedback;
  const action = feedbackConsentAction(feedback);
  if (action === "ask") {
    const approved = await askUser(feedback.requiredAction.question);
    const decision = await submitFeedbackConsent(feedback, approved ? "approved" : "declined");
    if (!decision.feedback) return;
    reportContract = decision.feedback;
  }
  if (feedbackConsentAction(reportContract) !== "submit") return;
  await submitProductFeedback(
    reportContract,
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

The adapter requires an allow-listed HTTPS destination and submits only the structured report fields. In Ask once mode, Epode stores only the decision and the SDK-derived opaque subject; the agent runtime has no consent preference store.

## Verify the whole loop

```sh
npx agent-feedback-doctor https://your-product.example/search?q=test
```

In `never_ask` mode, the doctor verifies response injection and submits a real synthetic review with the scoped receipt. In either consent mode, it validates the consent contract but does not submit a review because a diagnostic cannot impersonate user approval. Set `AGENT_FEEDBACK_ENABLED=false` as an emergency kill switch.
