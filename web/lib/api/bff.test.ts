// @vitest-environment node

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GET as proxyDiscoveryGet } from "@/app/.well-known/agent-feedback-v1.json/route";
import {
  GET as proxyApiGet,
  OPTIONS as proxyApiOptions,
  POST as proxyApiPost,
} from "@/app/api/[...path]/route";
import { GET as proxyAuthCallbackGet } from "@/app/auth/callback/route";
import { POST as proxyAuthLogoutPost } from "@/app/auth/logout/route";
import { GET as proxyAuthStartGet } from "@/app/auth/start/route";
import { GET as proxyJoinGet } from "@/app/join/[invitation_id]/route";
import { OPTIONS as proxyMcpOptions, POST as proxyMcpPost } from "@/app/mcp/route";
import { GET as proxyStaticGet } from "@/app/static/[...path]/route";

type SeenRequest = {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
};

const seenRequests: SeenRequest[] = [];
const staticArtifact = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0x7f]);
let server: Server;
let originalApiUrl: string | undefined;

function lastRequest(): SeenRequest {
  const request = seenRequests.at(-1);
  if (!request) {
    throw new Error("expected the upstream server to receive a request");
  }
  return request;
}

beforeAll(async () => {
  originalApiUrl = process.env.API_URL;
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    seenRequests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        request.headers["access-control-request-headers"] ?? "",
      );
      response.end();
      return;
    }

    if (request.url?.startsWith("/join/")) {
      response.statusCode = 303;
      response.setHeader("location", "/auth/start");
      response.setHeader(
        "set-cookie",
        "af_team_invite=invitation-123; Path=/; HttpOnly; SameSite=Lax",
      );
      response.end();
      return;
    }

    if (request.url === "/.well-known/agent-feedback-v1.json") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end('{"protocol":"agent-feedback-v1"}');
      return;
    }

    if (request.url?.startsWith("/static/")) {
      response.statusCode = 200;
      response.setHeader("content-type", "application/octet-stream");
      response.end(staticArtifact);
      return;
    }

    if (request.url?.startsWith("/api/dashboard")) {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", [
        "af_oa_access=rotated-access; Path=/; HttpOnly; SameSite=Lax",
        "af_oa_refresh=rotated-refresh; Path=/; HttpOnly; SameSite=Lax",
      ]);
      response.setHeader("connection", "x-response-secret");
      response.setHeader("x-response-secret", "strip-me");
      response.setHeader("x-upstream", "preserved");
      response.end('{"authenticated":true}');
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end('{"proxied":true}');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  process.env.API_URL = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  seenRequests.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (originalApiUrl === undefined) {
    delete process.env.API_URL;
  } else {
    process.env.API_URL = originalApiUrl;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe("BFF request header policy", () => {
  it("forwards cookies and ordinary headers while stripping browser-controlled identity headers", async () => {
    const response = await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/telemetry/batches?source=test", {
        method: "POST",
        headers: {
          "accept-encoding": "gzip",
          authorization: "Bearer browser-injected",
          connection: "keep-alive, x-remove-me",
          "content-type": "application/json",
          cookie: "af_oa_access=access; af_oa_refresh=refresh",
          host: "attacker.example",
          "x-api-key": "browser-injected",
          "x-custom": "preserved",
          "x-forwarded-email": "admin@example.com",
          "x-forwarded-for": "203.0.113.10",
          "x-remove-me": "connection-scoped",
        },
        body: '{"events":[]}',
      }),
      { params: Promise.resolve({ path: ["v2", "telemetry", "batches"] }) },
    );

    expect(response.status).toBe(200);
    const request = lastRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/v2/telemetry/batches?source=test");
    expect(request.body).toBe('{"events":[]}');
    expect(request.headers.cookie).toBe("af_oa_access=access; af_oa_refresh=refresh");
    expect(request.headers["x-custom"]).toBe("preserved");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.headers["x-forwarded-email"]).toBeUndefined();
    expect(request.headers["x-forwarded-for"]).toBeUndefined();
    expect(request.headers["x-remove-me"]).toBeUndefined();
    expect(request.headers["accept-encoding"]).toBeUndefined();
    expect(request.headers.host).not.toBe("attacker.example");
  });

  it("forwards the dev cookie only from the configured loopback Next origin", async () => {
    vi.stubEnv("DEV_AUTH_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_APP_URL", "http://localhost:3000");

    await proxyApiGet(
      new NextRequest("http://localhost:3000/api/dashboard", {
        headers: {
          cookie: "af_oa_access=access; af_dev_identity=signed-by-rust",
          host: "localhost:3000",
        },
      }),
      { params: Promise.resolve({ path: ["dashboard"] }) },
    );
    expect(lastRequest().headers.cookie).toBe(
      "af_oa_access=access; af_dev_identity=signed-by-rust",
    );

    await proxyApiGet(
      new NextRequest("https://remote.example/api/dashboard", {
        headers: {
          cookie: "af_oa_access=access; af_dev_identity=replayed",
          host: "remote.example",
        },
      }),
      { params: Promise.resolve({ path: ["dashboard"] }) },
    );
    expect(lastRequest().headers.cookie).toBe("af_oa_access=access");
  });

  it("restores only endpoint-appropriate machine bearer credentials", async () => {
    await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/telemetry/batches", {
        method: "POST",
        headers: { authorization: "Bearer af_live_product-secret" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v2", "telemetry", "batches"] }) },
    );
    expect(lastRequest().headers.authorization).toBe("Bearer af_live_product-secret");

    for (const path of [
      ["v2", "enrichment", "requests"],
      ["v2", "customer-context"],
      ["v2", "personalization", "decisions"],
      ["v2", "personalization", "outcomes"],
    ]) {
      await proxyApiPost(
        new NextRequest(`https://app.epode.ai/api/${path.join("/")}`, {
          method: "POST",
          headers: { authorization: "Bearer af_live_product-secret" },
          body: "{}",
        }),
        { params: Promise.resolve({ path }) },
      );
      expect(lastRequest().headers.authorization).toBe("Bearer af_live_product-secret");
    }

    for (const path of [
      ["v2", "enrichment", "consent", "decisions"],
      ["v2", "enrichment", "answers"],
    ]) {
      await proxyApiPost(
        new NextRequest(`https://app.epode.ai/api/${path.join("/")}`, {
          method: "POST",
          headers: { authorization: "Bearer aqr1_capability" },
          body: "{}",
        }),
        { params: Promise.resolve({ path }) },
      );
      expect(lastRequest().headers.authorization).toBe("Bearer aqr1_capability");
    }

    await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/consent/state", {
        method: "POST",
        headers: { authorization: "Bearer af_live_product-secret" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v2", "consent", "state"] }) },
    );
    expect(lastRequest().headers.authorization).toBe("Bearer af_live_product-secret");

    await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/capabilities/introspect", {
        method: "POST",
        headers: { authorization: "Bearer afr2_capability.payload.signature" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v2", "capabilities", "introspect"] }) },
    );
    expect(lastRequest().headers.authorization).toBe("Bearer afr2_capability.payload.signature");

    await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/consent/decisions", {
        method: "POST",
        headers: { authorization: "Bearer afr2_capability.payload.signature" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v2", "consent", "decisions"] }) },
    );
    expect(lastRequest().headers.authorization).toBe("Bearer afr2_capability.payload.signature");

    await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/reports", {
        method: "POST",
        headers: { authorization: "Bearer afr2_capability.payload.signature" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v2", "reports"] }) },
    );
    expect(lastRequest().headers.authorization).toBe("Bearer afr2_capability.payload.signature");

    await proxyMcpPost(
      new NextRequest("https://app.epode.ai/mcp", {
        method: "POST",
        headers: { authorization: "Bearer af_read_read-secret" },
        body: "{}",
      }),
    );
    expect(lastRequest().headers.authorization).toBe("Bearer af_read_read-secret");
  });

  it("rejects declared and streamed oversized bodies before buffering or proxying", async () => {
    const before = seenRequests.length;
    const declared = await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/reports", {
        method: "POST",
        headers: { "content-length": String(64 * 1024 + 1) },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["v2", "reports"] }) },
    );
    expect(declared.status).toBe(413);
    expect(seenRequests).toHaveLength(before);

    const streamed = await proxyApiPost(
      new NextRequest("https://app.epode.ai/api/v2/reports", {
        method: "POST",
        body: new Uint8Array(80 * 1024),
      }),
      { params: Promise.resolve({ path: ["v2", "reports"] }) },
    );
    expect(streamed.status).toBe(413);
    expect(seenRequests).toHaveLength(before);
  });
});

describe("BFF response and route behavior", () => {
  it("passes rotated access and refresh cookies through as separate Set-Cookie headers", async () => {
    const response = await fetchDashboard();

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      "af_oa_access=rotated-access; Path=/; HttpOnly; SameSite=Lax",
      "af_oa_refresh=rotated-refresh; Path=/; HttpOnly; SameSite=Lax",
    ]);
    expect(response.headers.get("x-upstream")).toBe("preserved");
    expect(response.headers.get("connection")).toBeNull();
    expect(response.headers.get("x-response-secret")).toBeNull();
    await expect(response.json()).resolves.toEqual({ authenticated: true });
  });

  it("preserves API, MCP, and auth paths and maps the friendly logout path", async () => {
    await proxyAuthStartGet(new NextRequest("https://app.epode.ai/auth/start?from=signin"));
    expect(lastRequest().url).toBe("/auth/start?from=signin");

    await proxyAuthCallbackGet(
      new NextRequest("https://app.epode.ai/auth/callback?code=code&state=state"),
    );
    expect(lastRequest().url).toBe("/auth/callback?code=code&state=state");

    await proxyAuthLogoutPost(
      new NextRequest("https://app.epode.ai/auth/logout", { method: "POST" }),
    );
    expect(lastRequest().url).toBe("/api/auth/logout");

    await proxyMcpPost(new NextRequest("https://app.epode.ai/mcp", { method: "POST", body: "{}" }));
    expect(lastRequest().url).toBe("/mcp");
  });

  it("passes invitation cookies and redirects through the public join route", async () => {
    const response = await proxyJoinGet(
      new NextRequest("https://app.epode.ai/join/invitation-123"),
      { params: Promise.resolve({ invitation_id: "invitation-123" }) },
    );

    expect(lastRequest().url).toBe("/join/invitation-123");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/start");
    expect(response.headers.getSetCookie()).toEqual([
      "af_team_invite=invitation-123; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });

  it("proxies the public protocol discovery document at its exact path", async () => {
    const response = await proxyDiscoveryGet(
      new NextRequest("https://app.epode.ai/.well-known/agent-feedback-v1.json"),
    );

    expect(lastRequest().url).toBe("/.well-known/agent-feedback-v1.json");
    await expect(response.json()).resolves.toEqual({ protocol: "agent-feedback-v1" });
  });

  it("proxies static artifacts without corrupting binary response bytes", async () => {
    const response = await proxyStaticGet(
      new NextRequest("https://app.epode.ai/static/agent-feedback-sdk.tgz", {
        headers: { "accept-encoding": "gzip" },
      }),
      { params: Promise.resolve({ path: ["agent-feedback-sdk.tgz"] }) },
    );

    expect(lastRequest().url).toBe("/static/agent-feedback-sdk.tgz");
    expect(lastRequest().headers["accept-encoding"]).toBeUndefined();
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(staticArtifact);
  });

  it("forwards API and MCP preflight requests to the upstream CORS layer", async () => {
    const requestHeaders = {
      origin: "https://trusted.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "mcp-method",
    };
    const apiResponse = await proxyApiOptions(
      new NextRequest("https://app.epode.ai/api/v2/reports", {
        method: "OPTIONS",
        headers: requestHeaders,
      }),
      { params: Promise.resolve({ path: ["v2", "reports"] }) },
    );

    expect(lastRequest().method).toBe("OPTIONS");
    expect(lastRequest().url).toBe("/api/v2/reports");
    expect(apiResponse.status).toBe(204);
    expect(apiResponse.headers.get("access-control-allow-origin")).toBe("https://trusted.example");
    expect(apiResponse.headers.get("access-control-allow-headers")).toBe("mcp-method");

    const mcpResponse = await proxyMcpOptions(
      new NextRequest("https://app.epode.ai/mcp", {
        method: "OPTIONS",
        headers: requestHeaders,
      }),
    );

    expect(lastRequest().method).toBe("OPTIONS");
    expect(lastRequest().url).toBe("/mcp");
    expect(mcpResponse.status).toBe(204);
    expect(mcpResponse.headers.get("access-control-allow-origin")).toBe("https://trusted.example");
  });

  it("passes the selected team to the GitHub installation flow", async () => {
    await proxyApiGet(
      new NextRequest("https://app.epode.ai/api/github/install?workspaceId=workspace-selected", {
        headers: { "x-workspace-id": "workspace-spoofed" },
      }),
      { params: Promise.resolve({ path: ["github", "install"] }) },
    );

    expect(lastRequest().url).toBe("/api/github/install?workspaceId=workspace-selected");
    expect(lastRequest().headers["x-workspace-id"]).toBe("workspace-selected");
  });
});

async function fetchDashboard(): Promise<Response> {
  const { GET } = await import("@/app/api/[...path]/route");
  return GET(new NextRequest("https://app.epode.ai/api/dashboard"), {
    params: Promise.resolve({ path: ["dashboard"] }),
  });
}
