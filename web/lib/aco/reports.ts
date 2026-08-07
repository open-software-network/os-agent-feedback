import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * ACO (AI Commerce Optimization) Reports: password-protected, per-prospect
 * report pages served under /aco-report/<slug>.
 *
 * Configuration is a single environment variable of comma-separated pairs:
 *
 *   ACO_REPORT_PASSWORDS="petsmart:some-password,acme:another-password"
 *
 * A slug with no configured password does not exist as far as the route is
 * concerned (fail closed, 404) — deploying report content never exposes it
 * until its password is provisioned.
 *
 * Report pages are React components registered in aco-reports/registry.ts and
 * rendered by the [slug] page; this module owns the password gate, the access
 * cookie, and the gated PNG assets read from disk at request time.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ASSET_PATTERN = /^[a-z0-9][a-z0-9.-]{0,127}\.png$/;

/**
 * The working directory differs between `next dev` (web/) and the standalone
 * runtime (whose server may or may not chdir into web/ before our code runs),
 * so resolve the report tree by probing both layouts instead of trusting cwd.
 */
let resolvedReportsRoot: string | undefined;
function reportsRoot(): string {
  if (!resolvedReportsRoot) {
    const candidates = [
      path.join(process.cwd(), "aco-reports"),
      path.join(process.cwd(), "web", "aco-reports"),
    ];
    resolvedReportsRoot = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  }
  return resolvedReportsRoot;
}

export function validReportSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function reportPassword(
  slug: string,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!validReportSlug(slug)) return undefined;
  const configured = environment.ACO_REPORT_PASSWORDS?.trim();
  if (!configured) return undefined;
  for (const pair of configured.split(",")) {
    const separator = pair.indexOf(":");
    if (separator < 1) continue;
    const pairSlug = pair.slice(0, separator).trim();
    const password = pair.slice(separator + 1).trim();
    if (pairSlug === slug && password.length > 0) return password;
  }
  return undefined;
}

export const ACO_COOKIE_PREFIX = "aco_report_";

/**
 * The access cookie is an HMAC of the report identity keyed by the report's
 * own password: rotating the password in the environment invalidates every
 * outstanding cookie without any server-side state.
 */
export function accessToken(slug: string, password: string): string {
  return createHmac("sha256", password).update(`aco-report:${slug}`).digest("base64url");
}

export function passwordMatches(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

export function tokenMatches(supplied: string, slug: string, password: string): boolean {
  return passwordMatches(supplied, accessToken(slug, password));
}

export async function reportAsset(slug: string, asset: string): Promise<Buffer | undefined> {
  if (!validReportSlug(slug) || !ASSET_PATTERN.test(asset)) return undefined;
  const assetsDir = path.join(reportsRoot(), slug, "assets");
  try {
    const names = await readdir(assetsDir);
    if (!names.includes(asset)) return undefined;
    return await readFile(path.join(assetsDir, asset));
  } catch {
    return undefined;
  }
}
