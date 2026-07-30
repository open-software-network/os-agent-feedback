import type { NextRequest } from "next/server";

import { pathFromSegments, proxyToApi } from "@/lib/api/bff";

type RouteContext = {
  params: Promise<{ invitation_id: string }>;
};

async function proxy(request: NextRequest, context: RouteContext): Promise<Response> {
  const { invitation_id } = await context.params;
  return proxyToApi(request, pathFromSegments("/join", [invitation_id]));
}

export const GET = proxy;
export const HEAD = proxy;
