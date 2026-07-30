import type { NextRequest } from "next/server";

import { proxyToApi } from "@/lib/api/bff";

function proxy(request: NextRequest): Promise<Response> {
  return proxyToApi(request, "/.well-known/agent-feedback-v1.json");
}

export const GET = proxy;
export const HEAD = proxy;
