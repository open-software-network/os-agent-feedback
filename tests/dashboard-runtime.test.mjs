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
  environments: [{ id: "environment-1", productId: "product-1", feedbackMode: "never_ask", retentionDays: 30 }],
  currentEnvironment: { id: "environment-1", productId: "product-1", feedbackMode: "never_ask", retentionDays: 30 },
  apiKeys: [
    { id: "key-1", prefix: "af_live_1234abcd", label: "Default product key", kind: "write", createdAt: iso(-120), expiresAt: null, lastUsedAt: iso(-4) },
    { id: "key-2", prefix: "af_read_5678beef", label: "Repo read key", kind: "read", createdAt: iso(-60), expiresAt: iso(129_600), lastUsedAt: null },
  ],
  sessions: [{ id: "session-1", source: "product", refHint: "sess_01H", startedAt: iso(-20), lastSeenAt: iso(-5) }],
  interactions: [
    { id: "interaction-1", apiKeyId: "key-1", sessionId: "session-1", surface: "http_json", operation: "search", statusCode: 200, durationMs: 320, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "feedback_report", runtimeHint: "codex", runtimeHintSource: "user-agent", occurredAt: iso(-20) },
    { id: "interaction-2", apiKeyId: "key-1", sessionId: "session-1", surface: "mcp", operation: "fetch_document", statusCode: null, durationMs: 810, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "mcp", runtimeHint: "mcp-client", runtimeHintSource: "client_info", occurredAt: iso(-10) },
    { id: "interaction-3", apiKeyId: "key-1", sessionId: null, surface: "http_json", operation: "search", statusCode: 200, durationMs: 190, customerRef: null, classification: "unclassified", confirmationMethod: null, runtimeHint: null, runtimeHintSource: null, occurredAt: iso(-3) },
  ],
  reports: [
    { id: "report-1", interactionId: "interaction-1", sessionId: "session-1", summary: "The result answered the question with a small pagination detour.", impact: "helped_with_friction", confidence: 0.92, findings: [{ kind: "strength", topic: "relevance", detail: "The result answered the question." }, { kind: "friction", topic: "pagination", severity: "minor", detail: "A second page was required." }], workaround: { used: true, detail: "The agent requested the next page." }, source: "customer_agent", surface: "http_json", operation: "search", statusCode: 200, durationMs: 320, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "feedback_report", runtimeHint: "codex", runtimeHintSource: "user-agent", occurredAt: iso(-20), createdAt: iso(-18) },
    { id: "report-2", interactionId: "interaction-2", sessionId: "session-1", summary: "The document could not be opened and no fallback was available.", impact: "blocked", confidence: 0.99, findings: [{ kind: "defect", topic: "document_access", severity: "blocking", detail: "The document could not be opened." }], workaround: { used: false }, source: "customer_agent", surface: "mcp", operation: "fetch_document", statusCode: null, durationMs: 810, customerRef: "acct_42", classification: "confirmed", confirmationMethod: "mcp", runtimeHint: "mcp-client", runtimeHintSource: "client_info", occurredAt: iso(-10), createdAt: iso(-8) },
  ],
  insights: {},
};

function button(dataset = {}, attributes = []) {
  return { dataset, hasAttribute: (name) => attributes.includes(name) };
}

async function loadDashboard({ href = "https://app.epode.ai/?view=feedback", fetchImpl, promptImpl } = {}) {
  const elements = new Map([
    ["#page", { innerHTML: "", setAttribute() {} }],
    ["#notice", { textContent: "", hidden: true, setAttribute(name, value) { this[name] = value; } }],
    ["#account", { innerHTML: "" }],
    ["#product-scope", { innerHTML: "" }],
    ["#signout", { addEventListener() {} }],
  ]);
  const handlers = {};
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener: (name, handler) => { handlers[name] = handler; },
    createElement: () => ({ value: "", style: {}, setAttribute() {}, select() {}, remove() {} }),
    execCommand: () => true,
    body: { appendChild() {} },
  };
  const location = { href, origin: "https://app.epode.ai", assigned: null, assign(value) { this.assigned = value; } };
  const context = vm.createContext({
    console,
    document,
    window: { addEventListener: (name, handler) => { handlers[`window:${name}`] = handler; } },
    location,
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => structuredClone(dashboard) })),
    URL,
    URLSearchParams,
    Headers,
    FormData: class {
      constructor(form) { this.data = form?.formData || new Map(); }
      get(name) { return this.data.get(name) ?? null; }
    },
    Intl,
    Date,
    confirm: () => true,
    prompt: promptImpl || (() => null),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { context, handlers, location, notice: elements.get("#notice"), page: elements.get("#page"), productScope: elements.get("#product-scope") };
}

test("feedback, interaction, and session explorers render and preserve linked context", async () => {
  const { handlers, page } = await loadDashboard();
  assert.match(page.innerHTML, /Agent feedback/);
  assert.match(page.innerHTML, /The result answered the question/);
  assert.match(page.innerHTML, /Search summaries, findings, topics, operation, or customer/);

  await handlers.click({ target: { closest: () => button({ report: "report-1" }) } });
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

test("session list summarizes every report instead of showing an arbitrary report", async () => {
  const { handlers, page } = await loadDashboard();
  await handlers.click({ target: { closest: () => button({ view: "sessions" }) } });
  assert.match(page.innerHTML, /2 reports/);
  assert.match(page.innerHTML, /1 blocking · 2 friction/);
});

test("facets and investigation shortcuts change the loaded explorer", async () => {
  const { handlers, page } = await loadDashboard();
  await handlers.change({ target: { id: "explorer-primary", value: "blocked", dataset: {} } });
  assert.doesNotMatch(page.innerHTML, /The result answered the question/);
  assert.match(page.innerHTML, /The document could not be opened/);

  await handlers.click({ target: { closest: () => button({ view: "home" }) } });
  assert.match(page.innerHTML, /Where to look next/);
  await handlers.click({ target: { closest: () => button({ investigateView: "interactions", investigateFilter: "unreviewed" }) } });
  assert.match(page.innerHTML, /Confirmed without feedback/);
});

test("malformed deep links and delayed searches cannot corrupt navigation state", async () => {
  const { context, handlers } = await loadDashboard({ href: "https://app.epode.ai/?view=unknown&report=missing&filter=garbage&surface=bogus&range=forever" });
  assert.equal(vm.runInContext("currentView", context), "home");
  assert.equal(vm.runInContext("selectedReport", context), null);
  assert.equal(vm.runInContext("explorerPrimary", context), "all");
  assert.equal(vm.runInContext("explorerSecondary", context), "all");
  assert.equal(vm.runInContext("explorerRange", context), "30d");

  handlers.input({ target: { id: "explorer-search", value: "fetch" } });
  await handlers.click({ target: { closest: () => button({ view: "sessions" }) } });
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(vm.runInContext("currentView", context), "sessions");
  assert.equal(vm.runInContext("explorerQuery", context), "");
});

test("a failed initial data request shows retry UI without reloading forever", async () => {
  const { location, page } = await loadDashboard({ fetchImpl: async () => { throw new Error("network offline"); } });
  assert.match(page.innerHTML, /could not load/i);
  assert.match(page.innerHTML, /Try again/);
  assert.equal(location.assigned, null);
});

test("action notices render as ephemeral accessible toasts", async () => {
  const { context, notice } = await loadDashboard();
  vm.runInContext('setNotice("Member role updated.", 5)', context);
  assert.equal(notice.hidden, false);
  assert.equal(notice.textContent, "Member role updated.");
  assert.equal(notice.role, "status");
  assert.match(notice.className, /notice-info/);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(notice.hidden, true);

  vm.runInContext('setNotice("Update failed", 5, "error")', context);
  assert.equal(notice.role, "alert");
  assert.match(notice.className, /notice-error/);
});

test("setup lists key kinds with expiry and last-used, and rotating a read key keeps it a read key", async () => {
  const state = structuredClone(dashboard);
  const created = [];
  const fetchImpl = async (path, options = {}) => {
    if (path.startsWith("/api/settings/api-keys/") && options.method === "DELETE") {
      return { ok: true, status: 200, json: async () => ({ revoked: true }) };
    }
    if (path === "/api/settings/api-keys" && options.method === "POST") {
      const body = JSON.parse(options.body);
      created.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          secret: "af_read_9999aaaa9999aaaa9999aaaa9999aaaa_rotated_secret_value",
          apiKey: { id: "key-3", prefix: "af_read_9999aaaa", label: body.label, kind: body.kind || "write", createdAt: iso(0), expiresAt: iso(129_600), lastUsedAt: null },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, page } = await loadDashboard({ fetchImpl });
  await handlers.click({ target: { closest: () => button({ view: "setup" }) } });
  assert.match(page.innerHTML, /key-kind read/);
  assert.match(page.innerHTML, /key-kind write/);
  assert.match(page.innerHTML, /never used/);
  assert.match(page.innerHTML, /expires never/);
  assert.match(page.innerHTML, /AGENT_FEEDBACK_READ_KEY/);
  assert.match(page.innerHTML, /&quot;mcpServers&quot;/);

  await handlers.click({ target: { closest: () => button({ readClient: "vs-code" }) } });
  assert.match(page.innerHTML, /promptString/);
  assert.match(page.innerHTML, /&quot;servers&quot;/);

  await handlers.click({ target: { closest: () => button({ revokeKey: "key-2" }) } });
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "read");
  assert.equal(created[0].label, "Repo read key");
  assert.equal(created[0].expiresInSeconds, 7776000);
  assert.match(page.innerHTML, /Save this read key now/);

  await handlers.click({ target: { closest: () => button({ revokeKey: "key-1" }) } });
  assert.equal(created.length, 2);
  assert.equal(created[1].kind, "write");
  assert.equal(created[1].expiresInSeconds, undefined);
});

test("creating a read key posts kind and expiry and shows the shown-once secret", async () => {
  const state = structuredClone(dashboard);
  const created = [];
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/settings/api-keys" && options.method === "POST") {
      const body = JSON.parse(options.body);
      created.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          secret: "af_read_bbbbccccbbbbccccbbbbccccbbbbcccc_fresh_secret_value",
          apiKey: { id: "key-4", prefix: "af_read_bbbbcccc", label: body.label, kind: "read", createdAt: iso(0), expiresAt: null, lastUsedAt: null },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, page } = await loadDashboard({ fetchImpl });
  await handlers.click({ target: { closest: () => button({ view: "setup" }) } });
  const form = new Map([["label", "CI read key"], ["expiresIn", "never"]]);
  await handlers.submit({ preventDefault() {}, target: { id: "read-key-form", formData: form } });
  assert.equal(created.length, 1);
  assert.equal(created[0].kind, "read");
  assert.equal(created[0].label, "CI read key");
  assert.equal(created[0].expiresInSeconds, undefined);
  assert.match(page.innerHTML, /Save this read key now/);
  assert.match(page.innerHTML, /fresh_secret_value/);
});

test("owners can rename the team and current product in place", async () => {
  const state = structuredClone(dashboard);
  const calls = [];
  const prompts = ["Platform", "Search v2"];
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/team" && options.method === "PATCH") {
      const { name } = JSON.parse(options.body);
      state.workspace.name = name;
      state.workspaceMemberships[0].workspaceName = name;
      calls.push([path, name]);
      return { ok: true, status: 200, json: async () => ({ workspace: structuredClone(state.workspace) }) };
    }
    if (path === "/api/products/product-1" && options.method === "PATCH") {
      const { name } = JSON.parse(options.body);
      state.currentProduct.name = name;
      state.products[0].name = name;
      calls.push([path, name]);
      return { ok: true, status: 200, json: async () => ({ product: structuredClone(state.currentProduct) }) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, page, productScope } = await loadDashboard({
    fetchImpl,
    promptImpl: () => prompts.shift(),
  });

  await handlers.click({ target: { closest: () => button({ view: "team" }) } });
  assert.match(page.innerHTML, /Rename team/);
  await handlers.click({ target: { closest: () => button({}, ["data-rename-team"]) } });
  assert.match(page.innerHTML, /Platform/);

  assert.match(productScope.innerHTML, /Rename product/);
  await handlers.click({ target: { closest: () => button({}, ["data-rename-product"]) } });
  assert.match(productScope.innerHTML, /Search v2/);
  assert.deepEqual(calls, [["/api/team", "Platform"], ["/api/products/product-1", "Search v2"]]);
});

test("product deletion requires the exact name and switches to the next product", async () => {
  const state = structuredClone(dashboard);
  state.products.push({ id: "product-2", name: "Documentation" });
  const calls = [];
  const prompts = ["wrong name", "Search API"];
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/products/product-1" && options.method === "DELETE") {
      const { confirmation } = JSON.parse(options.body);
      calls.push([path, confirmation]);
      state.products = state.products.filter((product) => product.id !== "product-1");
      state.currentProduct = state.products[0];
      state.currentEnvironment = { ...state.currentEnvironment, id: "environment-2", productId: "product-2" };
      state.environments = [state.currentEnvironment];
      state.apiKeys = [];
      state.sessions = [];
      state.interactions = [];
      state.reports = [];
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, productScope } = await loadDashboard({
    fetchImpl,
    promptImpl: () => prompts.shift(),
  });

  assert.match(productScope.innerHTML, /Delete product/);
  await handlers.click({ target: { closest: () => button({}, ["data-delete-product"]) } });
  assert.equal(calls.length, 0);
  await handlers.click({ target: { closest: () => button({}, ["data-delete-product"]) } });
  assert.deepEqual(calls, [["/api/products/product-1", "Search API"]]);
  assert.match(productScope.innerHTML, /Documentation/);
  assert.doesNotMatch(productScope.innerHTML, /Search API/);
});

test("deleting the last product returns owners to first-product onboarding", async () => {
  const state = structuredClone(dashboard);
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/products/product-1" && options.method === "DELETE") {
      state.products = [];
      state.currentProduct = null;
      state.currentEnvironment = null;
      state.environments = [];
      state.apiKeys = [];
      state.sessions = [];
      state.interactions = [];
      state.reports = [];
      return { ok: true, status: 200, json: async () => ({ deleted: true }) };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { context, handlers, page } = await loadDashboard({
    fetchImpl,
    promptImpl: () => "Search API",
  });

  await handlers.click({ target: { closest: () => button({}, ["data-delete-product"]) } });
  assert.equal(vm.runInContext("currentView", context), "home");
  assert.match(page.innerHTML, /Create your first product/);
});

test("the product root opens a Home overview with recent feedback and usage", async () => {
  const { context, page } = await loadDashboard({ href: "https://app.epode.ai/" });
  assert.equal(vm.runInContext("currentView", context), "home");
  assert.match(page.innerHTML, /Search API/);
  assert.match(page.innerHTML, /Last 30 days/);
  assert.match(page.innerHTML, /What agents reported/);
  assert.match(page.innerHTML, /Top operations/);
  assert.match(page.innerHTML, /Where to look next/);
  assert.match(page.innerHTML, /The document could not be opened/);
});
