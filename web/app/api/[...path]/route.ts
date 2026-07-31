import { NextRequest } from "next/server";

import { pathFromSegments, proxyToApi } from "@/lib/api/bff";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const upstreamPath = pathFromSegments("/api", path);
  const workspaceId =
    request.method === "GET" && upstreamPath === "/api/github/install"
      ? request.nextUrl.searchParams.get("workspaceId")
      : null;
  if (!workspaceId) return proxyToApi(request, upstreamPath);

  const headers = new Headers(request.headers);
  headers.set("x-workspace-id", workspaceId);
  return proxyToApi(new NextRequest(request, { headers }), upstreamPath);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
