import { type NextRequest, NextResponse } from "next/server";

import { ACO_COOKIE_PREFIX, reportAsset, reportPassword, tokenMatches } from "@/lib/aco/reports";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; asset: string }> },
): Promise<NextResponse> {
  const { slug, asset } = await params;
  const password = reportPassword(slug);
  if (!password) {
    return new NextResponse("Not found", { status: 404 });
  }
  const cookie = request.cookies.get(`${ACO_COOKIE_PREFIX}${slug}`)?.value;
  if (!cookie || !tokenMatches(cookie, slug, password)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const body = await reportAsset(slug, asset);
  if (!body) {
    return new NextResponse("Not found", { status: 404 });
  }
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": "image/png",
      "cache-control": "private, max-age=3600",
    },
  });
}
