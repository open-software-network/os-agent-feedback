import type { NextRequest } from "next/server";

import { proxyToApi } from "@/lib/api/bff";

export function POST(request: NextRequest): Promise<Response> {
  return proxyToApi(request, "/api/auth/logout");
}
