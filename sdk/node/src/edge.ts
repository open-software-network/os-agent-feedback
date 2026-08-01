import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  encodedEnvelope,
  matchPattern,
  normalizeOperation,
  requestDiscoveryLink,
} from "./core.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface EdgeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface StaticDocsProxyOptions
  extends Omit<
    AgentFeedbackOptions<Request>,
    "apiKey" | "cacheMode" | "include" | "exclude" | "shouldInstrument"
  > {
  apiKey: string;
  /** Exact HTTPS origin that serves the uninstrumented static site or hosted documentation. */
  upstreamOrigin: string;
  /** Public paths owned by this proxy. Keep this list narrow and code-reviewed. */
  include: string[];
  exclude?: string[];
  /** Skip a response when its declared Content-Length is larger than this value. */
  maxResponseBytes?: number;
}

export interface StaticDocsProxy {
  fetch(request: Request, context: EdgeExecutionContext): Promise<Response>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("upstreamOrigin must be an exact HTTPS origin without credentials or a path");
  }
  return url.origin;
}

function requestOptedIn(request: Request): boolean {
  return (request.headers.get("agent-feedback-request") || "")
    .split(",")
    .some((value) => value.trim() === "1");
}

function ownsPublicPath(runtime: AgentFeedbackRuntime<Request>, pathname: string): boolean {
  if (runtime.exclude.some((pattern) => matchPattern(pathname, pattern))) return false;
  return runtime.include.some((pattern) => matchPattern(pathname, pattern));
}

function rejectedRoute(status: 404 | 405): Response {
  const headers = new Headers({ "cache-control": "private, no-store" });
  if (status === 405) headers.set("allow", "GET, HEAD");
  return new Response(null, { status, headers });
}

function ensureRequestVary(headers: Headers): void {
  const tokens = (headers.get("vary") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (tokens.includes("*")) return;
  if (!tokens.some((value) => value.toLowerCase() === "agent-feedback-request")) {
    tokens.push("Agent-Feedback-Request");
    headers.set("vary", tokens.join(", "));
  }
}

function finiteSupportedResponse(response: Response, maxResponseBytes: number): boolean {
  if (response.status < 200 || response.status >= 300) return false;
  if (response.headers.has("agent-feedback")) return false;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return false;
  const disposition = response.headers.get("content-disposition") || "";
  if (/\battachment\b/i.test(disposition)) return false;
  if (response.headers.has("transfer-encoding")) return false;
  const contentLength = response.headers.get("content-length") || "";
  if (!contentLength) return true;
  if (!/^\d+$/.test(contentLength)) return false;
  const length = Number(contentLength);
  return Number.isSafeInteger(length) && length >= 0 && length <= maxResponseBytes;
}

function relayResponse(response: Response, headers = response.headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteSafeUpstreamRedirect(
  response: Response,
  headers: Headers,
  upstreamOrigin: string,
  publicOrigin: string,
): void {
  if (response.status < 300 || response.status >= 400) return;
  const location = headers.get("location");
  if (!location) return;
  try {
    const resolved = new URL(location, upstreamOrigin);
    if (resolved.origin !== upstreamOrigin || resolved.username || resolved.password) return;
    headers.set(
      "location",
      `${publicOrigin}${resolved.pathname}${resolved.search}${resolved.hash}`,
    );
  } catch {
    // Preserve malformed upstream redirects rather than inventing a target.
  }
}

/**
 * Proxy a static site or hosted-docs origin through a trusted edge runtime.
 *
 * The product key stays inside the runtime. Ordinary responses preserve their
 * public cache policy and advertise a same-URL opt-in. Only an explicit
 * feedback-aware refetch receives a private, write-only feedback capability.
 * Mount it only on a dedicated public route boundary. Paths outside `include`
 * and methods other than GET or HEAD are rejected without reaching upstream.
 */
export function createStaticDocsProxy(options: StaticDocsProxyOptions): StaticDocsProxy {
  if (!options.include.length) throw new Error("include must contain at least one public path");
  const upstreamOrigin = exactHttpsOrigin(options.upstreamOrigin);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive integer");
  }
  const fetchImplementation = options.fetch || globalThis.fetch;
  const logger = options.logger || console;
  const runtime = new AgentFeedbackRuntime<Request>({
    ...options,
    cacheMode: "request",
  });

  async function handle(request: Request, context: EdgeExecutionContext): Promise<Response> {
    const publicUrl = new URL(request.url);
    if (publicUrl.origin === upstreamOrigin) {
      return new Response("Static docs proxy upstream must use a different origin", {
        status: 502,
      });
    }
    if (!ownsPublicPath(runtime, publicUrl.pathname)) return rejectedRoute(404);
    if (request.method !== "GET" && request.method !== "HEAD") return rejectedRoute(405);

    const upstreamUrl = new URL(`${publicUrl.pathname}${publicUrl.search}`, upstreamOrigin);
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.delete("agent-feedback-request");
    upstreamHeaders.delete("host");
    const upstreamRequest = new Request(upstreamUrl, request);
    const cleanUpstreamRequest = new Request(upstreamRequest, {
      headers: upstreamHeaders,
      redirect: "manual",
    });
    const started = performance.now();
    const upstreamResponse = await fetchImplementation(cleanUpstreamRequest);
    const headers = new Headers(upstreamResponse.headers);
    rewriteSafeUpstreamRedirect(upstreamResponse, headers, upstreamOrigin, publicUrl.origin);
    if (!runtime.enabled) return relayResponse(upstreamResponse, headers);

    ensureRequestVary(headers);
    if (!finiteSupportedResponse(upstreamResponse, maxResponseBytes)) {
      return relayResponse(upstreamResponse, headers);
    }

    const optedIn = requestOptedIn(request);
    if (!optedIn) {
      const discovery = requestDiscoveryLink(`${publicUrl.pathname}${publicUrl.search}`);
      if (discovery) headers.append("link", discovery);
      return relayResponse(upstreamResponse, headers);
    }

    try {
      const requestContext = runtime.context(request);
      const prepared = runtime.prepare({
        customerRef: requestContext.customerRef,
        consentState: runtime.cachedConsent(requestContext.customerRef),
      });
      if (!prepared.envelope) return relayResponse(upstreamResponse, headers);
      headers.set("cache-control", "private, no-store");
      headers.set("agent-feedback", encodedEnvelope(prepared.envelope));
      headers.append(
        "link",
        `<${runtime.endpoint}/.well-known/agent-feedback-v1.json>; rel="agent-feedback"; type="application/json"`,
      );
      runtime.record(prepared, {
        surface: "http_headers",
        operation: normalizeOperation(publicUrl.pathname),
        statusCode: upstreamResponse.status,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        customerRef: requestContext.customerRef,
        classification: "unclassified",
        runtimeHint: requestContext.runtimeHint,
        runtimeHintSource: requestContext.runtimeHint ? "http" : undefined,
        sessionRef: requestContext.sessionRef,
        sessionSource: requestContext.sessionRef ? "customer" : undefined,
      });
      const background: Promise<unknown>[] = [runtime.flush()];
      if (runtime.feedbackMode === "ask_once" && requestContext.customerRef) {
        background.push(runtime.resolveConsent(requestContext.customerRef));
      }
      try {
        context.waitUntil(Promise.allSettled(background));
      } catch (error) {
        logger.warn(
          `[agent-feedback] Edge lifecycle scheduling failed; the product response remains available. ${String(error)}`,
        );
      }
    } catch (error) {
      logger.warn(
        `[agent-feedback] Edge instrumentation failed; the upstream response remains available. ${String(error)}`,
      );
    }
    return relayResponse(upstreamResponse, headers);
  }

  return { fetch: handle, flush: () => runtime.flush(), shutdown: () => runtime.shutdown() };
}
