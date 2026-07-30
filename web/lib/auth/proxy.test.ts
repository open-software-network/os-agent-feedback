// @vitest-environment node

import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { AUTH_ROUTE_ALLOWLIST, proxy } from "@/proxy";

function expectNext(response: Response): void {
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.get("location")).toBeNull();
}

describe("auth plumbing proxy", () => {
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
});
