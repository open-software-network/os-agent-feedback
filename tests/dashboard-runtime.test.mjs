import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../backend/public/app.js", import.meta.url), "utf8");

const now = Date.now();
const iso = (offsetMinutes) => new Date(now + offsetMinutes * 60_000).toISOString();
const dashboard = {
  user: { id: "user-1", displayName: "Avery", email: "avery@example.com" },
  workspace: { id: "workspace-1", name: "Acme" },
  workspaceMemberships: [{ workspaceId: "workspace-1", workspaceName: "Acme" }],
  currentRole: "owner",
  teamMembers: [{ osUserId: "user-1", displayName: "Avery", email: "avery@example.com", role: "owner" }],
  teamInvitations: [],
  products: [{ id: "product-1", name: "Search API" }],
  currentProduct: { id: "product-1", name: "Search API" },
  environments: [{ id: "environment-1", productId: "product-1", feedbackMode: "auto", retentionDays: 30 }],
  currentEnvironment: { id: "environment-1", productId: "product-1", feedbackMode: "auto", retentionDays: 30 },
  apiKeys: [{ id: "key-1", prefix: "af_live_1234abcd", label: "Default product key", createdAt: iso(-120) }],
  sessions: [{ id: "session-1", source: "product", refHint: "sess_01H", startedAt: iso(-20), lastSeenAt: iso(-5) }],
  interactions: [
    { id: "interaction-1", apiKeyId: "key-1", sessionId: "session-1", surface: "http_json", operation: "search", statusCode: 200, durationMs: 320, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "outcome_submission", runtimeHint: "codex", runtimeHintSource: "user-agent", occurredAt: iso(-20) },
    { id: "interaction-2", apiKeyId: "key-1", sessionId: "session-1", surface: "mcp", operation: "fetch_document", statusCode: null, durationMs: 810, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "mcp", runtimeHint: "mcp-client", runtimeHintSource: "client_info", occurredAt: iso(-10) },
    { id: "interaction-3", apiKeyId: "key-1", sessionId: null, surface: "http_json", operation: "search", statusCode: 200, durationMs: 190, customerRef: null, classification: "unclassified", confirmationMethod: null, runtimeHint: null, runtimeHintSource: null, occurredAt: iso(-3) },
  ],
  outcomes: [
    { id: "outcome-1", interactionId: "interaction-1", sessionId: "session-1", outcome: "success", note: "The result answered the question.", source: "company_relay", surface: "http_json", operation: "search", statusCode: 200, durationMs: 320, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "outcome_submission", runtimeHint: "codex", runtimeHintSource: "user-agent", occurredAt: iso(-20), createdAt: iso(-18) },
    { id: "outcome-2", interactionId: "interaction-2", sessionId: "session-1", outcome: "failure", note: "The document could not be opened.", source: "mcp_tool", surface: "mcp", operation: "fetch_document", statusCode: null, durationMs: 810, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "mcp", runtimeHint: "mcp-client", runtimeHintSource: "client_info", occurredAt: iso(-10), createdAt: iso(-8) },
  ],
  legacyFeedback: [],
  legacySessions: [],
  legacyEvents: [],
  insights: {},
};

function button(dataset = {}, attributes = []) {
  return { dataset, hasAttribute: (name) => attributes.includes(name) };
}

async function loadDashboard() {
  const elements = new Map([
    ["#page", { innerHTML: "", setAttribute() {} }],
    ["#notice", { textContent: "", hidden: true }],
    ["#account", { innerHTML: "" }],
    ["#product-scope", { innerHTML: "" }],
    ["#signout", { addEventListener() {} }],
  ]);
  const handlers = {};
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener: (name, handler) => { handlers[name] = handler; },
  };
  const location = { href: "https://app.epode.ai/?view=feedback", origin: "https://app.epode.ai", assign() {} };
  const context = vm.createContext({
    console,
    document,
    window: { addEventListener: (name, handler) => { handlers[`window:${name}`] = handler; } },
    location,
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => structuredClone(dashboard) }),
    URL,
    URLSearchParams,
    Headers,
    FormData,
    Intl,
    Date,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { context, handlers, page: elements.get("#page") };
}

test("feedback, interaction, and session explorers render and preserve linked context", async () => {
  const { handlers, page } = await loadDashboard();
  assert.match(page.innerHTML, /Agent feedback/);
  assert.match(page.innerHTML, /The result answered the question/);
  assert.match(page.innerHTML, /Search feedback, operation, or customer/);

  await handlers.click({ target: { closest: () => button({ outcome: "outcome-1" }) } });
  assert.match(page.innerHTML, /Linked product context/);
  assert.match(page.innerHTML, /Open session/);

  await handlers.click({ target: { closest: () => button({ openSession: "session-1" }) } });
  assert.match(page.innerHTML, /Interaction journey/);
  assert.match(page.innerHTML, /fetch_document/);
  assert.match(page.innerHTML, /The document could not be opened/);

  await handlers.click({ target: { closest: () => button({ interaction: "interaction-2" }) } });
  assert.match(page.innerHTML, /What proves this interaction/);
  assert.match(page.innerHTML, /Open feedback/);
});

test("facets and investigation shortcuts change the loaded explorer", async () => {
  const { handlers, page } = await loadDashboard();
  await handlers.change({ target: { id: "explorer-primary", value: "failure", dataset: {} } });
  assert.doesNotMatch(page.innerHTML, /The result answered the question/);
  assert.match(page.innerHTML, /The document could not be opened/);

  await handlers.click({ target: { closest: () => button({ view: "insights" }) } });
  assert.match(page.innerHTML, /Where to look next/);
  await handlers.click({ target: { closest: () => button({ investigateView: "interactions", investigateFilter: "unreviewed" }) } });
  assert.match(page.innerHTML, /Confirmed without feedback/);
});
