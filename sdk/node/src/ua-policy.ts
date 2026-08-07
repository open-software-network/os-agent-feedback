/**
 * Two-class User-Agent routing policy for product surfaces.
 *
 * Only documented fetch-time agent UAs route to the agent surface. Indexers,
 * browsers, unknown clients, and anonymous or masquerading agents such as
 * Grok, DeepSeek, and MS Copilot Actions route to the human surface by design.
 * Never synthesize agent identity from UA resemblance, IP, timing, or other
 * heuristics.
 */

export type AgentVendorFamily =
  | "claude-user"
  | "chatgpt-user"
  | "perplexity-user"
  | "cohere-ai"
  | "gemini-agent"
  | "gemini-user"
  | "meta-ai-user"
  | "moonshot-ai"
  | "mistral-ai"
  | "duckassist";

type UserAgentMatch = "contains" | "exact";

export interface RoutableAgentUaEntry {
  readonly vendorFamily: AgentVendorFamily;
  readonly match: UserAgentMatch;
  readonly tokens: readonly string[];
}

export interface IndexerUaEntry {
  readonly match: UserAgentMatch;
  readonly tokens: readonly string[];
}

export const ROUTABLE_AGENT_UA_ROSTER = [
  {
    vendorFamily: "claude-user",
    match: "contains",
    tokens: ["claude-user", "anthropic-ai"],
  },
  { vendorFamily: "chatgpt-user", match: "contains", tokens: ["chatgpt-user"] },
  {
    vendorFamily: "perplexity-user",
    match: "contains",
    tokens: ["perplexity-user"],
  },
  { vendorFamily: "cohere-ai", match: "contains", tokens: ["cohere-ai"] },
  { vendorFamily: "gemini-agent", match: "contains", tokens: ["gemini-agent"] },
  { vendorFamily: "gemini-user", match: "exact", tokens: ["google"] },
  {
    vendorFamily: "meta-ai-user",
    match: "contains",
    tokens: ["meta-externalfetcher"],
  },
  {
    vendorFamily: "moonshot-ai",
    match: "contains",
    tokens: ["kimibot", "moonshotbot", "kimicrawler"],
  },
  { vendorFamily: "mistral-ai", match: "contains", tokens: ["mistralai-user"] },
  { vendorFamily: "duckassist", match: "contains", tokens: ["duckassistbot"] },
] as const satisfies readonly RoutableAgentUaEntry[];

export const INDEXER_UA_ROSTER = [
  {
    match: "contains",
    tokens: ["meta-webindexer", "facebookexternalhit"],
  },
] as const satisfies readonly IndexerUaEntry[];

export type UserAgentClassification =
  | { kind: "routable_agent"; surface: "agent"; vendorFamily: AgentVendorFamily }
  | { kind: "indexer"; surface: "human" }
  | { kind: "unclassified"; surface: "human" };

function matchesUserAgent(
  normalizedUserAgent: string,
  entry: { readonly match: UserAgentMatch; readonly tokens: readonly string[] },
): boolean {
  return entry.tokens.some((token) =>
    entry.match === "exact" ? normalizedUserAgent === token : normalizedUserAgent.includes(token),
  );
}

export function classifyUserAgent(userAgent: string | null | undefined): UserAgentClassification {
  const normalizedUserAgent = typeof userAgent === "string" ? userAgent.toLowerCase() : "";
  const routable = ROUTABLE_AGENT_UA_ROSTER.find((entry) =>
    matchesUserAgent(normalizedUserAgent, entry),
  );
  if (routable) {
    return {
      kind: "routable_agent",
      surface: "agent",
      vendorFamily: routable.vendorFamily,
    };
  }
  if (INDEXER_UA_ROSTER.some((entry) => matchesUserAgent(normalizedUserAgent, entry))) {
    return { kind: "indexer", surface: "human" };
  }
  return { kind: "unclassified", surface: "human" };
}

/** Bounds fields after the caller applies its product-specific query redaction. */
export function boundedUserAgentLogFields(input: {
  userAgent?: string | null;
  redactedQuery?: string | null;
}): { userAgent: string; query: string } {
  return {
    userAgent: typeof input.userAgent === "string" ? input.userAgent.slice(0, 160) : "",
    query: typeof input.redactedQuery === "string" ? input.redactedQuery.slice(0, 200) : "",
  };
}
