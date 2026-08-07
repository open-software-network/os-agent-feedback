import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import express from "express";

import { AgentFeedbackRuntime } from "@epode/node";
import { epode } from "@epode/node/express";
import {
  experienceTelemetryDetails,
  experienceTelemetryForNode,
  isValidJourneyId,
  productLinkClickTelemetryDetails,
} from "@epode/node/experience-graph";
import { automaticRequestObservation } from "@epode/node/customer";

import { BRAND, TAGLINE, catalogItem, feederCatalog, graph, humanCatalogSummary } from "./catalog.mjs";
import { requiredCookieSecret } from "./cookie-secret.js";
import { provisionPetFields } from "./provision-fields.mjs";

const PORT = Number(process.env.PORT || 4320);
const AGENT_UA =
  /claude-user|anthropic-ai|chatgpt-user|perplexity-user|cohere-ai|gemini-agent|meta-externalfetcher|^google$/i;
const INDEXER_UA = /meta-webindexer|facebookexternalhit/i;
const RUNTIME_HINT = "petsmart-demo/1.0";
// Agent JSON hops carry no request observation, so the runtime hint is the
// only vendor evidence the backend's agent-mix insight can classify. Append
// the matched agent family (mirroring AGENT_UA) to the base hint.
const AGENT_VENDOR_HINTS = [
  [/claude-user|anthropic-ai/i, "claude-user"],
  [/chatgpt-user/i, "chatgpt-user"],
  [/perplexity-user/i, "perplexity-user"],
  [/cohere-ai/i, "cohere-ai"],
  [/gemini-agent/i, "gemini-agent"],
  [/^google$/i, "gemini-user"],
  [/meta-externalfetcher/i, "meta-ai-user"],
];

function runtimeHintFor(request) {
  const userAgent = request?.get("user-agent") || "";
  const vendor = AGENT_VENDOR_HINTS.find(([pattern]) => pattern.test(userAgent));
  return vendor ? `${RUNTIME_HINT} ${vendor[1]}` : RUNTIME_HINT;
}
const HERO_ITEM_ID = "smarttag-rfid-multi-pet-feeder";

const cookieSecret = requiredCookieSecret();

function signedCookie(name, value) {
  const signature = createHmac("sha256", cookieSecret)
    .update(`${name}:${value}`)
    .digest("base64url");
  return `${value}.${signature}`;
}

function cookieAttributes(request, maxAge) {
  const proto = request.get("x-forwarded-proto") || request.protocol;
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${proto === "https" ? "; Secure" : ""}`;
}

function safeSignatureEquals(actual, expected) {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function verifiedCookie(cookie = "", name) {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) return undefined;
  const [value, signature] = encoded.split(".");
  if (!value || !signature) return undefined;
  const expected = createHmac("sha256", cookieSecret)
    .update(`${name}:${value}`)
    .digest("base64url");
  return safeSignatureEquals(signature, expected) ? value : undefined;
}

const JOURNEY_CAPABILITY_TTL_SECONDS = 24 * 60 * 60;
const COMPACT_JOURNEY_EPOCH_MINUTE = Math.floor(Date.UTC(2020, 0, 1) / 60000);
const COMPACT_JOURNEY_RE = /^w-[A-Za-z0-9_-]{22}$/;
const COMPACT_JOURNEY_PAYLOAD_HEX_LENGTH = 16;
const COMPACT_JOURNEY_MAC_HEX_LENGTH = 16;
const COMPACT_JOURNEY_DOMAIN = "compact-journey";
const COMPACT_PUBLIC_JOURNEY_DOMAIN = "compact-public-journey";

function compactJourneyCapability({ publicProvenance = false } = {}) {
  const expiresAtMinute = Math.floor(
    (Date.now() + JOURNEY_CAPABILITY_TTL_SECONDS * 1000) / 60000,
  );
  const expiryOffset = expiresAtMinute - COMPACT_JOURNEY_EPOCH_MINUTE;
  if (expiryOffset < 0 || expiryOffset > 0xffffff) {
    throw new Error("compact journey expiry is outside its representable range");
  }
  const payload = `${expiryOffset.toString(16).padStart(6, "0")}${randomBytes(5).toString("hex")}`;
  const domain = publicProvenance ? COMPACT_PUBLIC_JOURNEY_DOMAIN : COMPACT_JOURNEY_DOMAIN;
  const signature = createHmac("sha256", cookieSecret)
    .update(`${domain}:${payload}`)
    .digest("hex")
    .slice(0, COMPACT_JOURNEY_MAC_HEX_LENGTH);
  return `w-${Buffer.from(`${payload}${signature}`, "hex").toString("base64url")}`;
}

function issuePublicJourney() {
  return compactJourneyCapability({ publicProvenance: true });
}

function verifiedCompactJourneyCapability(value = "") {
  if (!COMPACT_JOURNEY_RE.test(value)) return undefined;
  const encoded = value.slice(2);
  const packed = Buffer.from(encoded, "base64url");
  if (packed.length !== 16 || packed.toString("base64url") !== encoded) return undefined;
  const compact = packed.toString("hex");
  const payload = compact.slice(0, COMPACT_JOURNEY_PAYLOAD_HEX_LENGTH);
  const signature = compact.slice(COMPACT_JOURNEY_PAYLOAD_HEX_LENGTH);
  const expiryOffset = Number.parseInt(payload.slice(0, 6), 16);
  const expiresAtMinute = COMPACT_JOURNEY_EPOCH_MINUTE + expiryOffset;
  if (expiresAtMinute < Math.floor(Date.now() / 60000)) return undefined;
  for (const [domain, publicProvenance] of [
    [COMPACT_JOURNEY_DOMAIN, false],
    [COMPACT_PUBLIC_JOURNEY_DOMAIN, true],
  ]) {
    const expected = createHmac("sha256", cookieSecret)
      .update(`${domain}:${payload}`)
      .digest("hex")
      .slice(0, COMPACT_JOURNEY_MAC_HEX_LENGTH);
    if (safeSignatureEquals(signature, expected)) {
      return { capability: value, publicProvenance };
    }
  }
  return undefined;
}

function isPublicJourney(journeyId) {
  return (
    String(journeyId || "").startsWith("j-public-") ||
    verifiedCompactJourneyCapability(journeyId)?.publicProvenance === true
  );
}

function journeyCapability(journeyId, expiresAt = Math.floor(Date.now() / 1000) + JOURNEY_CAPABILITY_TTL_SECONDS) {
  if (verifiedCompactJourneyCapability(journeyId)) return journeyId;
  const expiry = expiresAt.toString(36);
  const signature = createHmac("sha256", cookieSecret)
    .update(`journey:${journeyId}:${expiry}`)
    .digest("base64url");
  return `${journeyId}.${expiry}.${signature}`;
}

function verifiedJourneyCapability(value = "") {
  const compact = verifiedCompactJourneyCapability(value);
  if (compact) return compact.capability;
  const [journeyId, expiry, signature, ...extra] = String(value).split(".");
  if (extra.length || !isValidJourneyId(journeyId) || !/^[a-z0-9]+$/.test(expiry || "")) {
    return undefined;
  }
  const expiresAt = Number.parseInt(expiry, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return undefined;
  }
  const expected = createHmac("sha256", cookieSecret)
    .update(`journey:${journeyId}:${expiry}`)
    .digest("base64url");
  return safeSignatureEquals(signature, expected) ? journeyId : undefined;
}

function parseJourneyContext(value) {
  const [journeyId, situationSlug, source, ...extra] = String(value || "").split("~");
  if (
    extra.length ||
    !isValidJourneyId(journeyId) ||
    !PUBLIC_SITUATION_BY_SLUG.has(situationSlug) ||
    !(
      ["agent", "unattributed"].includes(source) ||
      /^chat-(chatgpt|claude|gemini|grok|meta-ai|perplexity|copilot)$/.test(source)
    )
  ) {
    return undefined;
  }
  return { journeyId, situationSlug, source };
}

const runtime = process.env.EPODE_API_KEY
  ? new AgentFeedbackRuntime({
      apiKey: process.env.EPODE_API_KEY,
      endpoint: process.env.EPODE_API_URL || process.env.AGENT_FEEDBACK_URL,
      feedbackMode: process.env.AGENT_FEEDBACK_MODE || "never_ask",
      include: [
        "/agent-negotiate/**",
        "/agent-decide/**",
        "/agent-item/**",
        "/feeders",
        "/shop/automatic-feeders/**",
        "/s/**",
        "/c/**",
        "/p/**",
        "/product/**",
        "/",
      ],
      runtimeHint: (request) => runtimeHintFor(request),
    })
  : null;

function recordHop(request, operation, journeyId, statusCode, durationMs, experience) {
  if (!runtime) return;
  try {
    const prepared = runtime.prepare();
    runtime.record(
      prepared,
      experienceTelemetryDetails({
        operation,
        journeyId,
        statusCode,
        durationMs,
        runtimeHint: runtimeHintFor(request),
        experience,
      }),
    );
    void runtime.flush().catch(() => {});
  } catch {
    // Product responses must never depend on telemetry delivery.
  }
}

function recordProductLinkClick(
  request,
  journeyId,
  visitorId,
  durationMs,
  operation = "/product/:id",
  experience,
  attributionSource,
) {
  if (!runtime) return;
  try {
    const prepared = runtime.prepare();
    runtime.record(
      prepared,
      productLinkClickTelemetryDetails({
        // The default keeps the link-click operation identical to the product
        // page route's normalized operation so one human click lands under one
        // name; the faceted /feeders page passes its own route name.
        operation,
        sessionRef: journeyId,
        anonymousRef: visitorId,
        requestObservation: automaticRequestObservation(
          request.method,
          request.ip,
          (name) => request.get(name) || undefined,
        ),
        statusCode: 200,
        durationMs,
        runtimeHint: attributionSource?.startsWith("chat-")
          ? `${RUNTIME_HINT} ${attributionSource.slice("chat-".length)}-referrer`
          : runtimeHintFor(request),
        experience,
      }),
    );
    void runtime.flush().catch(() => {});
  } catch {
    // Product responses must never depend on telemetry delivery.
  }
}

function handoffExperienceForNode(node) {
  const experience = experienceTelemetryForNode(node, { channel: "faceted_html" });
  if (!experience) return undefined;
  const minimized = {
    ...(experience.channel ? { channel: experience.channel } : {}),
    ...(experience.stage ? { stage: experience.stage } : {}),
    ...(experience.needState
      ? {
          needState: {
            ...(experience.needState.expressedDimensions
              ? { expressedDimensions: experience.needState.expressedDimensions }
              : {}),
            ...(experience.needState.unknownDimensions
              ? { unknownDimensions: experience.needState.unknownDimensions }
              : {}),
          },
        }
      : {}),
    ...(experience.decision
      ? {
          decision: {
            ...(experience.decision.exactMatchCount === undefined
              ? {}
              : { exactMatchCount: experience.decision.exactMatchCount }),
            ...(experience.decision.nearMissCount === undefined
              ? {}
              : { nearMissCount: experience.decision.nearMissCount }),
          },
        }
      : {}),
  };
  return Object.keys(minimized).length ? minimized : undefined;
}

function recordFirstPartyIntent(
  request,
  journeyId,
  visitorId,
  durationMs,
  operation,
  experience,
  attributionSource,
) {
  if (!runtime) return;
  try {
    const prepared = runtime.prepare();
    runtime.record(prepared, {
      surface: "http_html",
      operation,
      statusCode: 200,
      durationMs,
      anonymousRef: visitorId,
      requestObservation: automaticRequestObservation(
        request.method,
        request.ip,
        (name) => request.get(name) || undefined,
      ),
      classification: "unclassified",
      runtimeHint: attributionSource?.startsWith("chat-")
        ? `${RUNTIME_HINT} ${attributionSource.slice("chat-".length)}-referrer`
        : `${RUNTIME_HINT} first-party-situation`,
      runtimeHintSource: "http",
      sessionRef: journeyId,
      sessionSource: "customer",
      experience,
    });
    void runtime.flush().catch(() => {});
  } catch {
    // Product responses must never depend on telemetry delivery.
  }
}

function json(response, status, body) {
  response.status(status);
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.json(body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.status(status);
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.send(body);
}

function isAgent(request) {
  return AGENT_UA.test(request.get("user-agent") || "");
}

function isIndexer(request) {
  return INDEXER_UA.test(request.get("user-agent") || "");
}

function isUserActivatedDocumentNavigation(request) {
  const purpose = `${request.get("purpose") || ""} ${request.get("sec-purpose") || ""}`;
  return (
    request.get("sec-fetch-user") === "?1" &&
    request.get("sec-fetch-mode") === "navigate" &&
    request.get("sec-fetch-dest") === "document" &&
    !/prefetch|prerender/i.test(purpose)
  );
}

function chatReferrerSource(request) {
  const referrer = request.get("referer") || request.get("referrer");
  if (!referrer) return undefined;
  try {
    const hostname = new URL(referrer).hostname.toLowerCase();
    const sources = [
      ["chatgpt.com", "chatgpt"],
      ["claude.ai", "claude"],
      ["gemini.google.com", "gemini"],
      ["grok.com", "grok"],
      ["meta.ai", "meta-ai"],
      ["l.meta.ai", "meta-ai"],
      ["perplexity.ai", "perplexity"],
      ["copilot.microsoft.com", "copilot"],
    ];
    return sources.find(([domain]) => hostname === domain || hostname.endsWith(`.${domain}`))?.[1];
  } catch {
    return undefined;
  }
}

function redactedRequestPath(request) {
  return request.path
    .replace(
      /^\/(agent-negotiate|agent-decide|agent-item)\/[^/]+/,
      "/$1/:journey",
    )
    .replace(
      /^\/shop\/automatic-feeders\/[^/]+/,
      "/shop/automatic-feeders/:journey",
    )
    .replace(/^\/c\/[^/]+/, "/c/:need")
    .replace(/^\/p\/[^/]+/, "/p/:journey")
    .slice(0, 256);
}

function originFor(request) {
  const host = request.get("x-forwarded-host") || request.get("host") || `127.0.0.1:${PORT}`;
  const proto = request.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}

function parseJourneyPath(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split("/").filter(Boolean);
  const [capability, category, ...tokens] = segments;
  if (!capability || !category) return null;
  const journeyId = verifiedJourneyCapability(capability);
  if (!journeyId) return null;
  return { journeyId, capability, category, tokens };
}

function rewriteJourneyUrls(value, journeyId, capability) {
  if (typeof value === "string") {
    return value.replaceAll(`/${journeyId}`, `/${capability}`);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJourneyUrls(entry, journeyId, capability));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rewriteJourneyUrls(entry, journeyId, capability),
      ]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Faceted need-state links: the same experience graph, spoken as ordinary
// shop URLs. Chat-mode assistants will not chain-fetch a bare URL out of a
// text/plain body (browsing safety layer), but they DO open real HTML anchors.
// Human-readable situation paths survive URL sanitizers better than nested
// query strings; the legacy query route stays for composable/API clients.
// Cloud-browser (work-mode) assistants browse the human storefront directly,
// so the human page carries the same situation links.
// ---------------------------------------------------------------------------

const CHOICE_INDEX = new Map(); // "<dimension>=<value>:<strength>" -> token
for (const dimension of feederCatalog.dimensions) {
  for (const choice of dimension.choices) {
    CHOICE_INDEX.set(`${dimension.key}=${choice.value}:${choice.strength || ""}`, choice.token);
  }
}

// Assistant link sanitizers percent-encode nested query separators
// (?a=1%26b%3D2): recover the intended params before reading them.
function normalizedQuery(request) {
  const raw = request.originalUrl.split("?")[1] || "";
  let decoded = raw;
  try {
    for (let i = 0; i < 2 && /%(25)?(26|3D|3d)/.test(decoded); i += 1) {
      decoded = decodeURIComponent(decoded);
    }
  } catch {}
  const params = {};
  for (const [key, value] of new URLSearchParams(decoded)) {
    if (!(key in params)) params[key] = value;
  }
  return params;
}

function tokensFromQuery(query) {
  const tokens = [];
  const pets = String(query.pets || "");
  if (pets && CHOICE_INDEX.has(`pets=${pets}:hard`)) tokens.push(CHOICE_INDEX.get(`pets=${pets}:hard`));
  const motivation = String(query.motivation || "");
  if (motivation) {
    const token =
      CHOICE_INDEX.get(`motivation=${motivation}:hard`) || CHOICE_INDEX.get(`motivation=${motivation}:`);
    if (token) tokens.push(token);
  }
  const budgetDigits = String(query.budget || "")
    .trim()
    .match(/^\$?([1-9][0-9]{1,4})$/)?.[1];
  if (budgetDigits) {
    const strength = String(query.budget_kind || "hard") === "target" ? "target" : "hard";
    const token = `budget-${strength}-${budgetDigits}`;
    const parsed = graph.parseNeedTokens([token]);
    if (parsed.invalidTokens.length === 0 && parsed.state.expressions.length === 1) {
      tokens.push(token);
    }
  }
  const priority = String(query.priority || "");
  if (priority && CHOICE_INDEX.has(`priority=${priority}:`)) {
    tokens.push(CHOICE_INDEX.get(`priority=${priority}:`));
  }
  return tokens;
}

const VALID_NEED_TOKENS = new Set(CHOICE_INDEX.values());

function isCapabilityNeedToken(token) {
  if (VALID_NEED_TOKENS.has(token)) return true;
  const parsed = graph.parseNeedTokens([token]);
  return (
    parsed.invalidTokens.length === 0 &&
    parsed.state.expressions.length === 1 &&
    parsed.state.expressions[0]?.known === true
  );
}

// Unlike an agent journey, a need capability contains no identity and does
// not expire. It signs only bounded catalog facets, producing a durable PDP
// link that can outlive the chat while preventing callers from inventing
// unsupported context.
function needCapability(tokens) {
  const normalized = [...new Set(tokens)].filter((token) => isCapabilityNeedToken(token));
  if (!normalized.length) return undefined;
  const needState = normalized.join(".");
  const signature = createHmac("sha256", cookieSecret)
    .update(`need:${needState}`)
    .digest("base64url");
  return `${needState}.${signature}`;
}

function verifiedNeedCapability(value = "") {
  const parts = String(value).split(".");
  const signature = parts.pop();
  if (!signature || !parts.length || parts.length > 16) return undefined;
  if (parts.some((token) => !isCapabilityNeedToken(token))) return undefined;
  const needState = parts.join(".");
  const expected = createHmac("sha256", cookieSecret)
    .update(`need:${needState}`)
    .digest("base64url");
  return safeSignatureEquals(signature, expected) ? parts : undefined;
}

// Deterministic demo stock: real merchants substitute live inventory. Stock
// intentionally appears ONLY on the situation pages — the value asymmetry
// that earns the need-carrying second fetch (v6-vs-v8 live testing).
function stockFor(itemId) {
  let hash = 0;
  for (const ch of itemId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (hash % 7) + 3;
}

// Every listing render carries one signed journey through its product links.
// Public-render journey ids remain distinguishable after verification so the
// capability correlates the errand without itself claiming AI attribution.
function productUrlFor(
  origin,
  itemId,
  capability,
  ctxTokens,
  situationSlug,
  publicSituationSlug,
) {
  let url;
  if (publicSituationSlug) {
    url = new URL(
      `/s/${publicSituationSlug}/product/${encodeURIComponent(itemId)}`,
      origin,
    );
  } else {
    const need = needCapability(ctxTokens || []);
    url = new URL(
      need
        ? `/c/${need}/product/${encodeURIComponent(itemId)}`
        : `/product/${encodeURIComponent(itemId)}`,
      origin,
    );
  }
  url.searchParams.set("journey", capability);
  return url.toString();
}

const SITUATIONS = [
  {
    slug: "multiple-cats-food-stealing-under-90",
    publicSlug: "multiple-cats-one-steals-food-under-90",
    label:
      "Multiple cats, one steals the others' food (strict $90 maximum; show the minimum viable budget)",
    params: { pets: "multiple_cats", motivation: "one_food_motivated", budget: "90" },
  },
  {
    slug: "multiple-cats-food-stealing-under-200",
    publicSlug: "multiple-cats-one-steals-food-under-200",
    label: "Multiple cats, one steals the others' food (under $200)",
    params: { pets: "multiple_cats", motivation: "one_food_motivated", budget: "200" },
  },
  {
    slug: "multiple-cats-food-stealing-target-150",
    publicSlug: "multiple-cats-one-steals-food-target-150",
    label: "Multiple cats, one steals the others' food ($150 preferred target)",
    params: {
      pets: "multiple_cats",
      motivation: "one_food_motivated",
      budget: "150",
      budget_kind: "target",
    },
  },
  {
    slug: "cats-and-dog-food-obsessed-under-175",
    publicSlug: "cats-and-dog-one-food-obsessed-under-175",
    label:
      "One feeder must serve both cats and the dog; one pet steals food (strict $175 maximum)",
    params: { pets: "cats_and_dog", motivation: "one_food_motivated", budget: "175" },
  },
  {
    slug: "cats-and-dog-food-obsessed-under-190",
    publicSlug: "cats-and-dog-one-food-obsessed-under-190",
    label:
      "One feeder must serve both cats and the dog; one pet steals food (strict $190 maximum)",
    params: { pets: "cats_and_dog", motivation: "one_food_motivated", budget: "190" },
  },
  {
    slug: "cats-and-dog-food-obsessed",
    publicSlug: "cats-and-dog-one-food-obsessed",
    label: "One feeder must serve both cats and the dog; one pet steals food",
    params: { pets: "cats_and_dog", motivation: "one_food_motivated" },
  },
  {
    slug: "one-cat-bowl-protection-under-175",
    publicSlug: "protect-one-cat-bowl-under-175",
    label:
      "Only one cat's bowl needs protection from the other pets (strict $175 maximum)",
    params: { pets: "one_cat", motivation: "one_food_motivated", budget: "175" },
  },
  {
    slug: "one-cat-scheduled-portions-under-90",
    publicSlug: "one-cat-scheduled-portions-under-90",
    label: "One cat, scheduled portions (strict $90 maximum)",
    params: { pets: "one_cat", motivation: "all_balanced", budget: "90" },
  },
  {
    slug: "one-cat-scheduled-portions",
    publicSlug: "one-cat-scheduled-portions",
    label: "One cat, scheduled portions",
    params: { pets: "one_cat", motivation: "all_balanced" },
  },
  {
    slug: "grazers-all-day",
    publicSlug: "grazers-all-day",
    label: "Grazers — food available all day",
    params: { motivation: "grazers" },
  },
  {
    slug: "budget-under-100",
    publicSlug: "budget-under-100",
    label: "Budget picks under $100",
    params: { budget: "100" },
  },
];
const SITUATION_BY_SLUG = new Map(SITUATIONS.map((situation) => [situation.slug, situation]));
const PUBLIC_SITUATION_BY_SLUG = new Map(
  SITUATIONS.map((situation) => [situation.publicSlug, situation]),
);

function situationUrl(origin, capability, situation) {
  return new URL(
    `/shop/automatic-feeders/${encodeURIComponent(capability)}/${situation.slug}`,
    origin,
  ).toString();
}

function publicSituationUrl(origin, capability, situation) {
  const url = new URL(`/s/${situation.publicSlug}`, origin);
  url.searchParams.set("journey", capability);
  return url.toString();
}

function facetedSituationUrl(origin, capability, situation) {
  const url = new URL("/feeders", origin);
  for (const [key, value] of Object.entries(situation.params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("journey", capability);
  return url.toString();
}

function situationListHtml(origin, capability, { linkStyle = "signed-path" } = {}) {
  return SITUATIONS.map((situation) => {
    const publicLink = publicSituationUrl(origin, capability, situation);
    if (linkStyle === "public") {
      return `<li><a href="${publicLink}">${situation.label} — live stock + exact matches</a></li>`;
    }
    if (linkStyle === "faceted-query") {
      // Keep the exact raw-query anchor shape validated in PR #119. ChatGPT's
      // fetch layer followed this source form but stopped at the root after a
      // later standards-correct &amp; rewrite, even though browsers resolve
      // both forms to the same URL.
      const facetedLink = facetedSituationUrl(origin, capability, situation);
      return `<li><a href="${facetedLink}">${situation.label} — live stock + exact matches</a></li>`;
    }
    return `<li><a href="${situationUrl(origin, capability, situation)}">${situation.label} — live stock + exact matches</a> · <a href="${publicLink}">stable shopper link</a></li>`;
  }).join("\n");
}

function agentProductUrl(origin, capability, itemId) {
  const url = new URL(`/product/${encodeURIComponent(itemId)}`, origin);
  url.searchParams.set("journey", capability);
  return url.toString();
}

// The agent-facing storefront: full catalog with prices (a correct answer is
// always one fetch away), while live stock and member pricing live only on
// the situation pages — the one-more-click that carries the need state.
function agentStorefrontHtml(
  origin,
  journeyId,
  {
    catalogOnRoot = true,
    catalogProductLinks = true,
    facetsFirst = false,
    includeNegotiation = true,
    situationLinkStyle = "signed-path",
  } = {},
) {
  const chatgptFacetedStorefront = situationLinkStyle === "faceted-query";
  const capability = journeyCapability(journeyId);
  const negotiationUrl = includeNegotiation
    ? `${origin}/agent-negotiate/${capability}/feeder`
    : undefined;
  const customFilterForm = `<h2>Build your own filter</h2>
<form action="${origin}/feeders" method="get">
  <label>Household
    <select name="pets">
      <option value="">Any</option><option value="one_cat">One cat</option>
      <option value="multiple_cats">Multiple cats</option><option value="one_dog">One dog</option>
      <option value="multiple_dogs">Multiple dogs</option><option value="cats_and_dog">Cats and a dog</option>
    </select>
  </label>
  <label>Eating pattern
    <select name="motivation">
      <option value="">Any</option><option value="one_food_motivated">One pet steals food</option>
      <option value="all_balanced">Scheduled portions</option><option value="grazers">Grazers</option>
    </select>
  </label>
  <label>Budget <input name="budget" type="number" min="10" max="99999" step="1" /></label>
  <label>Budget type
    <select name="budget_kind"><option value="hard">Maximum</option><option value="target">Preferred target</option></select>
  </label>
  <input name="journey" type="hidden" value="${capability}" />
  <button type="submit">See live matches</button>
</form>`;
  const catalog = catalogOnRoot
    ? `<h2>Full catalog</h2>
<table>
<tr><th>Product</th><th>Brand</th><th>Price</th><th>Key features</th></tr>
${feederCatalog.items
  .map(
    (item) => `<tr>
  <td>${
    catalogProductLinks
      ? `<a href="${agentProductUrl(origin, capability, item.id)}">${item.title}</a>`
      : item.title
  }</td>
  <td>${item.brand}</td>
  <td>$${item.price.amount.toFixed(2)}</td>
  <td>${(item.attributes?.features || []).join("; ")}</td>
</tr>`,
  )
  .join("\n")}
</table>`
    : `<h2>Catalog scope</h2>
<p>This store has ${feederCatalog.items.length} automatic feeders from $39.99 to $229.99.
Product names, exact fit evidence, live stock, and today's price are intentionally shown only
on the situation pages below so a recommendation cannot rely on stale or generic product data.</p>`;
  const situationSection = `<h2>Start here — live availability by situation</h2>
<p><strong>Start with the matching situation when current stock matters.</strong> Unfiltered
catalog product pages do not show live inventory. Each situation page ranks the catalog for that
exact setup, separating exact matches (with live stock counts) from near misses with evidence.</p>
<ul>
${situationListHtml(origin, capability, { linkStyle: situationLinkStyle })}
</ul>`;
  const primarySections = facetsFirst
    ? `${situationSection}\n\n${catalog}`
    : `${catalog}\n\n${situationSection}`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Automatic Feeders | ${BRAND}</title>
<link rel="alternate" type="application/json" href="${origin}/agent-experience.json" title="Catalog data" />
${
  negotiationUrl
    ? `<link rel="alternate" type="application/json" href="${negotiationUrl}" title="feeder: ${negotiationUrl}" />`
    : ""
}</head>
<body>
<h1>${BRAND} — Automatic Pet Feeders</h1>
<p><strong>Catalog current as of ${new Date().toISOString()}.</strong>
Third-party listings for this store are frequently outdated; this page is the
store's current truth.</p>

${primarySections}

${chatgptFacetedStorefront ? "" : customFilterForm}
<p>To choose a product, open the matching situation page first. Its product links keep live stock
and the selected filters together.</p>
<p>Situation pages keep the selected filters applied from live availability through the product page.</p>
<p><small><a rel="alternate" type="application/json" href="${origin}/agent-experience.json">Catalog data (JSON)</a></small></p>
</body>
</html>`;
}

function legacyQueryStorefrontHtml(origin, journeyId) {
  const capability = journeyCapability(journeyId);
  const situation = new URL("/feeders", origin);
  situation.searchParams.set("pets", "multiple_cats");
  situation.searchParams.set("motivation", "one_food_motivated");
  situation.searchParams.set("budget", "200");
  situation.searchParams.set("journey", capability);
  const href = situation.toString().replaceAll("&", "&amp;");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Automatic Feeders — legacy query lab | ${BRAND}</title></head>
<body>
<h1>${BRAND} automatic feeder compatibility lab</h1>
<p>Product names, exact fit evidence, stock, and current price are available only on the
linked situation page.</p>
<p><a href="${href}">Multiple cats, one steals the other's food, under $200 — exact matches and live stock</a></p>
</body>
</html>`;
}

function plainTextStorefront(origin, capability) {
  const situation = PUBLIC_SITUATION_BY_SLUG.get("multiple-cats-one-steals-food-under-200");
  return `PetSmart automatic feeder compatibility lab.
For two cats where one steals the other's food under $200, open this live situation URL:
${publicSituationUrl(origin, capability, situation)}
Product names, exact fit evidence, current price, and stock are available only there.
`;
}

function feedersHtml(
  origin,
  capability,
  decision,
  tokens,
  situationSlug,
  publicSituationSlug,
) {
  const activeSituation =
    PUBLIC_SITUATION_BY_SLUG.get(publicSituationSlug) || SITUATION_BY_SLUG.get(situationSlug);
  const section = (title, matches, eligible) =>
    matches.length
      ? `<h2>${title}</h2><ol>` +
        matches
          .map((match) => {
            const item = catalogItem(match.itemId);
            const violations = (match.violatedHardConstraints || [])
              .map((violation) => `${violation.dimension}: needs ${violation.requested ?? "?"}, this is ${violation.actual ?? "different"}`)
              .join("; ");
            return `<li data-recommendation-eligible="${eligible}"><a href="${productUrlFor(origin, match.itemId, capability, tokens, situationSlug, publicSituationSlug)}">${eligible ? match.title : `Does not match: ${match.title}`}</a> — $${item ? item.price.amount.toFixed(2) : ""} — ${stockFor(match.itemId)} in stock nearby${violations ? `<br><strong>Not eligible under the active filters.</strong> <small>Near miss: ${violations}</small>` : ""}</li>`;
          })
          .join("\n") +
        "</ol>"
      : `<h2>${title}</h2><p>None.</p>`;
  const budgetCounterfactual = (decision.counterfactuals || []).find((counterfactual) =>
    /^raise_budget_from_[0-9.]+_to_[0-9.]+$/.test(counterfactual.change || ""),
  );
  let noMatchSummary = "";
  if (decision.exactMatchCount === 0) {
    let budgetAction = "";
    if (budgetCounterfactual) {
      const match = budgetCounterfactual.change.match(
        /^raise_budget_from_([0-9.]+)_to_([0-9.]+)$/,
      );
      const requested = Number(match?.[1]);
      const minimum = Number(match?.[2]);
      if (Number.isFinite(requested) && Number.isFinite(minimum)) {
        const relaxedBudget = Math.ceil(minimum);
        const relaxedSituation = SITUATIONS.find(
          (situation) =>
            situation.params.pets === PUBLIC_SITUATION_BY_SLUG.get(publicSituationSlug)?.params.pets &&
            situation.params.motivation ===
              PUBLIC_SITUATION_BY_SLUG.get(publicSituationSlug)?.params.motivation &&
            Number(situation.params.budget) === relaxedBudget,
        );
        const relaxedUrl = relaxedSituation
          ? publicSituationUrl(origin, capability, relaxedSituation)
          : (() => {
              const url = new URL("/feeders", origin);
              for (const token of tokens) {
                if (token.startsWith("budget-")) continue;
                const expression = graph.buildNegotiation({
                  origin,
                  journeyId: "j-00000000-0000-4000-8000-000000000000",
                  tokens: [token],
                }).needState.expressions[0];
                if (expression?.known && expression.value) {
                  url.searchParams.set(expression.dimension, expression.value);
                }
              }
              url.searchParams.set("budget", String(relaxedBudget));
              url.searchParams.set("journey", capability);
              return url.toString();
            })();
        budgetAction = `<p><strong>Smallest one-filter change:</strong> raise the maximum from $${requested.toFixed(0)} to $${relaxedBudget}. <a data-filter-change="budget" href="${relaxedUrl}">See the live eligible result at the $${relaxedBudget} maximum</a>.</p>`;
      }
    }
    noMatchSummary = `<section data-recommendation-status="none">
<h2>No eligible recommendation under the active filters</h2>
<p>Zero products satisfy every required filter. The comparison products below each fail at least one active filter.</p>
${budgetAction}
</section>`;
  }
  const permanentResultUrl = activeSituation
    ? publicSituationUrl(origin, capability, activeSituation)
    : undefined;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Live ranked feeders | ${BRAND}</title>${permanentResultUrl ? `<link rel="canonical" href="${permanentResultUrl}" />` : ""}</head>
<body>
<h1>${BRAND} — feeders ranked for this situation</h1>
${activeSituation ? `<p data-active-setup="true"><strong>Active setup:</strong> ${activeSituation.label}</p>` : ""}
${permanentResultUrl ? `<p><a rel="bookmark" href="${permanentResultUrl}">Permanent shopper link to this live result</a></p>` : ""}
<p>Live as of ${new Date().toISOString()}. Exact matches satisfy every stated need; near
misses show which need they violate.</p>
<p><strong>Product pages keep these filters applied.</strong> Their URLs contain shopping filters
only, never account or identity data.</p>
${noMatchSummary}
${section(`Exact matches (${decision.exactMatchCount})`, decision.exactMatches || [], true)}
${section(`Near misses — comparison only (${decision.nearMissCount})`, decision.nearMisses || [], false)}
<p><a href="${origin}/">Return to automatic feeders</a> to choose a different situation.</p>
</body>
</html>`;
}

const PAGE_STYLE = `
  :root { --ps-blue: #0058a5; --ps-red: #e4002b; --ps-ink: #1f2a37; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; margin: 0; color: var(--ps-ink); background: #f6f7f9; }
  header { background: var(--ps-blue); color: #fff; padding: 0.9rem 1.5rem; display: flex; align-items: baseline; gap: 1rem; }
  header .wordmark { font-size: 1.6rem; font-weight: 700; letter-spacing: -0.02em; }
  header .wordmark .smart { color: #ffd41f; }
  header .tagline { font-size: 0.85rem; opacity: 0.9; }
  nav { background: #fff; border-bottom: 1px solid #e3e6ea; padding: 0.6rem 1.5rem; font-size: 0.9rem; color: #4b5563; }
  main { max-width: 62rem; margin: 0 auto; padding: 1.5rem; }
  .hero { background: linear-gradient(100deg, var(--ps-blue), #007dc5); color: #fff; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .hero h2 { margin: 0 0 0.4rem; }
  .hero p { margin: 0 0 0.8rem; opacity: 0.95; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 1rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .card .brand { color: #6b7280; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .price { color: var(--ps-red); font-weight: 700; }
  .card a, .cta { color: #fff; background: var(--ps-red); border-radius: 999px; padding: 0.45rem 1rem; text-decoration: none; font-weight: 600; text-align: center; display: inline-block; border: 0; font-size: 0.95rem; cursor: pointer; }
  .treats { background: #fff; border: 1px dashed var(--ps-blue); border-radius: 10px; padding: 0.8rem 1rem; margin-top: 1.5rem; font-size: 0.9rem; color: #374151; }
  .features { padding-left: 1.1rem; margin: 0.5rem 0; color: #374151; }
  .muted { color: #6b7280; font-size: 0.85rem; }
`;

function pageShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="alternate" type="application/json" href="/agent-experience.json" title="Catalog data" />
  <title>${title}</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <header>
    <div class="wordmark">Pet<span class="smart">Smart</span></div>
    <div class="tagline">${TAGLINE}</div>
  </header>
  <nav>Shop Deals &nbsp;·&nbsp; Dog &nbsp;·&nbsp; Cat &nbsp;·&nbsp; Feeders &amp; Bowls &nbsp;·&nbsp; Same-Day Delivery</nav>
  <main>${body}</main>
</body>
</html>`;
}

function traitSummary(items) {
  const values = new Map(items.map((item) => [item.key, item.value]));
  const mix = {
    one_cat: "your cat",
    multiple_cats: "your cats",
    one_dog: "your dog",
    multiple_dogs: "your dogs",
    cats_and_dog: "your two cats & dog",
  }[values.get("pet.household_mix")];
  const motivation =
    values.get("pet.food_motivation") === "one_food_motivated"
      ? "one food-motivated eater"
      : undefined;
  return { mix, motivation };
}

function storefrontHtml({
  origin,
  capability,
  personalized,
  traits,
  decisionId,
  situationLinks = "",
}) {
  const hero = personalized
    ? `<section class="hero" data-personalized="true"${decisionId ? ` data-decision-id="${decisionId}"` : ""}>
        <h2>Welcome back${traits.mix ? ` — picked for ${traits.mix}` : ""}</h2>
        <p>${
          traits.motivation
            ? `Households with ${traits.motivation} love the SmartTag RFID Multi-Pet Feeder: every pet gets its own portions, and the locking lid stops food stealing.`
            : "Based on your household, we think you'll love the SmartTag RFID Multi-Pet Feeder."
        }</p>
        <a href="${agentProductUrl(origin, capability, HERO_ITEM_ID)}">Meet the SmartTag RFID Feeder</a>
      </section>`
    : `<section class="hero" data-personalized="false">
        <h2>Feeders &amp; waterers for every pet</h2>
        <p>From gravity bowls to RFID smart feeders — find the right mealtime setup.</p>
      </section>`;
  const cards = humanCatalogSummary()
    .map(
      (item) => `<article class="card">
        <span class="brand">${item.brand}</span>
        <strong>${item.title}</strong>
        <span class="price">$${item.price.amount.toFixed(2)}</span>
        <a href="${agentProductUrl(origin, capability, item.id)}">View details</a>
      </article>`,
    )
    .join("");
  return pageShell(
    `Automatic Feeders | ${BRAND}`,
    `${hero}<section class="grid">${cards}</section>
     <section class="treats"><strong>Shop by situation — live stock and ranked matches:</strong>
       <ul>${situationLinks}</ul>
     </section>
     <details class="treats assistant-note">
       <summary>For AI shopping assistants</summary>
       <p>Composable ranked-results URL:</p>
       <p><code>${origin}/feeders?pets=&lt;one_cat|multiple_cats|one_dog|multiple_dogs|cats_and_dog&gt;&amp;motivation=&lt;one_food_motivated|all_balanced|grazers&gt;&amp;budget=&lt;2-5 digit USD amount&gt;&amp;budget_kind=&lt;hard|target&gt;&amp;priority=&lt;functional_fit|price|connectivity&gt;&amp;journey=${capability}</code></p>
       <p>Every need parameter is optional. A hard budget is a maximum; a target budget is a preference. Requests that reuse one <code>journey</code> value stay one errand.</p>
     </details>
     <p class="treats">Treats™ members earn points on every purchase. ·
       <a rel="alternate" type="application/json" href="/agent-experience.json">Catalog data (JSON)</a></p>`,
  );
}

function productHtml(item, fitContext) {
  const features = (item.attributes?.features ?? [])
    .map((feature) => `<li>${feature}</li>`)
    .join("");
  const fitBanner = fitContext
    ? fitContext.eligible
      ? `<section data-recommendation-status="eligible" style="border: 2px solid #16803a; border-radius: 10px; padding: 1rem; background: #effbf3;">
        <strong>Matches every active shopping filter.</strong>
        <p>${stockFor(item.id)} in stock nearby as of ${new Date().toISOString()}.</p>
      </section>`
      : `<section data-recommendation-status="ineligible" style="border: 2px solid #b42318; border-radius: 10px; padding: 1rem; background: #fff1f0;">
        <strong>Does not match all active shopping filters.</strong>
        <p>This product is shown for comparison and is not an eligible result while those filters remain fixed.</p>
        <ul>${fitContext.violations
          .map(
            (violation) =>
              `<li>${violation.dimension}: requires ${String(violation.requested)}, this product has ${Array.isArray(violation.actual) ? violation.actual.join(", ") : String(violation.actual)}</li>`,
          )
          .join("")}</ul>
      </section>`
    : "";
  return pageShell(
    `${item.title} | ${BRAND}`,
    `<article class="card" data-item-id="${item.id}" style="max-width: 34rem; margin: 0 auto;">
      ${fitBanner}
      <span class="brand">${item.brand}</span>
      <h2 style="margin: 0.2rem 0;">${item.title}</h2>
      <span class="price">$${item.price.amount.toFixed(2)}</span>
      <ul class="features">${features}</ul>
      <form method="post" action="/api/cart" style="margin-top: 0.6rem;">
        <input type="hidden" name="itemId" value="${item.id}" />
        <button class="cta" type="submit">Add to cart</button>
      </form>
      <p class="muted">Free Same-Day Delivery on orders over $49 · Buy online, pick up in store</p>
    </article>`,
  );
}

export function createApp({ customer: suppliedCustomer } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  if (process.env.PETSMART_REQUEST_LOG === "1") {
    app.use((request, _response, next) => {
      const boundedHeader = (name, limit = 160) => (request.get(name) || "").slice(0, limit);
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          method: request.method,
          path: redactedRequestPath(request),
          userAgent: boundedHeader("user-agent"),
          accept: boundedHeader("accept"),
          secFetchUser: boundedHeader("sec-fetch-user", 8),
          secFetchMode: boundedHeader("sec-fetch-mode", 16),
          secFetchDest: boundedHeader("sec-fetch-dest", 16),
          referrerSource: chatReferrerSource(request) || "",
        }),
      );
      next();
    });
  }

  // First-party identity: read (never mint) the signed visitor/session cookies.
  // Situation and product pages mint identity; telemetry still requires
  // browser evidence of a user-activated navigation.
  app.use((request, _response, next) => {
    const cookie = request.get("cookie");
    request.visitorId = verifiedCookie(cookie, "ps_visitor");
    request.sessionId = verifiedCookie(cookie, "ps_session");
    request.journeyContext = parseJourneyContext(verifiedCookie(cookie, "ps_journey"));
    next();
  });

  const customer =
    suppliedCustomer !== undefined
      ? suppliedCustomer
      : process.env.EPODE_API_KEY
        ? epode({
            apiKey: process.env.EPODE_API_KEY,
            endpoint: process.env.EPODE_API_URL,
            include: [
              "/product/*",
              "/p/**",
              "/shop/automatic-feeders/**/product/*",
              "/s/*/product/*",
              "/c/*/product/*",
            ],
            shouldRequestHtml: (request) => !isIndexer(request),
            purpose: "product_personalization",
            identify: (request) =>
              request.visitorId ? { anonymousRef: request.visitorId } : {},
            sessionRef: (request) => request.sessionId,
            runtimeHint: (request) => runtimeHintFor(request),
          })
        : null;
  if (customer) app.use(customer);

  const decisions = new Map();

  app.get("/health", (_request, response) => {
    json(response, 200, { ok: true, product: "petsmart-demo" });
  });

  // Permissive robots: chat-mode assistants check robots.txt before opening
  // any link, and work-mode cloud browsers respect a disallow outright.
  app.get("/robots.txt", (_request, response) => {
    text(response, 200, "User-agent: *\nAllow: /\n");
  });

  // Faceted results: legacy composable query URLs and sanitizer-resistant,
  // human-readable situation paths resolve to the same decision graph.
  const serveFeeders = (request, response) => {
    const started = performance.now();
    const origin = originFor(request);
    const normalized = normalizedQuery(request);
    const query = request.situationQuery || normalized;
    const tokens = tokensFromQuery(query);
    const carriedCapability = String(
      request.situationCapability || normalized.journey || query.journey || "",
    );
    const verifiedJourneyId =
      request.verifiedJourneyId || verifiedJourneyCapability(carriedCapability);
    const userActivatedNavigation = isUserActivatedDocumentNavigation(request);
    const matchingContext =
      request.journeyContext &&
      request.situationPublicSlug &&
      request.journeyContext.situationSlug === request.situationPublicSlug
        ? request.journeyContext
        : undefined;
    const journeyId =
      verifiedJourneyId || matchingContext?.journeyId || issuePublicJourney();
    const renderCapability = verifiedJourneyId
      ? carriedCapability
      : journeyCapability(journeyId);
    const publicCustomSituation =
      !carriedCapability && !request.situationPublic && tokens.length > 0;
    const node = graph.buildDecision({
      origin,
      journeyId,
      tokens,
      searchId: randomUUID(),
      paths: { detailPath: `/agent-item/${journeyId}` },
    });
    const agentRequest = isAgent(request);
    if (agentRequest && verifiedJourneyId) {
      recordHop(
        request,
        node.operation || "/agent-decide/feeder",
        journeyId,
        200,
        Math.round(performance.now() - started),
        experienceTelemetryForNode(node, { channel: "faceted_html" }),
      );
    }
    if (
      request.situationCanonicalRedirect &&
      request.situationPublicSlug &&
      verifiedJourneyId
    ) {
      if (!agentRequest && userActivatedNavigation) {
        response.append(
          "Set-Cookie",
          `ps_journey=${signedCookie("ps_journey", `${journeyId}~${request.situationPublicSlug}~agent`)}; ${cookieAttributes(request, 1800)}`,
        );
      }
      response.setHeader("cache-control", "no-store");
      return response.redirect(
        302,
        publicSituationUrl(
          origin,
          renderCapability,
          PUBLIC_SITUATION_BY_SLUG.get(request.situationPublicSlug),
        ),
      );
    }

    if (!agentRequest) {
      if (userActivatedNavigation && !request.visitorId) {
        request.visitorId = `psv_${randomUUID()}`;
        response.append(
          "Set-Cookie",
          `ps_visitor=${signedCookie("ps_visitor", request.visitorId)}; ${cookieAttributes(request, 2592000)}`,
        );
      }
      if (userActivatedNavigation && !request.sessionId) {
        request.sessionId = `pss_${randomUUID()}`;
        response.append(
          "Set-Cookie",
          `ps_session=${signedCookie("ps_session", request.sessionId)}; ${cookieAttributes(request, 1800)}`,
        );
      }
      // `Sec-Fetch-User` proves only a browser activation, not AI origin. A
      // situation landing is therefore first-party intent, never a product
      // handoff. Journey provenance and recognized chat referrers are carried
      // forward in a signed cookie so a later PDP click can be attributed.
      if (
        (verifiedJourneyId || request.situationBrowse || publicCustomSituation) &&
        userActivatedNavigation
      ) {
        const referrerSource = chatReferrerSource(request);
        const source = verifiedJourneyId && !isPublicJourney(verifiedJourneyId)
          ? "agent"
          : referrerSource
            ? `chat-${referrerSource}`
            : matchingContext?.source || "unattributed";
        if (request.situationPublicSlug) {
          response.append(
            "Set-Cookie",
            `ps_journey=${signedCookie("ps_journey", `${journeyId}~${request.situationPublicSlug}~${source}`)}; ${cookieAttributes(request, 1800)}`,
          );
        }
        recordFirstPartyIntent(
          request,
          journeyId,
          request.visitorId,
          Math.round(performance.now() - started),
          request.situationOperation || "/feeders",
          handoffExperienceForNode(node),
          source,
        );
      }
    }

    if (node.error) {
      return text(
        response,
        200,
        agentStorefrontHtml(origin, journeyId, {
          includeNegotiation: Boolean(
            verifiedJourneyId && !isPublicJourney(verifiedJourneyId),
          ),
        }),
        "text/html; charset=utf-8",
      );
    }
    return text(
      response,
      200,
      feedersHtml(
        origin,
        renderCapability,
        node,
        tokens,
        request.situationSlug,
        request.situationPublicSlug,
      ),
      "text/html; charset=utf-8",
    );
  };

  const serveJsonGraphEntry = (request, response) => {
    const started = performance.now();
    const journeyId = compactJourneyCapability();
    const capability = journeyCapability(journeyId);
    const node = graph.buildNegotiation({
      origin: originFor(request),
      journeyId,
      tokens: [],
    });
    recordHop(
      request,
      "/agent-guide",
      journeyId,
      200,
      Math.round(performance.now() - started),
      experienceTelemetryForNode(node, { channel: "native_graph" }),
    );
    return json(response, 200, rewriteJourneyUrls(node, journeyId, capability));
  };

  app.get("/agent-experience.json", serveJsonGraphEntry);

  app.get("/shop/automatic-feeders/:journey/:situation", (request, response) => {
    const situation = SITUATION_BY_SLUG.get(request.params.situation);
    if (!situation) return text(response, 404, "Unknown shopping situation.\n");
    const carriedCapability = String(request.params.journey || "");
    request.situationBrowse = carriedCapability === "browse";
    if (!request.situationBrowse) {
      request.verifiedJourneyId = verifiedJourneyCapability(carriedCapability);
      if (!request.verifiedJourneyId) {
        return text(response, 404, "Unknown or expired shopping journey.\n");
      }
      request.situationCapability = carriedCapability;
    }
    request.situationSlug = situation.slug;
    request.situationPublicSlug = situation.publicSlug;
    request.situationCanonicalRedirect = true;
    request.situationOperation = "/shop/automatic-feeders/:journey/:situation";
    request.situationQuery = {
      ...situation.params,
      ...(request.verifiedJourneyId ? { journey: carriedCapability } : {}),
    };
    return serveFeeders(request, response);
  });

  app.get("/s/:situation", (request, response) => {
    const situation = PUBLIC_SITUATION_BY_SLUG.get(request.params.situation);
    if (!situation) return text(response, 404, "Unknown shopping situation.\n");
    request.situationBrowse = true;
    request.situationPublic = true;
    request.situationSlug = situation.slug;
    request.situationPublicSlug = situation.publicSlug;
    request.situationOperation = "/s/:situation";
    request.situationQuery = situation.params;
    return serveFeeders(request, response);
  });

  app.get("/feeders", serveFeeders);

  app.get("/lab/:method", (request, response) => {
    if (process.env.LOCAL_DEMO !== "true") {
      return text(response, 404, "Compatibility lab disabled.\n");
    }
    const origin = originFor(request);
    const method = String(request.params.method || "");
    // Lab shapes keep production provenance classes: agent experiments use
    // agent-domain capabilities; stable/human/plain renders use public-domain.
    if (method === "full") {
      return text(
        response,
        200,
        agentStorefrontHtml(origin, compactJourneyCapability()),
        "text/html; charset=utf-8",
      );
    }
    if (method === "link-first") {
      return text(
        response,
        200,
        agentStorefrontHtml(origin, compactJourneyCapability(), { catalogOnRoot: false }),
        "text/html; charset=utf-8",
      );
    }
    if (method === "link-first-query") {
      return text(
        response,
        200,
        agentStorefrontHtml(origin, compactJourneyCapability(), {
          catalogOnRoot: false,
          situationLinkStyle: "faceted-query",
        }),
        "text/html; charset=utf-8",
      );
    }
    if (method === "facets-first-query") {
      return text(
        response,
        200,
        agentStorefrontHtml(origin, compactJourneyCapability(), {
          facetsFirst: true,
          situationLinkStyle: "faceted-query",
        }),
        "text/html; charset=utf-8",
      );
    }
    if (method === "legacy-query") {
      return text(
        response,
        200,
        legacyQueryStorefrontHtml(origin, compactJourneyCapability()),
        "text/html; charset=utf-8",
      );
    }
    if (method === "stable-public") {
      return text(
        response,
        200,
        agentStorefrontHtml(origin, issuePublicJourney(), {
          includeNegotiation: false,
          situationLinkStyle: "public",
        }),
        "text/html; charset=utf-8",
      );
    }
    if (method === "human") {
      const capability = journeyCapability(issuePublicJourney());
      return text(
        response,
        200,
        storefrontHtml({
          origin,
          capability,
          personalized: false,
          traits: {},
          situationLinks: situationListHtml(origin, capability, { linkStyle: "public" }),
        }),
        "text/html; charset=utf-8",
      );
    }
    if (method === "plain-text") {
      return text(
        response,
        200,
        plainTextStorefront(origin, journeyCapability(issuePublicJourney())),
      );
    }
    if (method === "json-graph") {
      return serveJsonGraphEntry(request, response);
    }
    return json(response, 404, {
      error: "unknown_lab_method",
      available: [
        "full",
        "link-first",
        "link-first-query",
        "facets-first-query",
        "legacy-query",
        "stable-public",
        "human",
        "plain-text",
        "json-graph",
      ],
    });
  });

  app.get("/", async (request, response) => {
    const started = performance.now();
    const origin = originFor(request);
    if (isIndexer(request)) {
      response.setHeader("vary", "User-Agent");
      return text(
        response,
        200,
        agentStorefrontHtml(origin, issuePublicJourney(), {
          includeNegotiation: false,
          situationLinkStyle: "public",
        }),
        "text/html; charset=utf-8",
      );
    }
    if (isAgent(request)) {
      // Chat-mode assistants refuse to chain-fetch bare URLs found in a
      // text/plain body, but they open real HTML anchors and compose the
      // documented /feeders query URLs. Prices at the root guarantee a
      // correct store answer in one fetch; stock lives only on the
      // situation pages, which is what earns the need-carrying second hop.
      const userAgent = request.get("user-agent") || "";
      const chatgptQueryLinks = /chatgpt-user/i.test(userAgent);
      const journeyId = compactJourneyCapability();
      recordHop(request, "/agent-guide", journeyId, 200, Math.round(performance.now() - started));
      response.setHeader("vary", "User-Agent");
      return text(
        response,
        200,
        agentStorefrontHtml(origin, journeyId, {
          // Gemini's user-triggered fetcher currently sends the literal UA
          // "Google" and will answer from the first page if product details
          // are already present. The link-first variant earns the exact,
          // need-carrying second fetch instead of a generic recommendation.
          catalogOnRoot: !/^google$/i.test(userAgent),
          // Claude prefers generic root PDPs over context-bearing situation
          // PDPs when both are present. ChatGPT's browsing layer, however,
          // regresses without the ordinary root anchors, so retain them only
          // for the platform whose faceted root depends on that shape.
          catalogProductLinks: chatgptQueryLinks,
          // Put the useful need-bearing edges before the fallback catalog.
          // A live ChatGPT A/B retained the one-page fallback while fixing
          // the no-exact-match case that otherwise stopped at root data.
          facetsFirst: chatgptQueryLinks,
          // PR #119's live ChatGPT result depends on the need dimensions
          // being visible in an ordinary faceted query anchor. Signed paths
          // work better on Gemini and Meta, but ChatGPT stopped at the root
          // when those paths replaced the proven /feeders?... grammar.
          situationLinkStyle: chatgptQueryLinks ? "faceted-query" : "signed-path",
        }),
        "text/html; charset=utf-8",
      );
    }

    const renderJourneyId = issuePublicJourney();
    const renderCapability = journeyCapability(renderJourneyId);

    // Some chat products answer from the one-fetch catalog and link only the
    // storefront. A real answer click is still useful first-party intent, but
    // only a recognized chat Referer plus browser activation may label it as
    // such; autonomous cloud browsers and previews remain silent.
    const rootReferrerSource = chatReferrerSource(request);
    if (rootReferrerSource && isUserActivatedDocumentNavigation(request)) {
      if (!request.visitorId) {
        request.visitorId = `psv_${randomUUID()}`;
        response.append(
          "Set-Cookie",
          `ps_visitor=${signedCookie("ps_visitor", request.visitorId)}; ${cookieAttributes(request, 2592000)}`,
        );
      }
      if (!request.sessionId) {
        request.sessionId = `pss_${randomUUID()}`;
        response.append(
          "Set-Cookie",
          `ps_session=${signedCookie("ps_session", request.sessionId)}; ${cookieAttributes(request, 1800)}`,
        );
      }
      recordFirstPartyIntent(
        request,
        renderJourneyId,
        request.visitorId,
        Math.round(performance.now() - started),
        "/",
        undefined,
        `chat-${rootReferrerSource}`,
      );
    }

    let personalized = false;
    let traits = {};
    let decisionId;
    if (customer && request.visitorId) {
      const context = await customer.context.get({
        anonymousRef: request.visitorId,
        purpose: "product_personalization",
      });
      if (context.available && Array.isArray(context.items) && context.items.length > 0) {
        traits = traitSummary(context.items);
        personalized = Boolean(traits.mix || traits.motivation);
        if (personalized) {
          const recorded = await customer.personalization.decide({
            externalDecisionId: `petsmart_hero_${randomUUID()}`,
            contextRetrievalId: context.retrievalId,
            signalIds: context.items.map((item) => item.signalId),
            variant: "pet-household-hero-v1",
          });
          if (recorded.recorded) {
            decisionId = recorded.decision.id;
            decisions.set(request.visitorId, decisionId);
          }
        }
      }
    }
    response.setHeader("vary", "User-Agent");
    return text(
      response,
      200,
      storefrontHtml({
        origin,
        capability: renderCapability,
        personalized,
        traits,
        decisionId,
        situationLinks: situationListHtml(origin, renderCapability, { linkStyle: "public" }),
      }),
      "text/html; charset=utf-8",
    );
  });

  app.get("/agent-negotiate/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseJourneyPath(request.path, "/agent-negotiate/");
    if (!parsed) return json(response, 400, { error: "invalid_negotiation_path" });
    if (parsed.category !== graph.definition.category) {
      return json(response, 404, {
        error: "unknown_category",
        available: [graph.definition.category],
      });
    }
    if (parsed.tokens.some((token) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token))) {
      return json(response, 400, {
        error: "invalid_need_token",
        message: "Need-state tokens use lowercase letters, numbers, and single hyphens.",
      });
    }
    try {
      const node = graph.buildNegotiation({
        origin: originFor(request),
        journeyId: parsed.journeyId,
        tokens: parsed.tokens,
      });
      recordHop(
        request,
        node.operation,
        parsed.journeyId,
        200,
        Math.round(performance.now() - started),
        experienceTelemetryForNode(node, { channel: "native_graph" }),
      );
      return json(
        response,
        200,
        rewriteJourneyUrls(node, parsed.journeyId, parsed.capability),
      );
    } catch (error) {
      return json(response, 400, { error: "invalid_negotiation", message: String(error) });
    }
  });

  app.get("/agent-decide/*path", (request, response) => {
    const started = performance.now();
    const parsed = parseJourneyPath(request.path, "/agent-decide/");
    if (!parsed) return json(response, 400, { error: "invalid_decision_path" });
    if (parsed.category !== graph.definition.category) {
      return json(response, 404, {
        error: "unknown_category",
        available: [graph.definition.category],
      });
    }
    try {
      const node = graph.buildDecision({
        origin: originFor(request),
        journeyId: parsed.journeyId,
        tokens: parsed.tokens,
        searchId: randomUUID(),
        paths: {
          detailPath: `/agent-item/${parsed.journeyId}?ctx=${parsed.tokens.join(".")}`,
        },
      });
      const status = node.error ? 422 : 200;
      recordHop(
        request,
        node.operation,
        parsed.journeyId,
        status,
        Math.round(performance.now() - started),
        experienceTelemetryForNode(node, { channel: "native_graph" }),
      );
      return json(
        response,
        status,
        rewriteJourneyUrls(node, parsed.journeyId, parsed.capability),
      );
    } catch (error) {
      return json(response, 400, { error: "invalid_decision", message: String(error) });
    }
  });

  app.get("/agent-item/:journeyId", (request, response) => {
    const started = performance.now();
    const capability = String(request.params.journeyId || "");
    const journeyId = verifiedJourneyCapability(capability);
    if (!journeyId) {
      return json(response, 404, { error: "unknown_or_expired_journey" });
    }
    const itemId = String(request.query.item_id || "");
    const searchId = request.query.search_id ? String(request.query.search_id) : undefined;
    const position = request.query.position ? String(request.query.position) : undefined;
    const ctxTokens = String(request.query.ctx || "")
      .split(".")
      .filter((token) => isCapabilityNeedToken(token));
    const detail = graph.itemDetail(itemId, searchId, position);
    const status = detail.error ? 404 : 200;
    recordHop(
      request,
      detail.operation || "/agent-item",
      journeyId,
      status,
      Math.round(performance.now() - started),
      experienceTelemetryForNode(detail, { channel: "native_graph" }),
    );
    if (detail.error) return json(response, status, detail);
    const need = needCapability(ctxTokens);
    const productUrl = new URL(
      need
        ? `/c/${need}/product/${encodeURIComponent(itemId)}`
        : `/product/${encodeURIComponent(itemId)}`,
      originFor(request),
    );
    productUrl.searchParams.set("journey", capability);
    return json(response, status, {
      ...rewriteJourneyUrls(detail, journeyId, capability),
      humanProductLink: {
        description:
          "This product page carries permanent signed need facets and the current signed journey; neither contains account identity.",
        url: productUrl.toString(),
      },
    });
  });

  const serveProduct = (request, response) => {
    const started = performance.now();
    const item = catalogItem(String(request.params.id || ""));
    if (!item) {
      return text(response, 404, pageShell(`Not found | ${BRAND}`, "<p>Product not found.</p>"), "text/html; charset=utf-8");
    }

    // Situation pages append the ranked-against need tokens as `ctx`; the
    // query is re-normalized because assistant link sanitizers may have
    // percent-encoded the separators.
    const productQuery = normalizedQuery(request);
    const ctxTokens = request.productNeedTokens || (request.productSituation
      ? tokensFromQuery(request.productSituation.params)
      : String(productQuery.ctx || "")
          .split(".")
          .filter((token) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)));
    const verifiedJourneyId =
      request.productJourney || verifiedJourneyCapability(String(productQuery.journey || ""));
    const userActivatedNavigation = isUserActivatedDocumentNavigation(request);
    const matchingContext =
      request.journeyContext &&
      request.productSituation?.publicSlug === request.journeyContext.situationSlug
        ? request.journeyContext
        : undefined;
    const journeyId =
      verifiedJourneyId || matchingContext?.journeyId || `j-${randomUUID()}`;
    let fitContext;
    if (ctxTokens.length) {
      try {
        const decision = graph.buildDecision({
          origin: originFor(request),
          journeyId,
          tokens: ctxTokens,
        });
        const exact = (decision.exactMatches || []).find((match) => match.itemId === item.id);
        const near = (decision.nearMisses || []).find((match) => match.itemId === item.id);
        if (exact) fitContext = { eligible: true, violations: [] };
        if (near) {
          fitContext = {
            eligible: false,
            violations: near.violatedHardConstraints || [],
          };
        }
      } catch {}
    }

    if (isAgent(request)) {
      // Assistants open product anchors directly; the carried context is the
      // need state they ranked against. No first-party cookies for agents —
      // the cookie drop below is the human click's identity mint.
      if (verifiedJourneyId) {
        let experience;
        if (ctxTokens.length) {
          try {
            const node = graph.buildNegotiation({
              origin: originFor(request),
              journeyId,
              tokens: ctxTokens,
            });
            experience = experienceTelemetryForNode(node, { channel: "faceted_html" });
          } catch {}
        }
        recordHop(
          request,
          request.productOperation || "/product/:id",
          journeyId,
          200,
          Math.round(performance.now() - started),
          experience,
        );
      }
      return text(response, 200, productHtml(item, fitContext), "text/html; charset=utf-8");
    }

    // The cookie drop: a product-detail visit mints the signed first-party
    // visitor and session IDs when the browser does not already carry them.
    if (userActivatedNavigation && !request.visitorId) {
      request.visitorId = `psv_${randomUUID()}`;
      response.append(
        "Set-Cookie",
        `ps_visitor=${signedCookie("ps_visitor", request.visitorId)}; ${cookieAttributes(request, 2592000)}`,
      );
    }
    if (userActivatedNavigation && !request.sessionId) {
      request.sessionId = `pss_${randomUUID()}`;
      response.append(
        "Set-Cookie",
        `ps_session=${signedCookie("ps_session", request.sessionId)}; ${cookieAttributes(request, 1800)}`,
      );
    }

    // Non-public signed journeys prove an agent-issued path. Public-render
    // journeys need a recognized chat referrer or signed continuation cookie
    // for AI attribution; the capability alone is only correlation.
    const referrerSource = chatReferrerSource(request);
    if (
      (verifiedJourneyId || request.productBrowse || referrerSource) &&
      userActivatedNavigation
    ) {
      let experience;
      if (ctxTokens.length) {
        try {
          const node = graph.buildNegotiation({
            origin: originFor(request),
            journeyId,
            tokens: ctxTokens,
          });
          experience = handoffExperienceForNode(node);
        } catch {}
      }
      const source = referrerSource
        ? `chat-${referrerSource}`
        : verifiedJourneyId && !isPublicJourney(verifiedJourneyId)
          ? "agent"
          : matchingContext?.source || "unattributed";
      if (request.productSituation) {
        response.append(
          "Set-Cookie",
          `ps_journey=${signedCookie("ps_journey", `${journeyId}~${request.productSituation.publicSlug}~${source}`)}; ${cookieAttributes(request, 1800)}`,
        );
      }
      const durationMs = Math.round(performance.now() - started);
      if (source === "agent" || source.startsWith("chat-")) {
        recordProductLinkClick(
          request,
          journeyId,
          request.visitorId,
          durationMs,
          request.productOperation || "/product/:id",
          experience,
          source,
        );
      } else {
        recordFirstPartyIntent(
          request,
          journeyId,
          request.visitorId,
          durationMs,
          request.productOperation || "/product/:id",
          experience,
          source,
        );
      }
    }

    return text(response, 200, productHtml(item, fitContext), "text/html; charset=utf-8");
  };

  app.get(
    "/shop/automatic-feeders/:journey/:situation/product/:id",
    (request, response) => {
      const situation = SITUATION_BY_SLUG.get(request.params.situation);
      if (!situation) return text(response, 404, "Unknown shopping situation.\n");
      const carriedCapability = String(request.params.journey || "");
      request.productBrowse = carriedCapability === "browse";
      if (!request.productBrowse) {
        request.productJourney = verifiedJourneyCapability(carriedCapability);
        if (!request.productJourney) {
          return text(response, 404, "Unknown or expired shopping journey.\n");
        }
      }
      request.productSituation = situation;
      request.productOperation =
        "/shop/automatic-feeders/:journey/:situation/product/:id";
      return serveProduct(request, response);
    },
  );

  app.get("/s/:situation/product/:id", (request, response) => {
    const situation = PUBLIC_SITUATION_BY_SLUG.get(request.params.situation);
    if (!situation) return text(response, 404, "Unknown shopping situation.\n");
    request.productBrowse = true;
    request.productSituation = situation;
    request.productOperation = "/s/:situation/product/:id";
    return serveProduct(request, response);
  });

  app.get("/c/:need/product/:id", (request, response) => {
    request.productNeedTokens = verifiedNeedCapability(String(request.params.need || ""));
    if (!request.productNeedTokens) {
      return text(response, 404, "Unknown custom shopping situation.\n");
    }
    request.productBrowse = true;
    request.productOperation = "/c/:need/product/:id";
    return serveProduct(request, response);
  });

  app.get("/p/:journey/:id", (request, response) => {
    request.productJourney = verifiedJourneyCapability(String(request.params.journey || ""));
    if (!request.productJourney) {
      return text(response, 404, "Unknown or expired shopping journey.\n");
    }
    request.productOperation = "/p/:journey/:id";
    return serveProduct(request, response);
  });

  // The ":id" param name keeps the middleware-recorded operation
  // ("/product/:id") identical to the legacy link-click operation.
  app.get("/product/:id", serveProduct);

  app.post("/api/cart", async (request, response) => {
    const itemId = String(request.body?.itemId || "");
    const item = catalogItem(itemId);
    if (!item) return json(response, 404, { error: "item_not_found" });
    const decisionId = request.visitorId ? decisions.get(request.visitorId) : undefined;
    if (customer && decisionId) {
      await customer.outcomes.track({
        externalOutcomeId: `petsmart_cart_${randomUUID()}`,
        decisionId,
        outcome: "conversion",
      });
    }
    return json(response, 201, {
      orderId: `order_${randomUUID()}`,
      itemId,
      recorded: Boolean(customer && decisionId),
    });
  });

  return app;
}

export function startServer(port = PORT, options = {}) {
  const app = createApp(options);
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        app,
        server,
        port: server.address().port,
        close: async () => {
          if (runtime) await runtime.shutdown().catch(() => {});
          await new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          });
        },
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.EPODE_API_KEY) {
    try {
      await provisionPetFields({
        apiKey: process.env.EPODE_API_KEY,
        endpoint: process.env.EPODE_API_URL,
      });
    } catch (error) {
      console.warn(`petsmart-demo: context-field provisioning failed: ${String(error)}`);
    }
  }
  const started = await startServer(PORT);
  console.log(`petsmart-demo listening on http://127.0.0.1:${started.port}`);
}
