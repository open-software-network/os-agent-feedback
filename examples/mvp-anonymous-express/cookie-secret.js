export function requiredCookieSecret(environment = process.env) {
  const configured = environment.VISITOR_COOKIE_SECRET;
  if (configured) {
    if (Buffer.byteLength(configured, "utf8") < 32) {
      throw new Error("VISITOR_COOKIE_SECRET must contain at least 32 bytes");
    }
    return configured;
  }
  if (environment.LOCAL_DEMO === "true") {
    return "epode-local-demo-visitor-cookie-secret-not-for-production";
  }
  throw new Error("VISITOR_COOKIE_SECRET is required; use LOCAL_DEMO=true only for local demos");
}
