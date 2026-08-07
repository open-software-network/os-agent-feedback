import { type NextRequest, NextResponse } from "next/server";

import { ACO_COOKIE_PREFIX, accessToken, passwordMatches, reportPassword } from "@/lib/aco/reports";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const password = reportPassword(slug);
  if (!password) {
    return new NextResponse("Not found", { status: 404 });
  }
  const form = await request.formData().catch(() => undefined);
  const supplied = form?.get("password");
  const target = new URL(`/aco-report/${slug}`, request.nextUrl.origin);
  if (typeof supplied !== "string" || !passwordMatches(supplied, password)) {
    target.searchParams.set("error", "1");
    return NextResponse.redirect(target, 303);
  }
  const response = NextResponse.redirect(target, 303);
  response.cookies.set({
    name: `${ACO_COOKIE_PREFIX}${slug}`,
    value: accessToken(slug, password),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/aco-report/${slug}`,
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
