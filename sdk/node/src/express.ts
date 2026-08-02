import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  encodedEnvelope,
  hasEmbeddedFeedback,
  injectHtml,
  isPlainObject,
  normalizeOperation,
  type PreparedInteraction,
  type ProductSurface,
  requestDiscoveryLink,
} from "./core.js";

const operationOverride = Symbol("agent-feedback-operation");

type InstrumentedRequest = Request & { [operationOverride]?: string };
type Instrumentation = {
  prepared: PreparedInteraction;
  surface: ProductSurface;
  operation: string;
  context: {
    accountRef?: string;
    userRef?: string;
    anonymousRef?: string;
    customerRef?: string;
    sessionRef?: string;
    runtimeHint?: string;
  };
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

function appendLink(response: Response, value: string): void {
  response.append("Link", value);
}

function isCompleteSuccess(response: Response): boolean {
  return (
    response.statusCode >= 200 &&
    response.statusCode < 300 &&
    response.statusCode !== 204 &&
    response.statusCode !== 205 &&
    response.statusCode !== 206 &&
    response.getHeader("content-range") === undefined
  );
}

function stripBodyValidators(response: Response): void {
  for (const name of [
    "etag",
    "content-md5",
    "digest",
    "content-digest",
    "repr-digest",
    "content-range",
    "accept-ranges",
  ]) {
    response.removeHeader(name);
  }
}

const CDN_CACHE_CONTROL_HEADERS = [
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "surrogate-control",
] as const;

function cacheControlValues(response: Response): string[] {
  return ["cache-control", ...CDN_CACHE_CONTROL_HEADERS]
    .map((name) => response.getHeader(name))
    .filter((value) => value !== undefined)
    .map(String);
}

function makeResponsePrivate(response: Response): void {
  for (const name of CDN_CACHE_CONTROL_HEADERS) response.removeHeader(name);
  response.setHeader("Cache-Control", "private, no-store");
}

export function agentFeedback(options: AgentFeedbackOptions<Request>): AgentFeedbackExpress {
  const runtime = new AgentFeedbackRuntime(options);

  const middleware = ((request: InstrumentedRequest, response: Response, next: NextFunction) => {
    const started = performance.now();
    const matched = runtime.matches(request.originalUrl || request.url);
    if (matched && runtime.cacheMode === "request") ensureRequestVary(response);
    let instrumentation: Instrumentation | undefined;
    let instrumentationSkipped = false;
    let recorded = false;
    let discoveryAttached = false;
    let feedbackHeadersAttached = false;
    const originalJson = response.json.bind(response);
    const originalSend = response.send.bind(response);

    const requestOptedIn = (): boolean => request.get("agent-feedback-request") === "1";

    const attachDiscovery = (supported: boolean): void => {
      if (
        discoveryAttached ||
        !supported ||
        runtime.cacheMode !== "request" ||
        requestOptedIn() ||
        (request.method !== "GET" && request.method !== "HEAD") ||
        !isCompleteSuccess(response)
      ) {
        return;
      }
      const link = requestDiscoveryLink(request.originalUrl || request.url);
      if (link) {
        appendLink(response, link);
        discoveryAttached = true;
      }
    };

    const routePath = (): string => {
      const route = request.route as { path?: string | string[] } | undefined;
      const path = Array.isArray(route?.path) ? route.path[0] : route?.path;
      return `${request.baseUrl || ""}${path || request.path || "/"}`;
    };

    const attach = (surface: ProductSurface, body?: unknown): Instrumentation | undefined => {
      if (
        !isCompleteSuccess(response) ||
        (request.method === "HEAD" && surface !== "http_headers") ||
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
          requestOptIn: requestOptedIn(),
          cacheControls: cacheControlValues(response),
        })
      ) {
        return undefined;
      }
      // Resolve identity only when the downstream handler has produced the
      // response. This lets authentication middleware mounted after Epode add
      // verified request context before Ask once chooses its consent subject.
      const context = runtime.context(request);
      instrumentation = {
        prepared: runtime.prepare({
          customerRef: context.customerRef,
          consentState: runtime.cachedConsent(context.customerRef),
        }),
        surface,
        operation: request[operationOverride] || normalizeOperation(routePath()),
        context,
      };
      makeResponsePrivate(response);
      return instrumentation;
    };

    const attachHeaders = (current: Instrumentation): void => {
      if (!current.prepared.envelope || feedbackHeadersAttached) return;
      feedbackHeadersAttached = true;
      response.setHeader("Agent-Feedback", encodedEnvelope(current.prepared.envelope));
      response.append(
        "Link",
        `<${runtime.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"`,
      );
    };

    response.json = ((body: unknown) => {
      if (matched && runtime.cacheMode === "request") ensureRequestVary(response);
      const ownedFeedback = isPlainObject(body) && Object.hasOwn(body, "_agentFeedback");
      attachDiscovery(body !== undefined && !ownedFeedback);
      if (request.method === "HEAD") {
        const current = attach("http_headers", body);
        if (current) attachHeaders(current);
        return originalJson(body);
      }
      if (isPlainObject(body)) {
        if (Object.hasOwn(body, "_agentFeedback")) {
          instrumentationSkipped = true;
          runtime.logger.warn(
            "[agent-feedback] Response already contains _agentFeedback; instrumentation was skipped.",
          );
          return originalJson(body);
        }
        const current = attach("http_json", body);
        if (current?.prepared.envelope) stripBodyValidators(response);
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
      const contentType = String(response.getHeader("content-type") || "").toLowerCase();
      const supported =
        contentType.includes("application/json") ||
        (typeof body === "string" && contentType.includes("text/html"));
      attachDiscovery(supported);
      if (request.method === "HEAD" && supported) {
        const current = attach("http_headers", body);
        if (current) attachHeaders(current);
        return originalSend(body);
      }
      if (typeof body === "string" && contentType.includes("text/html")) {
        const surface = hasEmbeddedFeedback(body) ? "http_headers" : "http_html";
        const current = attach(surface, body);
        if (!current?.prepared.envelope) return originalSend(body);
        if (surface === "http_headers") {
          attachHeaders(current);
          return originalSend(body);
        }
        stripBodyValidators(response);
        return originalSend(injectHtml(body, current.prepared.envelope));
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
      if (!instrumentation || recorded || !isCompleteSuccess(response)) {
        return;
      }
      recorded = true;
      runtime.record(instrumentation.prepared, {
        surface: instrumentation.surface,
        operation: instrumentation.operation,
        statusCode: response.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        accountRef: instrumentation.context.accountRef,
        userRef: instrumentation.context.userRef,
        anonymousRef: instrumentation.context.anonymousRef,
        customerRef: instrumentation.context.customerRef,
        classification: "unclassified",
        runtimeHint: instrumentation.context.runtimeHint,
        runtimeHintSource: instrumentation.context.runtimeHint ? "http" : undefined,
        sessionRef: instrumentation.context.sessionRef,
        sessionSource: instrumentation.context.sessionRef ? "customer" : undefined,
      });
      runtime.warmConsent(instrumentation.context.customerRef);
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
