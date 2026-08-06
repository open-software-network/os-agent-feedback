// @vitest-environment node

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_ROUTE_ALLOWLIST, proxy } from "@/proxy";

function expectNext(response: Response): void {
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.get("location")).toBeNull();
}

describe("auth plumbing proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows only the explicit auth routes through without a cookie", () => {
    expect([...AUTH_ROUTE_ALLOWLIST]).toEqual([
      "/auth/signin",
      "/auth/start",
      "/auth/callback",
      "/auth/logout",
    ]);

    for (const path of AUTH_ROUTE_ALLOWLIST) {
      expectNext(proxy(new NextRequest(`https://app.epode.ai${path}`)));
    }

    const response = proxy(new NextRequest("https://app.epode.ai/auth/unknown"));
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth/signin");
  });

  it("redirects an unauthenticated page request to signin with its complete return path", () => {
    const response = proxy(
      new NextRequest("https://app.epode.ai/team?tab=members&selected=usr_123"),
    );
    const redirect = new URL(response.headers.get("location") ?? "");

    expect(redirect.pathname).toBe("/auth/signin");
    expect(redirect.searchParams.get("return_to")).toBe("/team?tab=members&selected=usr_123");
  });

  it("checks cookie presence only and leaves verification to Rust", () => {
    expectNext(
      proxy(
        new NextRequest("https://app.epode.ai/team", {
          headers: { cookie: "af_oa_access=not-a-verified-token" },
        }),
      ),
    );
    expectNext(
      proxy(
        new NextRequest("https://app.epode.ai/team", {
          headers: { cookie: "af_oa_refresh=not-a-verified-token" },
        }),
      ),
    );
  });

  it("accepts the local dev cookie only with an explicit non-production opt-in", () => {
    const request = () =>
      new NextRequest("http://localhost:3000/team", {
        headers: { cookie: "af_dev_identity=signed-by-rust", host: "localhost:3000" },
      });

    vi.stubEnv("DEV_AUTH_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WEB_APP_URL", "http://localhost:3000");
    expectNext(proxy(request()));

    vi.stubEnv("DEV_AUTH_ENABLED", "false");
    expect(new URL(proxy(request()).headers.get("location") ?? "").pathname).toBe("/auth/signin");

    vi.stubEnv("DEV_AUTH_ENABLED", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(new URL(proxy(request()).headers.get("location") ?? "").pathname).toBe("/auth/signin");

    vi.stubEnv("NODE_ENV", "development");
    const remote = new NextRequest("https://remote.example/team", {
      headers: { cookie: "af_dev_identity=signed-by-rust", host: "remote.example" },
    });
    expect(new URL(proxy(remote).headers.get("location") ?? "").pathname).toBe("/auth/signin");
  });

  it("does not redirect API or MCP machine traffic", () => {
    expectNext(proxy(new NextRequest("https://app.epode.ai/api/v2/telemetry/batches")));
    expectNext(proxy(new NextRequest("https://app.epode.ai/mcp")));
  });

  it("allows public invite, discovery, and artifact routes without a cookie", () => {
    expectNext(proxy(new NextRequest("https://app.epode.ai/join/invitation-123")));
    expectNext(proxy(new NextRequest("https://app.epode.ai/.well-known/agent-feedback-v1.json")));
    expectNext(proxy(new NextRequest("https://app.epode.ai/static/agent-feedback-sdk.tgz")));
    expectNext(proxy(new NextRequest("https://app.epode.ai/static/agent_feedback_sdk.whl")));
  });

  it("leaves ACO report routes to their own password gate", () => {
    expectNext(proxy(new NextRequest("https://app.epode.ai/aco-report")));
    expectNext(proxy(new NextRequest("https://app.epode.ai/aco-report/petsmart")));
    expectNext(
      proxy(new NextRequest("https://app.epode.ai/aco-report/petsmart/assets/1-agent-guide.png")),
    );
  });
});
