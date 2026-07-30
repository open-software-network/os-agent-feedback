import type { NextRequest } from "next/server";

import { proxyToApi } from "@/lib/api/bff";

function proxy(request: NextRequest): Promise<Response> {
  return proxyToApi(request, "/mcp");
}

export const GET = proxy;
export const POST = proxy;
export const OPTIONS = proxy;
