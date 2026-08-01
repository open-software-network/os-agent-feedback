import type { NextRequest } from "next/server";

import { proxyToApi } from "@/lib/api/bff";

export function GET(request: NextRequest): Promise<Response> {
  return proxyToApi(request, "/auth/callback");
}

export function HEAD(request: NextRequest): Promise<Response> {
  return proxyToApi(request, "/auth/callback");
}
