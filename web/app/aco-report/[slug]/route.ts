import { type NextRequest, NextResponse } from "next/server";

import {
  ACO_COOKIE_PREFIX,
  accessToken,
  passwordMatches,
  reportHtml,
  reportPassword,
  tokenMatches,
} from "@/lib/aco/reports";

export const dynamic = "force-dynamic";

function unlockFormHtml(slug: string, showError: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Protected report</title>
<style>
  :root { --paper: #f5f7fa; --card: #ffffff; --ink: #16233b; --muted: #5c6b84; --accent: #0b63c4; --line: #d9e0ea; }
  @media (prefers-color-scheme: dark) {
    :root { --paper: #0e1626; --card: #16202f; --ink: #e8edf5; --muted: #93a2b8; --accent: #5aa2ff; --line: #29354a; }
  }
  body { background: var(--paper); color: var(--ink); font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
  form { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 2rem; width: min(22rem, 90vw); display: flex; flex-direction: column; gap: 0.9rem; }
  h1 { font-size: 1.1rem; margin: 0; }
  p { margin: 0; color: var(--muted); font-size: 0.9rem; }
  .error { color: #c62b3f; font-size: 0.85rem; margin: 0; }
  input { border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 1rem; background: var(--paper); color: var(--ink); }
  button { border: 0; border-radius: 8px; padding: 0.65rem; font-size: 0.95rem; font-weight: 600; background: var(--accent); color: #fff; cursor: pointer; }
</style>
</head>
<body>
<form method="post">
  <h1>This report is protected</h1>
  <p>Enter the password you were given to view it.</p>
  ${showError ? '<p class="error">That password was not correct.</p>' : ""}
  <input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Report password" />
  <button type="submit">View report</button>
</form>
</body>
</html>`;
}

function htmlResponse(body: string, status: number): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

function authorized(request: NextRequest, slug: string, password: string): boolean {
  const cookie = request.cookies.get(`${ACO_COOKIE_PREFIX}${slug}`)?.value;
  return Boolean(cookie && tokenMatches(cookie, slug, password));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const password = reportPassword(slug);
  const html = password ? await reportHtml(slug) : undefined;
  if (!password || !html) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!authorized(request, slug, password)) {
    const showError = request.nextUrl.searchParams.get("error") === "1";
    return htmlResponse(unlockFormHtml(slug, showError), 401);
  }
  return htmlResponse(html, 200);
}

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
