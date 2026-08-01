#!/usr/bin/env node

import { Buffer } from "node:buffer";

type Envelope = {
  mode?: string;
  configuredMode?: string;
  state?: string;
  consentRequired?: boolean;
  consentPolicy?: string;
  consentManagedBy?: string;
  when?: string;
  submit?: {
    url?: string;
    method?: string;
    authorization?: string;
    contentType?: string;
    reportSchema?: Record<string, unknown>;
  };
  instruction?: string;
  requiredAction?: {
    type?: string;
    question?: string;
    submitDecision?: {
      url?: string;
      method?: string;
      authorization?: string;
      bodySchema?: { decision?: string[] };
    };
  };
};

type CliOptions = {
  target: string;
  feedbackOrigin: string;
  productHeaders: Headers;
};

const DEFAULT_FEEDBACK_ORIGIN = "https://app.epode.ai";

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function embeddedFromHtml(html: string): Envelope | undefined {
  const match = /<script[^>]+id=["']agent-feedback["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as Envelope;
  } catch {
    fail("The agent-feedback HTML script is not valid JSON");
  }
}

function usage(): string {
  return [
    "Usage: agent-feedback-doctor <product-response-url> [options]",
    "       agent-feedback-doctor --url <product-response-url> [options]",
    "",
    "Options:",
    "  --header-env <header=ENV_VAR>  Read a product-route header from an environment",
    "                                 variable. Repeat for multiple headers.",
    "  --feedback-origin <origin>     Trust an explicit private or loopback Epode origin.",
    "  --help                         Show this help.",
    "",
    "The product request always sends Agent-Feedback-Request: 1 so request-mode",
    "integrations can return a private handoff without compromising shared caches.",
    "Never pass AGENT_FEEDBACK_KEY or AGENT_FEEDBACK_READ_KEY as a product header.",
    "",
    "The feedback origin defaults to https://app.epode.ai. Override it only when testing",
    "an explicit private or loopback Epode deployment.",
  ].join("\n");
}

function productHeaderFromEnvironment(specification: string): [string, string] {
  const separator = specification.indexOf("=");
  const name = specification.slice(0, separator).trim();
  const environmentName = specification.slice(separator + 1).trim();
  if (
    separator < 1 ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)
  ) {
    fail("--header-env must use Header-Name=ENV_VAR");
  }
  if (name.toLowerCase() === "agent-feedback-request") {
    fail("Agent-Feedback-Request is managed by the doctor and cannot be overridden");
  }
  const value = process.env[environmentName];
  if (!value) fail(`Environment variable ${environmentName} is missing or empty`);
  if (
    environmentName === "AGENT_FEEDBACK_KEY" ||
    environmentName === "AGENT_FEEDBACK_READ_KEY" ||
    /(?:^|\s|Bearer\s+)af_(?:live|read)_/i.test(value)
  ) {
    fail(
      "Refusing to send an Epode product or read key to the product URL. Use only your product's own test authentication.",
    );
  }
  return [name, value];
}

function parseCli(args: string[]): CliOptions {
  let target: string | undefined;
  let feedbackOrigin = DEFAULT_FEEDBACK_ORIGIN;
  const productHeaders = new Headers();
  let hasProductHeaders = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--url") {
      target = args[index + 1];
      index += 1;
    } else if (argument === "--header-env") {
      const specification = args[index + 1];
      if (!specification) fail(`--header-env requires Header-Name=ENV_VAR\n${usage()}`);
      const [name, value] = productHeaderFromEnvironment(specification);
      productHeaders.set(name, value);
      hasProductHeaders = true;
      index += 1;
    } else if (argument === "--feedback-origin") {
      feedbackOrigin = args[index + 1] || "";
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (argument?.startsWith("-")) {
      fail(`Unknown option ${argument}\n${usage()}`);
    } else if (!target) {
      target = argument;
    } else {
      fail(`Unexpected argument ${argument}\n${usage()}`);
    }
  }
  if (!target || !feedbackOrigin) fail(usage());
  let targetUrl: URL;
  let trustedFeedbackOrigin: string;
  try {
    targetUrl = new URL(target);
    trustedFeedbackOrigin = new URL(feedbackOrigin).origin;
  } catch {
    fail("Product URL and feedback origin must be valid absolute URLs");
  }
  if (targetUrl.username || targetUrl.password) {
    fail(
      "Do not put product credentials in the URL. Use --header-env Header-Name=ENV_VAR instead.",
    );
  }
  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    fail("Product URL must use HTTPS (or HTTP for local testing)");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(targetUrl.hostname);
  if (hasProductHeaders && targetUrl.protocol !== "https:" && !loopback) {
    fail("Authenticated product checks require HTTPS (HTTP is allowed only for loopback testing)");
  }
  return {
    target: targetUrl.href,
    feedbackOrigin: trustedFeedbackOrigin,
    productHeaders,
  };
}

function trustedActionUrl(
  rawUrl: string | undefined,
  feedbackOrigin: string,
  expectedPath: string,
): URL {
  if (!rawUrl) fail("Response is missing the Epode action URL");
  const url = new URL(rawUrl);
  const trusted = new URL(feedbackOrigin);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    fail("Epode action URL must use HTTPS (HTTP is allowed only for loopback testing)");
  }
  if (url.origin !== trusted.origin) {
    fail(`Refusing action URL on untrusted feedback origin ${url.origin}`);
  }
  if (url.pathname !== expectedPath) {
    fail(`Epode action URL must use ${expectedPath}`);
  }
  return url;
}

async function main(): Promise<void> {
  const { target, feedbackOrigin, productHeaders } = parseCli(process.argv.slice(2));
  const headers = new Headers({
    accept: "application/json, text/html",
    "agent-feedback-request": "1",
  });
  for (const [name, value] of productHeaders) headers.set(name, value);
  const response = await fetch(target, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    fail(
      `Product returned redirect HTTP ${response.status}. Run the doctor against the final HTTPS product route directly so authentication is never forwarded across a redirect.`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    fail(
      `Product returned HTTP ${response.status}. For an authenticated route, put your product's test authorization in an environment variable and pass --header-env Authorization=ENV_VAR. Never use AGENT_FEEDBACK_KEY.`,
    );
  }
  if (response.status === 404) {
    fail("Product returned HTTP 404. Check the deployed URL and the integration include pattern");
  }
  if (!response.ok) fail(`Product returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  let envelope: Envelope | undefined;
  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      fail("Product declared application/json but returned invalid JSON");
    }
    envelope = body._agentFeedback as Envelope | undefined;
  } else if (contentType.includes("text/html")) {
    envelope = embeddedFromHtml(raw);
  }
  if (!envelope) {
    const encoded = response.headers.get("agent-feedback");
    if (encoded) {
      try {
        envelope = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Envelope;
      } catch {
        fail("The Agent-Feedback response header is not valid base64url JSON");
      }
    }
  }
  if (!envelope?.instruction) {
    fail(
      "No feedback handoff was found. Check that this exact route matches include, returns an eligible 2xx response, uses a current write key, and has AGENT_FEEDBACK_ENABLED enabled. The doctor already sent Agent-Feedback-Request: 1.",
    );
  }
  console.log(`PASS product route HTTP ${response.status}`);
  if (envelope.state === "consent_required") {
    if (envelope.configuredMode === "ask_once" && envelope.mode === "ask_always") {
      fail(
        "Ask once could not resolve customerRef for this eligible response. Run product authentication and authorized tenant selection before Agent Feedback, then rerun the doctor with a real authenticated request. If the route is intentionally anonymous, configure Ask every time instead.",
      );
    }
    const action = envelope.requiredAction;
    const validOnce =
      envelope.mode === "ask_once" &&
      envelope.consentRequired === true &&
      envelope.consentPolicy === "once" &&
      envelope.when === "after_experience_known_and_consent_resolved";
    const validAlways =
      envelope.mode === "ask_always" &&
      envelope.consentRequired === true &&
      envelope.consentPolicy === "always" &&
      envelope.when === "after_experience_known_and_explicit_user_approval";
    if (
      (!validOnce && !validAlways) ||
      envelope.consentManagedBy !== "epode" ||
      envelope.submit !== undefined ||
      action?.type !== "ask_user" ||
      action.submitDecision?.method !== "POST" ||
      !action.submitDecision.authorization?.startsWith("Bearer afr2_") ||
      action.submitDecision.bodySchema?.decision?.join(",") !== "approved,declined"
    ) {
      fail("Response has an invalid answer-first consent contract");
    }
    trustedActionUrl(action.submitDecision.url, feedbackOrigin, "/api/v2/consent/decisions");
    console.log("PASS response injection");
    console.log("PASS trusted Epode decision origin");
    console.log(`PASS ${envelope.mode} answer-first decision contract`);
    console.log("PASS report schema withheld until approval");
    console.log("PASS synthetic decision skipped; the doctor cannot impersonate the user");
    console.log("PASS first opportunity handoff; check Setup after the telemetry queue flushes");
    console.log(
      "NEXT use a real feedback-aware customer-agent task to prove confirmation and reporting",
    );
    return;
  }
  if (
    envelope.state !== "feedback_ready" ||
    !envelope.submit?.url ||
    envelope.submit.method !== "POST" ||
    !envelope.submit.authorization?.startsWith("Bearer afr2_") ||
    !envelope.submit.reportSchema
  ) {
    fail("Response has an incomplete feedback submission contract");
  }
  if (
    envelope.mode !== "never_ask" ||
    envelope.consentRequired !== false ||
    envelope.consentPolicy !== "none" ||
    envelope.when !== "after_experience_known_before_final_response"
  ) {
    fail("Response has an invalid Never ask feedback contract");
  }
  trustedActionUrl(envelope.submit.url, feedbackOrigin, "/api/v2/reports");
  const inspectionUrl = new URL("/api/v2/capabilities/introspect", feedbackOrigin).toString();
  const inspection = await fetch(inspectionUrl, {
    method: "POST",
    headers: {
      authorization: envelope.submit.authorization,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (inspection.status === 401) {
    fail("Capability inspection returned HTTP 401. The feedback capability is invalid or expired");
  }
  if (inspection.status === 410) {
    fail("Capability inspection returned HTTP 410. Feedback collection is disabled");
  }
  if (!inspection.ok) fail(`Capability inspection returned HTTP ${inspection.status}`);
  const verified = (await inspection.json()) as {
    state?: string;
    configuredMode?: string;
    productName?: string;
    expiresAt?: string;
  };
  if (
    verified.state !== "feedback_ready" ||
    typeof verified.configuredMode !== "string" ||
    typeof verified.productName !== "string" ||
    typeof verified.expiresAt !== "string"
  ) {
    fail("Capability inspection returned an incomplete verified contract");
  }
  console.log(`PASS response injection`);
  console.log(`PASS trusted Epode submission origin`);
  console.log(`PASS scoped capability inspection for ${verified.productName}`);
  console.log("PASS company-side opportunity handoff; no feedback report was created");
  console.log(
    "NEXT use a real feedback-aware customer-agent task to prove confirmation and reporting",
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
