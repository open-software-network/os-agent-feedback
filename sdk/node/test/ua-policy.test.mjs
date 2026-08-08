import assert from "node:assert/strict";
import test from "node:test";

import {
  agentVendorFamilyForUserAgent,
  boundedUserAgentLogFields,
  classifyUserAgent,
  INDEXER_UA_ROSTER,
  ROUTABLE_AGENT_UA_ROSTER,
} from "../dist/index.js";

const routableCases = [
  ["Claude-User/1.0", "claude-user"],
  ["Anthropic-AI/1.0", "claude-user"],
  ["ChatGPT-User/1.0", "chatgpt-user"],
  ["Perplexity-User/1.0", "perplexity-user"],
  ["Cohere-AI/1.0", "cohere-ai"],
  ["Gemini-Agent/1.0", "gemini-agent"],
  ["Google", "gemini-user"],
  ["meta-externalfetcher/1.1", "meta-ai-user"],
  ["KimiBot/1.0", "moonshot-ai"],
  ["MoonshotBot/1.0", "moonshot-ai"],
  ["KimiCrawler/1.0", "moonshot-ai"],
  ["MistralAI-User/1.0", "mistral-ai"],
  ["DuckAssistBot/1.0", "duckassist"],
];

test("UA policy exports the accepted routable and indexer rosters", () => {
  assert.deepEqual(
    ROUTABLE_AGENT_UA_ROSTER.flatMap((entry) => entry.tokens),
    [
      "claude-user",
      "anthropic-ai",
      "chatgpt-user",
      "perplexity-user",
      "cohere-ai",
      "gemini-agent",
      "google",
      "meta-externalfetcher",
      "kimibot",
      "moonshotbot",
      "kimicrawler",
      "mistralai-user",
      "duckassistbot",
    ],
  );
  assert.deepEqual(
    INDEXER_UA_ROSTER.flatMap((entry) => entry.tokens),
    ["meta-webindexer", "facebookexternalhit"],
  );
});

test("documented fetch-time agents route to the agent surface with vendor families", () => {
  for (const [userAgent, vendorFamily] of routableCases) {
    assert.equal(agentVendorFamilyForUserAgent(userAgent), vendorFamily);
    assert.deepEqual(classifyUserAgent(userAgent), {
      kind: "routable_agent",
      surface: "agent",
      vendorFamily,
    });
    assert.deepEqual(classifyUserAgent(userAgent.toUpperCase()), {
      kind: "routable_agent",
      surface: "agent",
      vendorFamily,
    });
  }
});

test("indexers win compound routing while vendor hints retain old independent matching", () => {
  for (const [userAgent, vendorFamily] of [
    ["facebookexternalhit/1.1 meta-externalfetcher/1.1", "meta-ai-user"],
    ["meta-webindexer/1.1 chatgpt-user", "chatgpt-user"],
  ]) {
    assert.deepEqual(classifyUserAgent(userAgent), {
      kind: "indexer",
      surface: "human",
    });
    assert.equal(agentVendorFamilyForUserAgent(userAgent), vendorFamily);
  }
});

test("Google stays exact while indexers remain in the human surface class", () => {
  assert.deepEqual(classifyUserAgent("Googlebot/2.1"), {
    kind: "unclassified",
    surface: "human",
  });
  assert.deepEqual(classifyUserAgent("Google browser fetch"), {
    kind: "unclassified",
    surface: "human",
  });
  for (const userAgent of ["Meta-WebIndexer/1.1", "facebookexternalhit/1.1"]) {
    assert.deepEqual(classifyUserAgent(userAgent), {
      kind: "indexer",
      surface: "human",
    });
  }
});

test("unknown, browser, and anonymous agent UAs deliberately route to human", () => {
  for (const userAgent of [
    undefined,
    null,
    "",
    "Mozilla/5.0 Chrome/140.0",
    "UnknownFetcher/1.0",
    "Grok/1.0",
    "DeepSeekBot/1.0",
    "Microsoft Copilot Actions/1.0",
  ]) {
    assert.deepEqual(classifyUserAgent(userAgent), {
      kind: "unclassified",
      surface: "human",
    });
  }
});

test("UA log fields preserve short values and enforce exact bounds", () => {
  assert.deepEqual(
    boundedUserAgentLogFields({ userAgent: "KimiBot/1.0", redactedQuery: "?journey=:value" }),
    { userAgent: "KimiBot/1.0", query: "?journey=:value" },
  );

  const bounded = boundedUserAgentLogFields({
    userAgent: `ua-${"x".repeat(200)}`,
    redactedQuery: `?${"q".repeat(240)}`,
  });
  assert.equal(bounded.userAgent.length, 160);
  assert.equal(bounded.query.length, 200);
  assert.deepEqual(boundedUserAgentLogFields({}), { userAgent: "", query: "" });
});
