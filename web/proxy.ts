import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const ACCESS_COOKIE = "af_oa_access";
const REFRESH_COOKIE = "af_oa_refresh";

export const AUTH_ROUTE_ALLOWLIST = new Set([
  "/auth/signin",
  "/auth/start",
  "/auth/callback",
  "/auth/logout",
]);

function isPublicRoute(pathname: string): boolean {
  return (
    AUTH_ROUTE_ALLOWLIST.has(pathname) ||
    pathname === "/.well-known/agent-feedback-v1.json" ||
    pathname.startsWith("/join/") ||
    pathname.startsWith("/static/")
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/") || pathname === "/mcp") {
    return NextResponse.next();
  }

  const hasAuthCookie =
    Boolean(request.cookies.get(ACCESS_COOKIE)?.value) ||
    Boolean(request.cookies.get(REFRESH_COOKIE)?.value);

  if (!hasAuthCookie && !isPublicRoute(pathname)) {
    const signinUrl = new URL("/auth/signin", request.url);
    const returnTo = pathname + request.nextUrl.search;
    if (returnTo && returnTo !== "/") {
      signinUrl.searchParams.set("return_to", returnTo);
    }
    return NextResponse.redirect(signinUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?|ttf|otf)$).*)",
  ],
};
