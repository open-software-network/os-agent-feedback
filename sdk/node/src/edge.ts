import {
  type AgentFeedbackOptions,
  AgentFeedbackRuntime,
  encodedEnvelope,
  matchPattern,
  normalizeOperation,
  requestDiscoveryLink,
} from "./core.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const CDN_CACHE_CONTROL_HEADERS = [
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "surrogate-control",
] as const;
const SAFE_UPSTREAM_REQUEST_HEADERS = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "pragma",
  "range",
]);
const PRIVATE_UPSTREAM_RESPONSE_HEADERS = [
  "authentication-info",
  "clear-site-data",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authentication-info",
  "proxy-connection",
  "set-cookie",
  "set-cookie2",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
] as const;

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
  /**
   * Optional server-side credential for a private docs origin. Caller
   * credentials are never forwarded and cannot override this value.
   */
  upstreamAuthorization?: string;
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

function validatedUpstreamAuthorization(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error("upstreamAuthorization must be a bounded single HTTP header value");
  }
  return value;
}

function validTraceparent(value: string): boolean {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match) return false;
  const traceId = match[1];
  const parentId = match[2];
  return Boolean(traceId && parentId && !/^0+$/.test(traceId) && !/^0+$/.test(parentId));
}

function safeUpstreamRequestHeaders(
  source: Headers,
  upstreamAuthorization: string | undefined,
): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const normalized = name.toLowerCase();
    if (SAFE_UPSTREAM_REQUEST_HEADERS.has(normalized)) {
      if (value.length <= 2048 && !/[\0\r\n]/.test(value)) headers.append(name, value);
    } else if (normalized === "traceparent" && validTraceparent(value)) {
      headers.set(name, value);
    }
  }
  if (upstreamAuthorization) headers.set("authorization", upstreamAuthorization);
  return headers;
}

function safeUpstreamResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const connectionTokens = (headers.get("connection") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...PRIVATE_UPSTREAM_RESPONSE_HEADERS, ...connectionTokens]) {
    headers.delete(name);
  }
  return headers;
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

function makeResponsePrivate(headers: Headers): void {
  for (const name of CDN_CACHE_CONTROL_HEADERS) headers.delete(name);
  headers.set("cache-control", "private, no-store");
}

function finiteSupportedResponse(response: Response, maxResponseBytes: number): boolean {
  // Partial/range responses describe only a fragment. Attaching a capability
  // would falsely treat that fragment as a complete product outcome and can
  // also break cache/range semantics.
  if (response.status !== 200 || response.headers.has("content-range")) return false;
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
  const upstreamAuthorization = validatedUpstreamAuthorization(options.upstreamAuthorization);
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
    const cleanUpstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: safeUpstreamRequestHeaders(request.headers, upstreamAuthorization),
      redirect: "manual",
      signal: request.signal,
    });
    const started = performance.now();
    const upstreamResponse = await fetchImplementation(cleanUpstreamRequest);
    const headers = safeUpstreamResponseHeaders(upstreamResponse.headers);
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
      makeResponsePrivate(headers);
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
        accountRef: requestContext.accountRef,
        userRef: requestContext.userRef,
        anonymousRef: requestContext.anonymousRef,
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
