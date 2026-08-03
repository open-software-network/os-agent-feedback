import type { NextRequest } from "next/server";

export const DEV_AUTH_COOKIE = "af_dev_identity";

export function isLocalDevAuthRequest(request: NextRequest): boolean {
  if (process.env.NODE_ENV !== "development" || process.env.DEV_AUTH_ENABLED !== "true") {
    return false;
  }

  const configured = process.env.WEB_APP_URL?.trim();
  if (!configured) return false;

  try {
    const expected = new URL(configured);
    const loopback =
      expected.hostname === "localhost" ||
      expected.hostname === "127.0.0.1" ||
      expected.hostname === "[::1]";
    const originOnly =
      expected.protocol === "http:" &&
      !expected.username &&
      !expected.password &&
      expected.pathname === "/" &&
      !expected.search &&
      !expected.hash;
    return (
      loopback &&
      originOnly &&
      request.nextUrl.origin === expected.origin &&
      request.headers.get("host") === expected.host
    );
  } catch {
    return false;
  }
}

export function stripDevAuthCookie(cookieHeader: string): string {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && part.split("=", 1)[0] !== DEV_AUTH_COOKIE)
    .join("; ");
}
