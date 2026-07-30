import type { NextRequest } from "next/server";

import { pathFromSegments, proxyToApi } from "@/lib/api/bff";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const upstreamPath =
    path.length === 1 && path[0] === "logout"
      ? "/api/auth/logout"
      : pathFromSegments("/auth", path);
  return proxyToApi(request, upstreamPath);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
