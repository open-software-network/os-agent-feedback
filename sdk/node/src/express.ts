import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  encodedEnvelope,
  injectHtml,
  isPlainObject,
  normalizeOperation,
  type PreparedInteraction,
  type ProductSurface,
} from "./core.js";

const operationOverride = Symbol("agent-feedback-operation");

type InstrumentedRequest = Request & { [operationOverride]?: string };
type Instrumentation = {
  prepared: PreparedInteraction;
  surface: ProductSurface;
  operation: string;
};

export type AgentFeedbackExpress = RequestHandler & {
  /** Flush queued telemetry, for serverless waitUntil/lifecycle hooks. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  wrap(operation: string, handler: RequestHandler): RequestHandler;
};

function ensureRequestVary(response: Response): void {
  response.vary("Agent-Feedback-Request");
}

export function agentFeedback(options: AgentFeedbackOptions<Request>): AgentFeedbackExpress {
  const runtime = new AgentFeedbackRuntime(options);

  const middleware = ((request: InstrumentedRequest, response: Response, next: NextFunction) => {
    const started = performance.now();
    const requestContext = runtime.context(request);
    const matched = runtime.matches(request.originalUrl || request.url);
    if (matched && runtime.cacheMode === "request") ensureRequestVary(response);
    const consentState = matched
      ? runtime.cachedConsent(requestContext.customerRef)
      : "unavailable";
    let instrumentation: Instrumentation | undefined;
    let instrumentationSkipped = false;
    let recorded = false;
    const originalJson = response.json.bind(response);
    const originalSend = response.send.bind(response);

    const routePath = (): string => {
      const route = request.route as { path?: string | string[] } | undefined;
      const path = Array.isArray(route?.path) ? route.path[0] : route?.path;
      return `${request.baseUrl || ""}${path || request.path || "/"}`;
    };

    const attach = (surface: ProductSurface, body?: unknown): Instrumentation | undefined => {
      if (
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        request.method === "HEAD" ||
        !runtime.matches(request.originalUrl || request.url)
      ) {
        return undefined;
      }
      if (instrumentation) return instrumentation;
      if (
        !runtime.shouldInstrumentHttp({
          request,
          surface: surface as Exclude<ProductSurface, "mcp">,
          statusCode: response.statusCode,
          body,
          requestOptIn: request.get("agent-feedback-request") === "1",
          cacheControl: String(response.getHeader("cache-control") || ""),
        })
      ) {
        return undefined;
      }
      instrumentation = {
        prepared: runtime.prepare({
          customerRef: requestContext.customerRef,
          consentState,
        }),
        surface,
        operation: request[operationOverride] || normalizeOperation(routePath()),
      };
      response.setHeader("Cache-Control", "private, no-store");
      return instrumentation;
    };

    const attachHeaders = (current: Instrumentation): void => {
      if (!current.prepared.envelope) return;
      response.setHeader("Agent-Feedback", encodedEnvelope(current.prepared.envelope));
      response.append(
        "Link",
        `<${runtime.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"`,
      );
    };

    response.json = ((body: unknown) => {
      if (matched && runtime.cacheMode === "request") ensureRequestVary(response);
      if (isPlainObject(body)) {
        if (Object.hasOwn(body, "_agentFeedback")) {
          instrumentationSkipped = true;
          runtime.logger.warn(
            "[agent-feedback] Response already contains _agentFeedback; instrumentation was skipped.",
          );
          return originalJson(body);
        }
        const current = attach("http_json", body);
        return originalJson(
          current?.prepared.envelope
            ? { ...body, _agentFeedback: current.prepared.envelope }
            : body,
        );
      }
      const current = attach("http_headers", body);
      if (current) attachHeaders(current);
      return originalJson(body);
    }) as Response["json"];

    response.send = ((body?: unknown) => {
      if (matched && runtime.cacheMode === "request") ensureRequestVary(response);
      const contentType = String(response.getHeader("content-type") || "");
      if (typeof body === "string" && contentType.includes("text/html")) {
        const current = attach("http_html", body);
        return originalSend(
          current?.prepared.envelope ? injectHtml(body, current.prepared.envelope) : body,
        );
      }
      if (
        !instrumentationSkipped &&
        !instrumentation &&
        contentType.includes("application/json") &&
        (typeof body === "string" || body === null)
      ) {
        const current = attach("http_headers", body);
        if (current) attachHeaders(current);
      }
      return originalSend(body);
    }) as Response["send"];

    response.once("finish", () => {
      if (!instrumentation || recorded || response.statusCode < 200 || response.statusCode >= 300) {
        return;
      }
      recorded = true;
      runtime.record(instrumentation.prepared, {
        surface: instrumentation.surface,
        operation: instrumentation.operation,
        statusCode: response.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        customerRef: requestContext.customerRef,
        classification: "unclassified",
        runtimeHint: requestContext.runtimeHint,
        runtimeHintSource: requestContext.runtimeHint ? "http" : undefined,
        sessionRef: requestContext.sessionRef,
        sessionSource: requestContext.sessionRef ? "customer" : undefined,
      });
      runtime.warmConsent(requestContext.customerRef);
    });

    next();
  }) as AgentFeedbackExpress;

  middleware.flush = () => runtime.flush();
  middleware.shutdown = () => runtime.shutdown();
  middleware.wrap =
    (operation: string, handler: RequestHandler): RequestHandler =>
    (request, response, next) => {
      (request as InstrumentedRequest)[operationOverride] = operation;
      return handler(request, response, next);
    };
  return middleware;
}

export default agentFeedback;
