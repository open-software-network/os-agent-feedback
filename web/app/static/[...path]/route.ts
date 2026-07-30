import type { NextRequest } from "next/server";

import { pathFromSegments, proxyToApi } from "@/lib/api/bff";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxyToApi(request, pathFromSegments("/static", path));
}

export const GET = proxy;
export const HEAD = proxy;
