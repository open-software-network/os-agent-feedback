import http, { type IncomingMessage } from "node:http";
import https from "node:https";

import type { NextRequest } from "next/server";

import { isLocalDevAuthRequest, stripDevAuthCookie } from "@/lib/auth/dev-auth";

const API_URL_DEFAULT = "http://localhost:8080";
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "accept-encoding",
  "authorization",
  "content-length",
  "forwarded",
  "host",
  "x-api-key",
  "x-original-url",
  "x-real-ip",
  "x-rewrite-url",
  "x-user-email",
  "x-user-id",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "content-encoding",
  "content-length",
]);

const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 50 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 50 });

type UpstreamResult = {
  status: number;
  headers: IncomingMessage["headers"];
  body: Uint8Array<ArrayBuffer>;
};

function connectionHeaders(value: string | null | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean),
  );
}

function shouldStripRequestHeader(name: string, connection: Set<string>): boolean {
  const normalized = name.toLowerCase();
  return (
    STRIPPED_REQUEST_HEADERS.has(normalized) ||
    connection.has(normalized) ||
    normalized.startsWith("x-forwarded-")
  );
}

function machineAuthorization(headers: Headers, upstreamPath: string): string | undefined {
  const rawAuthorization = headers.get("authorization");
  const bearerMatch = rawAuthorization ? /^bearer\s+(.+)$/i.exec(rawAuthorization.trim()) : null;
  const token = bearerMatch?.[1]?.trim() || headers.get("x-api-key")?.trim();
  if (!token) return undefined;

  const allowed =
    (upstreamPath === "/api/v2/telemetry/batches" && token.startsWith("af_live_")) ||
    (upstreamPath === "/api/v2/consent/state" && token.startsWith("af_live_")) ||
    (upstreamPath === "/api/v2/enrichment/requests" && token.startsWith("af_live_")) ||
    (upstreamPath === "/api/v2/customer-context" && token.startsWith("af_live_")) ||
    (upstreamPath === "/api/v2/personalization/decisions" && token.startsWith("af_live_")) ||
    (upstreamPath === "/api/v2/personalization/outcomes" && token.startsWith("af_live_")) ||
    (upstreamPath === "/api/v2/enrichment/requests/inspect" && token.startsWith("aqr1_")) ||
    (upstreamPath === "/api/v2/enrichment/consent/decisions" && token.startsWith("aqr1_")) ||
    (upstreamPath === "/api/v2/enrichment/answers" && token.startsWith("aqr1_")) ||
    (upstreamPath === "/api/v2/capabilities/introspect" && token.startsWith("afr2_")) ||
    (upstreamPath === "/api/v2/consent/decisions" && token.startsWith("afr2_")) ||
    (upstreamPath === "/api/v2/reports" && token.startsWith("afr2_")) ||
    (upstreamPath === "/mcp" && token.startsWith("af_read_"));

  return allowed ? `Bearer ${token}` : undefined;
}

function requestHeaders(request: NextRequest, upstreamPath: string): Headers {
  const connection = connectionHeaders(request.headers.get("connection"));
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!shouldStripRequestHeader(name, connection)) {
      headers.append(name, value);
    }
  });

  if (!isLocalDevAuthRequest(request)) {
    const cookies = stripDevAuthCookie(headers.get("cookie") ?? "");
    if (cookies) headers.set("cookie", cookies);
    else headers.delete("cookie");
  }

  const authorization = machineAuthorization(request.headers, upstreamPath);
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return headers;
}

function responseHeaders(source: IncomingMessage["headers"]): Headers {
  const connectionValue = Array.isArray(source.connection)
    ? source.connection.join(",")
    : source.connection;
  const connection = connectionHeaders(connectionValue);
  const headers = new Headers();

  for (const [name, raw] of Object.entries(source)) {
    const normalized = name.toLowerCase();
    if (
      raw === undefined ||
      STRIPPED_RESPONSE_HEADERS.has(normalized) ||
      connection.has(normalized)
    ) {
      continue;
    }
    if (Array.isArray(raw)) {
      for (const value of raw) {
        headers.append(name, value);
      }
    } else {
      headers.append(name, String(raw));
    }
  }
  return headers;
}

function toNodeHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  source.forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

function requestUpstream(
  upstream: URL,
  init: { method: string; headers: Record<string, string>; body?: Buffer },
): Promise<UpstreamResult> {
  const isHttps = upstream.protocol === "https:";
  const transport = isHttps ? https : http;
  const agent = isHttps ? HTTPS_AGENT : HTTP_AGENT;

  return new Promise((resolve, reject) => {
    const outgoing = transport.request(
      upstream,
      { method: init.method, headers: init.headers, agent },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on("end", () => {
          const merged = Buffer.concat(chunks);
          const body = new Uint8Array(merged.byteLength);
          body.set(merged);
          resolve({
            status: incoming.statusCode ?? 502,
            headers: incoming.headers,
            body,
          });
        });
        incoming.on("error", reject);
      },
    );

    outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      outgoing.destroy(new Error(`upstream timed out after ${UPSTREAM_TIMEOUT_MS}ms`));
    });
    outgoing.on("error", reject);
    outgoing.end(init.body);
  });
}

function upstreamUrl(path: string, search: string): URL {
  const configured = process.env.API_URL?.trim() || API_URL_DEFAULT;
  const base = new URL(configured);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("API_URL must use HTTP or HTTPS");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}${path}`;
  base.search = search;
  return base;
}

async function boundedRequestBody(request: NextRequest): Promise<Buffer | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new PayloadTooLargeError("invalid content length");
    }
    if (parsedLength > MAX_REQUEST_BODY_BYTES) {
      throw new PayloadTooLargeError("request body is too large");
    }
  }
  if (!request.body) return undefined;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel("request body is too large");
        throw new PayloadTooLargeError("request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return undefined;
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
}

export function pathFromSegments(prefix: string, segments: string[]): string {
  return `${prefix}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export async function proxyToApi(request: NextRequest, upstreamPath: string): Promise<Response> {
  try {
    const upstream = upstreamUrl(upstreamPath, request.nextUrl.search);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const bodyBuffer = hasBody ? await boundedRequestBody(request) : undefined;
    const upstreamResponse = await requestUpstream(upstream, {
      method: request.method,
      headers: toNodeHeaders(requestHeaders(request, upstreamPath)),
      body: bodyBuffer && bodyBuffer.byteLength > 0 ? bodyBuffer : undefined,
    });
    const hasResponseBody =
      request.method !== "HEAD" &&
      upstreamResponse.status !== 204 &&
      upstreamResponse.status !== 205 &&
      upstreamResponse.status !== 304;

    return new Response(hasResponseBody ? upstreamResponse.body : null, {
      status: upstreamResponse.status,
      headers: responseHeaders(upstreamResponse.headers),
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: "request body is too large" }, { status: 413 });
    }
    return Response.json({ error: "upstream unreachable" }, { status: 502 });
  }
}
