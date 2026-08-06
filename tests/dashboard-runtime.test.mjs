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
  teamMembers: [
    { osUserId: "user-1", displayName: "Avery", email: "avery@example.com", role: "owner" },
  ],
  teamInvitations: [],
  products: [{ id: "product-1", name: "Search API" }],
  currentProduct: { id: "product-1", name: "Search API" },
  environments: [
    { id: "environment-1", productId: "product-1", feedbackMode: "never_ask", retentionDays: 30 },
  ],
  currentEnvironment: {
    id: "environment-1",
    productId: "product-1",
    feedbackMode: "never_ask",
    retentionDays: 30,
  },
  apiKeys: [
    {
      id: "key-1",
      prefix: "af_live_1234abcd",
      label: "Default product key",
      kind: "write",
      createdAt: iso(-120),
      expiresAt: null,
      lastUsedAt: iso(-4),
    },
    {
      id: "key-2",
      prefix: "af_read_5678beef",
      label: "Repo read key",
      kind: "read",
      createdAt: iso(-60),
      expiresAt: iso(129_600),
      lastUsedAt: null,
    },
  ],
  sessions: [
    {
      id: "session-1",
      source: "product",
      refHint: "sess_01H",
      startedAt: iso(-20),
      lastSeenAt: iso(-5),
    },
  ],
  interactions: [
    {
      id: "interaction-1",
      apiKeyId: "key-1",
      sessionId: "session-1",
      surface: "http_json",
      operation: "search",
      statusCode: 200,
      durationMs: 320,
      customerRef: "acct_42",
      classification: "confirmed",
      confirmationMethod: "feedback_report",
      runtimeHint: "codex",
      runtimeHintSource: "user-agent",
      occurredAt: iso(-20),
    },
    {
      id: "interaction-2",
      apiKeyId: "key-1",
      sessionId: "session-1",
      surface: "mcp",
      operation: "fetch_document",
      statusCode: null,
      durationMs: 810,
      customerRef: "acct_42",
      classification: "confirmed",
      confirmationMethod: "mcp",
      runtimeHint: "mcp-client",
      runtimeHintSource: "client_info",
      occurredAt: iso(-10),
    },
    {
      id: "interaction-3",
      apiKeyId: "key-1",
      sessionId: null,
      surface: "http_json",
      operation: "search",
      statusCode: 200,
      durationMs: 190,
      customerId: "customer-resolved-3",
      customerRef: null,
      classification: "unclassified",
      confirmationMethod: null,
      runtimeHint: null,
      runtimeHintSource: null,
      occurredAt: iso(-3),
    },
  ],
  reports: [
    {
      id: "report-1",
      interactionId: "interaction-1",
      sessionId: "session-1",
      summary: "The result answered the question with a small pagination detour.",
      impact: "helped_with_friction",
      confidence: 0.92,
      findings: [
        { kind: "strength", topic: "relevance", detail: "The result answered the question." },
        {
          kind: "friction",
          topic: "pagination",
          severity: "minor",
          detail: "A second page was required.",
        },
      ],
      workaround: { used: true, detail: "The agent requested the next page." },
      source: "customer_agent",
      surface: "http_json",
      operation: "search",
      statusCode: 200,
      durationMs: 320,
      customerRef: "acct_42",
      classification: "confirmed",
      confirmationMethod: "feedback_report",
      runtimeHint: "codex",
      runtimeHintSource: "user-agent",
      occurredAt: iso(-20),
      createdAt: iso(-18),
    },
    {
      id: "report-2",
      interactionId: "interaction-2",
      sessionId: "session-1",
      summary: "The document could not be opened and no fallback was available.",
      impact: "blocked",
      confidence: 0.99,
      findings: [
        {
          kind: "defect",
          topic: "document_access",
          severity: "blocking",
          detail: "The document could not be opened.",
        },
      ],
      workaround: { used: false },
      source: "customer_agent",
      surface: "mcp",
      operation: "fetch_document",
      statusCode: null,
      durationMs: 810,
      customerRef: "acct_42",
      classification: "confirmed",
      confirmationMethod: "mcp",
      runtimeHint: "mcp-client",
      runtimeHintSource: "client_info",
      occurredAt: iso(-10),
      createdAt: iso(-8),
    },
  ],
  insights: {
    windowDays: 30,
    comparisonDays: 7,
    opportunities: 3,
    confirmedInteractions: 2,
    reports: 2,
    recentOpportunities: 3,
    recentConfirmedInteractions: 2,
    recentReports: 2,
    previousOpportunities: 0,
    previousConfirmedInteractions: 0,
    previousReports: 0,
    confirmationRate: 67,
    reviewRate: 100,
    reportsWithBlockers: 1,
    reportsWithWorkarounds: 1,
    p50DurationMs: 320,
    p95DurationMs: 810,
    topOperations: [
      { name: "search", count: 2 },
      { name: "fetch_document", count: 1 },
    ],
    surfaces: [
      { name: "http_json", count: 2 },
      { name: "mcp", count: 1 },
    ],
    impacts: [
      { name: "helped_with_friction", count: 1 },
      { name: "blocked", count: 1 },
    ],
    findingKinds: [
      { name: "strength", count: 1 },
      { name: "friction", count: 1 },
      { name: "defect", count: 1 },
    ],
    topics: [
      { name: "relevance", count: 1 },
      { name: "pagination", count: 1 },
      { name: "document_access", count: 1 },
    ],
    blockingTopics: [{ name: "document_access", count: 1 }],
    lostDemand: {
      decisionInteractions: 4,
      zeroMatchDecisions: 1,
      expressedDimensions: [
        { name: "budget", count: 3 },
        { name: "color", count: 2 },
      ],
      violatedDimensions: [{ name: "budget", count: 2 }],
      counterfactualChanges: [{ name: "raise_budget_from_150_to_164", count: 1 }],
      medianCounterfactualDelta: 14,
    },
    journeyFlow: {
      edges: [
        {
          fromOperation: "/agent-negotiate/lamp",
          toOperation: "/agent-decide/lamp",
          traversals: 3,
        },
      ],
      exitOperations: [{ name: "/agent-decide/lamp", count: 2 }],
    },
    handoff: {
      handoffClicks: 2,
      sessionsWithHandoff: 1,
      sessions: 3,
      handoffRate: 33,
      landingOperations: [{ name: "/product/feeder", count: 2 }],
    },
    signalOutcomes: [{ signal: "constraint/budget", decisions: 3, outcomes: 2, conversions: 1 }],
    agentVendors: [
      { vendor: "claude", interactions: 5, sessions: 2 },
      { vendor: "openai", interactions: 2, sessions: 1 },
    ],
    rankPositions: [
      { name: "1", count: 4 },
      { name: "2", count: 1 },
    ],
    unknownDimensions: [{ name: "commute", count: 2 }],
    unansweredQuestions: [{ name: "budget · declined", count: 1 }],
  },
  listState: {
    interactionsTotal: 3,
    reportsTotal: 2,
    sessionsTotal: 1,
    interactionsLoaded: 3,
    reportsLoaded: 2,
    sessionsLoaded: 1,
  },
};

function button(dataset = {}, attributes = []) {
  return { dataset, hasAttribute: (name) => attributes.includes(name) };
}

async function loadDashboard({
  href = "https://app.epode.ai/?view=feedback",
  fetchImpl,
  promptImpl,
} = {}) {
  const heading = {
    focused: false,
    setAttribute() {},
    focus() {
      this.focused = true;
    },
  };
  const elements = new Map([
    ["#page", { innerHTML: "", setAttribute() {}, querySelector: () => heading }],
    [
      "#notice",
      {
        textContent: "",
        hidden: true,
        setAttribute(name, value) {
          this[name] = value;
        },
      },
    ],
    ["#account", { innerHTML: "" }],
    ["#product-scope", { innerHTML: "" }],
    ["#signout", { addEventListener() {} }],
  ]);
  const handlers = {};
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    querySelectorAll: () => [],
    addEventListener: (name, handler) => {
      handlers[name] = handler;
    },
    createElement: () => ({ value: "", style: {}, setAttribute() {}, select() {}, remove() {} }),
    execCommand: () => true,
    body: { appendChild() {} },
  };
  const location = {
    href,
    origin: "https://app.epode.ai",
    assigned: null,
    assign(value) {
      this.assigned = value;
    },
  };
  const context = vm.createContext({
    console,
    document,
    window: {
      addEventListener: (name, handler) => {
        handlers[`window:${name}`] = handler;
      },
    },
    location,
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: { getItem: () => null, setItem() {} },
    fetch:
      fetchImpl ||
      (async () => ({ ok: true, status: 200, json: async () => structuredClone(dashboard) })),
    URL,
    URLSearchParams,
    Headers,
    FormData: class {
      constructor(form) {
        this.data = form?.formData || new Map();
      }
      get(name) {
        return this.data.get(name) ?? null;
      }
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
  return {
    context,
    handlers,
    heading,
    location,
    notice: elements.get("#notice"),
    page: elements.get("#page"),
    productScope: elements.get("#product-scope"),
  };
}

test("feedback, interaction, and session explorers render and preserve linked context", async () => {
  const { handlers, heading, page } = await loadDashboard();
  assert.match(page.innerHTML, /Agent feedback/);
  assert.match(page.innerHTML, /The result answered the question/);
  assert.match(page.innerHTML, /Search summaries, findings, tags, operation, or customer/);

  await handlers.click({ target: { closest: () => button({ report: "report-1" }) } });
  assert.equal(heading.focused, true);
  assert.match(page.innerHTML, /Linked product context/);
  assert.match(page.innerHTML, /Open journey/);

  await handlers.click({ target: { closest: () => button({ openSession: "session-1" }) } });
  assert.match(page.innerHTML, /Interaction journey/);
  assert.match(page.innerHTML, /fetch_document/);
  assert.match(page.innerHTML, /The document could not be opened/);

  await handlers.click({ target: { closest: () => button({ interaction: "interaction-2" }) } });
  assert.match(page.innerHTML, /What proves this interaction/);
  assert.match(page.innerHTML, /Open feedback/);
});

test("interaction detail displays resolved customer linkage when the raw customer ref is absent", async () => {
  const { handlers, page } = await loadDashboard();
  await handlers.click({ target: { closest: () => button({ view: "interactions" }) } });
  await handlers.click({ target: { closest: () => button({ interaction: "interaction-3" }) } });
  assert.match(page.innerHTML, /customer-resolved-3/);
  assert.doesNotMatch(page.innerHTML, /<dt>Customer<\/dt><dd>Not linked<\/dd>/);
});

test("product customer refs remain the display fallback when resolved IDs coexist", async () => {
  const state = structuredClone(dashboard);
  state.sessions[0].customerId = "customer-internal-session";
  state.sessions[0].customerRef = "acct_42";
  state.interactions[1].customerId = "customer-internal-interaction";
  const { handlers, page } = await loadDashboard({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => structuredClone(state) }),
  });

  await handlers.click({ target: { closest: () => button({ view: "sessions" }) } });
  assert.match(page.innerHTML, /acct_42/);
  assert.doesNotMatch(page.innerHTML, /customer-internal-session/);
  await handlers.click({ target: { closest: () => button({ session: "session-1" }) } });
  assert.match(page.innerHTML, /<dt>Customer<\/dt><dd>acct_42<\/dd>/);
  assert.doesNotMatch(page.innerHTML, /customer-internal-session/);

  await handlers.click({ target: { closest: () => button({ interaction: "interaction-2" }) } });
  assert.match(page.innerHTML, /<dt>Customer<\/dt><dd>acct_42<\/dd>/);
  assert.doesNotMatch(page.innerHTML, /customer-internal-interaction/);
});

test("session summary displays resolved customer linkage outside the interaction window", async () => {
  const state = structuredClone(dashboard);
  state.sessions.push({
    id: "session-outside-window",
    source: "mcp",
    refHint: "sess_resolved",
    startedAt: iso(-40),
    lastSeenAt: iso(-30),
    interactionCount: 2,
    reportCount: 0,
    customerId: "customer-resolved-session",
    customerDisplayName: "Anonymous customer",
    customerRef: null,
  });
  const { handlers, page } = await loadDashboard({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => structuredClone(state) }),
  });
  await handlers.click({ target: { closest: () => button({ view: "sessions" }) } });
  assert.match(page.innerHTML, /Anonymous customer/);
  await handlers.click({
    target: { closest: () => button({ session: "session-outside-window" }) },
  });
  assert.match(page.innerHTML, /<dt>Customer<\/dt><dd>Anonymous customer<\/dd>/);
  assert.doesNotMatch(page.innerHTML, /<dt>Customer<\/dt><dd>Not linked<\/dd>/);
});

test("the latest team navigation wins when dashboard responses arrive out of order", async () => {
  const pending = new Map();
  const stateFor = (id) => ({
    ...structuredClone(dashboard),
    workspace: { id, name: id },
    workspaceMemberships: ["workspace-1", "workspace-b", "workspace-c"].map((workspaceId) => ({
      workspaceId,
      workspaceName: workspaceId,
    })),
  });
  let initial = true;
  const fetchImpl = async (path) => {
    if (initial) {
      initial = false;
      return { ok: true, status: 200, json: async () => stateFor("workspace-1") };
    }
    const workspace = new URL(path, "https://app.epode.ai").searchParams.get("workspaceId");
    return await new Promise((resolve) => pending.set(workspace, resolve));
  };
  const { context, handlers } = await loadDashboard({ fetchImpl });
  const older = handlers.change({
    target: { id: "workspace-select", value: "workspace-b", dataset: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const latest = handlers.change({
    target: { id: "workspace-select", value: "workspace-c", dataset: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  pending.get("workspace-c")({ ok: true, status: 200, json: async () => stateFor("workspace-c") });
  await latest;
  pending.get("workspace-b")({ ok: true, status: 200, json: async () => stateFor("workspace-b") });
  await older;
  assert.equal(vm.runInContext("selectedWorkspaceId", context), "workspace-c");
  assert.equal(vm.runInContext("dashboard.workspace.id", context), "workspace-c");
});

test("retained records outside the first page are disclosed and loadable", async () => {
  const state = structuredClone(dashboard);
  state.listState.reportsTotal = 302;
  let requestedLimit = null;
  const fetchImpl = async (path) => {
    const url = new URL(path, "https://app.epode.ai");
    requestedLimit = url.searchParams.get("reportLimit");
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, page } = await loadDashboard({ fetchImpl });
  assert.match(page.innerHTML, /newest 2 of 302 retained reports/);
  await handlers.click({ target: { closest: () => button({ loadMore: "reports" }) } });
  assert.equal(requestedLimit, "500");
});

test("session list summarizes every report instead of showing an arbitrary report", async () => {
  const { handlers, page } = await loadDashboard();
  await handlers.click({ target: { closest: () => button({ view: "sessions" }) } });
  assert.match(page.innerHTML, /2 reports/);
  assert.match(page.innerHTML, /1 blocking · 2 friction/);
});

test("facets and investigation shortcuts change the loaded explorer", async () => {
  const { handlers, page } = await loadDashboard();
  await handlers.change({ target: { id: "explorer-secondary", value: "blocked", dataset: {} } });
  assert.doesNotMatch(page.innerHTML, /The result answered the question/);
  assert.match(page.innerHTML, /The document could not be opened/);

  await handlers.click({ target: { closest: () => button({ view: "home" }) } });
  assert.match(page.innerHTML, /Where to look next/);
  await handlers.click({
    target: {
      closest: () => button({ investigateView: "interactions", investigateFilter: "unreviewed" }),
    },
  });
  assert.match(page.innerHTML, /Confirmed without feedback/);
});

test("malformed deep links and delayed searches cannot corrupt navigation state", async () => {
  const { context, handlers } = await loadDashboard({
    href: "https://app.epode.ai/?view=unknown&report=missing&filter=garbage&surface=bogus&range=forever",
  });
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
  const { location, page } = await loadDashboard({
    fetchImpl: async () => {
      throw new Error("network offline");
    },
  });
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

test("a reloaded legacy setup shows only key prefixes and rotation guidance", async () => {
  const { page } = await loadDashboard({ href: "https://app.epode.ai/?view=setup" });
  assert.match(page.innerHTML, /Full server-side key is hidden/);
  assert.match(page.innerHTML, /af_live_1234abcd…/);
  assert.match(page.innerHTML, /Full read key is hidden/);
  assert.match(page.innerHTML, /af_read_5678beef…/);
  assert.match(page.innerHTML, /Rotate key/);
  assert.doesNotMatch(page.innerHTML, /fresh_secret_value|rotated_secret_value/);
});

test("legacy policy saves an exact custom retention period with feedback mode", async () => {
  const state = structuredClone(dashboard);
  const policyUpdates = [];
  const fetchImpl = async (path, options = {}) => {
    if (path === "/api/settings/policy" && options.method === "POST") {
      const body = JSON.parse(options.body);
      policyUpdates.push(body);
      state.currentEnvironment = {
        ...state.currentEnvironment,
        feedbackMode: body.feedbackMode,
        retentionDays: body.retentionDays,
      };
      state.environments = [state.currentEnvironment];
      return {
        ok: true,
        status: 200,
        json: async () => ({ environment: structuredClone(state.currentEnvironment) }),
      };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, page } = await loadDashboard({
    href: "https://app.epode.ai/?view=policy",
    fetchImpl,
  });
  assert.match(page.innerHTML, /Data retention/);
  assert.match(page.innerHTML, /value="30"/);
  const form = new Map([
    ["feedbackMode", "ask_once"],
    ["retentionDays", "47"],
  ]);
  await handlers.submit({ preventDefault() {}, target: { id: "policy-form", formData: form } });
  assert.deepEqual(policyUpdates, [
    {
      environmentId: "environment-1",
      feedbackMode: "ask_once",
      collectEventSummaries: false,
      retentionDays: 47,
    },
  ]);
  assert.match(page.innerHTML, /47 days/);
});

test("setup lists key kinds with expiry and last-used, and rotating a read key keeps it a read key", async () => {
  const state = structuredClone(dashboard);
  const rotated = [];
  const fetchImpl = async (path, options = {}) => {
    if (path.endsWith("/rotate") && options.method === "POST") {
      const old = path.includes("key-2") ? state.apiKeys[1] : state.apiKeys[0];
      rotated.push(old);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          secret:
            old.kind === "read"
              ? "af_read_9999aaaa9999aaaa9999aaaa9999aaaa_rotated_secret_value"
              : "af_live_9999aaaa9999aaaa9999aaaa9999aaaa_rotated_secret_value",
          apiKey: {
            id: `key-${rotated.length + 2}`,
            prefix: old.kind === "read" ? "af_read_9999aaaa" : "af_live_9999aaaa",
            label: old.label,
            kind: old.kind,
            createdAt: iso(0),
            expiresAt: old.kind === "read" ? iso(129_600) : null,
            lastUsedAt: null,
          },
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
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].kind, "read");
  assert.equal(rotated[0].label, "Repo read key");
  assert.match(page.innerHTML, /Save this read key now/);

  await handlers.click({ target: { closest: () => button({ revokeKey: "key-1" }) } });
  assert.equal(rotated.length, 2);
  assert.equal(rotated[1].kind, "write");
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
          apiKey: {
            id: "key-4",
            prefix: "af_read_bbbbcccc",
            label: body.label,
            kind: "read",
            createdAt: iso(0),
            expiresAt: null,
            lastUsedAt: null,
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => structuredClone(state) };
  };
  const { handlers, page } = await loadDashboard({ fetchImpl });
  await handlers.click({ target: { closest: () => button({ view: "setup" }) } });
  const form = new Map([
    ["label", "CI read key"],
    ["expiresIn", "never"],
  ]);
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
      return {
        ok: true,
        status: 200,
        json: async () => ({ workspace: structuredClone(state.workspace) }),
      };
    }
    if (path === "/api/products/product-1" && options.method === "PATCH") {
      const { name } = JSON.parse(options.body);
      state.currentProduct.name = name;
      state.products[0].name = name;
      calls.push([path, name]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ product: structuredClone(state.currentProduct) }),
      };
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
  assert.deepEqual(calls, [
    ["/api/team", "Platform"],
    ["/api/products/product-1", "Search v2"],
  ]);
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
      state.currentEnvironment = {
        ...state.currentEnvironment,
        id: "environment-2",
        productId: "product-2",
      };
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

test("the Home overview surfaces lost demand, journey flow, handoff, context ROI, agent mix, rank, and unknowns", async () => {
  const { page } = await loadDashboard({ href: "https://app.epode.ai/" });
  assert.match(page.innerHTML, /LOST DEMAND/);
  assert.match(page.innerHTML, /What agents asked for and could not get/);
  assert.match(page.innerHTML, /Zero exact matches \(25%\)/);
  assert.match(page.innerHTML, /Dealbreaker dimensions/);
  assert.match(page.innerHTML, /Cheapest fixes/);
  assert.match(page.innerHTML, /JOURNEY FLOW/);
  assert.match(page.innerHTML, /\/agent-negotiate\/lamp → \/agent-decide\/lamp/i);
  assert.match(page.innerHTML, /Where journeys end/);
  assert.match(page.innerHTML, /HANDOFF/);
  assert.match(page.innerHTML, /Sessions with a handoff \(33%\)/);
  assert.match(page.innerHTML, /Handoff landing pages/);
  assert.match(page.innerHTML, /CONTEXT ROI/);
  assert.match(page.innerHTML, /3 decisions · 2 outcomes · 1 conversions/);
  assert.match(page.innerHTML, /AGENT MIX/);
  assert.match(page.innerHTML, /Claude/);
  assert.match(page.innerHTML, /Result position views/);
  assert.match(page.innerHTML, /Position 1/);
  assert.match(page.innerHTML, /Unknown dimensions/);
  assert.match(page.innerHTML, /Unanswered questions/);
});

test("the Home overview renders safe empty states when new insight groups are absent", async () => {
  const { page } = await loadDashboard({
    href: "https://app.epode.ai/",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        const legacy = structuredClone(dashboard);
        delete legacy.insights.lostDemand;
        delete legacy.insights.journeyFlow;
        delete legacy.insights.handoff;
        delete legacy.insights.signalOutcomes;
        delete legacy.insights.agentVendors;
        delete legacy.insights.rankPositions;
        delete legacy.insights.unknownDimensions;
        delete legacy.insights.unansweredQuestions;
        return legacy;
      },
    }),
  });
  assert.match(page.innerHTML, /LOST DEMAND/);
  assert.match(page.innerHTML, /No expressed dimensions yet\./);
  assert.match(page.innerHTML, /Transitions appear when journeys carry a session reference\./);
  assert.match(page.innerHTML, /No personalization decisions cited customer signals yet\./);
  assert.match(page.innerHTML, /Runtime evidence has not named an assistant yet\./);
});
