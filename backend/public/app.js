const page = document.querySelector("#page");
const notice = document.querySelector("#notice");
const account = document.querySelector("#account");
const productScope = document.querySelector("#product-scope");
let dashboard;
let currentView = new URL(location.href).searchParams.get("view") || "feedback";
let selectedWorkspaceId = new URL(location.href).searchParams.get("team") || "";
let selectedProductId = new URL(location.href).searchParams.get("product") || "";
let selectedOutcome = null;
let selectedInteraction = null;
let selectedSession = null;
let showingLegacy = false;
let apiSecret = "";
let setupSurface = "mcp";
let setupStack = "node-mcp";
let setupConnectionId = null;
let setupInstallMode = "agent";
let setupMonitor = null;
let latestInviteLink = "";

function setupSecretKey(environmentId) {
  return `agent-feedback:product-key:${environmentId}`;
}

function rememberSetupSecret(environmentId, secret) {
  if (!environmentId || !secret) return;
  try {
    sessionStorage.setItem(setupSecretKey(environmentId), secret);
  } catch {
    // A private browsing policy may disable storage. The key still remains visible for this page load.
  }
}

function recalledSetupSecret(environmentId) {
  if (!environmentId) return "";
  try {
    return sessionStorage.getItem(setupSecretKey(environmentId)) || "";
  } catch {
    return "";
  }
}

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const date = (value) => value ? new Date(value).toLocaleString() : "—";
const title = (value) => String(value || "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const setNotice = (message) => { notice.textContent = message; notice.hidden = !message; };
const outcomeClass = (value) => value === "success" ? "positive" : value === "failure" ? "negative" : "neutral";
const customer = (value) => value ? `Customer ${value}` : "Customer not linked";

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (dashboard?.workspace?.id && path.startsWith("/api/")) {
    headers.set("x-workspace-id", dashboard.workspace.id);
  }
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.assign("/");
    throw new Error("Authentication required");
  }
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

async function refresh() {
  const query = new URLSearchParams();
  if (selectedWorkspaceId) query.set("workspaceId", selectedWorkspaceId);
  if (selectedProductId) query.set("productId", selectedProductId);
  dashboard = await request(`/api/dashboard${query.size ? `?${query}` : ""}`);
  selectedWorkspaceId = dashboard.workspace.id;
  selectedProductId = dashboard.currentProduct?.id || "";
  if (dashboard.currentRole === "member" && ["setup", "policy", "new-product"].includes(currentView)) {
    currentView = "feedback";
  }
  if (currentView === "setup" && dashboard.currentRole !== "member" && dashboard.currentEnvironment && !dashboard.apiKeys.length) {
    const body = await request("/api/settings/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Default product key", environmentId: dashboard.currentEnvironment.id }),
    });
    apiSecret = body.secret;
    setupConnectionId = body.apiKey.id;
    rememberSetupSecret(dashboard.currentEnvironment.id, body.secret);
    dashboard = await request(`/api/dashboard?environmentId=${encodeURIComponent(dashboard.currentEnvironment.id)}`);
  }
  const setupKey = dashboard.apiKeys.find((key) => key.id === setupConnectionId) || dashboard.apiKeys[0];
  if (setupKey) {
    setupConnectionId = setupKey.id;
    apiSecret = apiSecret || recalledSetupSecret(dashboard.currentEnvironment.id);
  } else {
    setupConnectionId = null;
    apiSecret = "";
  }
  const identity = `@${dashboard.user.handle}${dashboard.user.email ? ` · ${dashboard.user.email}` : ""}`;
  account.innerHTML = `<strong>${esc(dashboard.user.displayName)}</strong><small>${esc(identity)}</small><small>${esc(title(dashboard.currentRole))} · ${esc(dashboard.workspace.name)}</small>`;
  renderProductScope();
  document.querySelectorAll("[data-editor-only]").forEach((element) => {
    element.hidden = dashboard.currentRole === "member";
  });
  const url = new URL(location.href);
  url.searchParams.set("team", selectedWorkspaceId);
  if (selectedProductId) url.searchParams.set("product", selectedProductId);
  else url.searchParams.delete("product");
  url.searchParams.delete("environment");
  history.replaceState({}, "", url);
  if (url.searchParams.get("invite") === "invalid") {
    url.searchParams.delete("invite");
    history.replaceState({}, "", url);
    setNotice("That invitation is expired, revoked, or belongs to a different OS Account.");
  }
  render();
}

function renderProductScope() {
  const workspaceOptions = dashboard.workspaceMemberships.map((entry) => `<option value="${esc(entry.workspaceId)}" ${entry.workspaceId === dashboard.workspace.id ? "selected" : ""}>${esc(entry.workspaceName)}</option>`).join("");
  const teamSelect = `<label><span>Team</span><select id="workspace-select">${workspaceOptions}</select></label>`;
  const canEdit = dashboard.currentRole === "owner" || dashboard.currentRole === "admin";
  if (!dashboard.products.length) {
    productScope.innerHTML = `${teamSelect}<p class="eyebrow">PRODUCT</p>${canEdit ? `<button class="scope-empty" data-new-product>Create your first product</button>` : `<small>No product has been created yet.</small>`}`;
    return;
  }
  const product = dashboard.currentProduct;
  const productOptions = dashboard.products.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === product?.id ? "selected" : ""}>${esc(entry.name)}</option>`).join("");
  productScope.innerHTML = `${teamSelect}<label><span>Product</span><select id="product-select">${productOptions}</select></label>${canEdit ? `<button class="link-button" data-new-product>+ New product</button>` : ""}`;
}

function navigate(view) {
  currentView = view;
  selectedOutcome = null;
  selectedInteraction = null;
  selectedSession = null;
  const url = new URL(location.href);
  url.searchParams.set("view", view);
  history.pushState({}, "", url);
  render();
}

function header(kicker, heading, meta = "", extra = "") {
  return `<header><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(heading)}</h1></div><div class="header-actions">${extra}<span>${esc(meta)}</span></div></header>`;
}

function empty(heading, copy, view = "setup") {
  return `<div class="empty"><h2>${esc(heading)}</h2><p>${esc(copy)}</p><button class="button primary" data-view="${esc(view)}">Go to ${esc(view)}</button></div>`;
}

function feedbackView() {
  if (showingLegacy) return legacyFeedbackView();
  const item = dashboard.outcomes.find((entry) => entry.id === selectedOutcome);
  const toggle = `<button class="button" data-toggle-legacy>View legacy prototype data</button>`;
  if (item) {
    return `${header("FEEDBACK DETAIL", title(item.outcome), date(item.createdAt))}<button class="back" data-back="feedback">← All feedback</button><div class="detail-grid">
      <article><h2>Agent review</h2><p class="quote">“${esc(item.note)}”</p></article>
      <article><h2>Product interaction</h2><p><strong>${esc(item.operation)}</strong></p><small>${esc(title(item.surface))} · ${esc(customer(item.customerRef))}</small></article>
      <article><h2>What we know</h2><dl><dt>Classification</dt><dd>${esc(title(item.classification))}</dd><dt>Confirmation</dt><dd>${esc(title(item.confirmationMethod || "none"))}</dd><dt>Runtime hint</dt><dd>${esc(item.runtimeHint || "Not provided")}</dd><dt>Agent identity</dt><dd>Not collected</dd></dl></article>
      <button class="linked" data-open-interaction="${esc(item.interactionId)}">Open linked interaction →</button></div>`;
  }
  const rows = dashboard.outcomes.map((entry) => `<button class="list-row" data-outcome="${esc(entry.id)}"><b class="${outcomeClass(entry.outcome)}">${esc(entry.outcome.toUpperCase())}</b><span><strong>${esc(entry.note)}</strong><small>${esc(entry.operation)} · ${esc(title(entry.surface))} · ${esc(customer(entry.customerRef))}</small></span><time>${date(entry.createdAt)}</time></button>`).join("");
  return `${header("FEEDBACK", "Product outcomes", `${dashboard.outcomes.length} reviews`, toggle)}${rows ? `<div class="list">${rows}</div>` : empty("No feedback yet", "Install the SDK on an agent-usable product route, then run the integration doctor.")}`;
}

function legacyFeedbackView() {
  const item = dashboard.legacyFeedback.find((entry) => entry.id === selectedOutcome);
  const toggle = `<button class="button" data-toggle-legacy>Back to v2 feedback</button>`;
  if (item) {
    return `${header("LEGACY FEEDBACK", item.worked ? "Worked" : "Failed", date(item.createdAt), toggle)}<button class="back" data-back="feedback">← Legacy feedback</button><div class="detail-grid"><article><h2>Prototype review</h2><p class="quote">“${esc(item.summary)}”</p></article><article><h2>Legacy record</h2><p>${esc(item.task)}</p><small>Excluded from v2 metrics</small></article></div>`;
  }
  const rows = dashboard.legacyFeedback.map((entry) => `<button class="list-row" data-outcome="${esc(entry.id)}"><b class="${entry.worked ? "positive" : "negative"}">${entry.worked ? "WORKED" : "FAILED"}</b><span><strong>${esc(entry.summary)}</strong><small>${esc(entry.task)} · legacy prototype</small></span><time>${date(entry.createdAt)}</time></button>`).join("");
  return `${header("LEGACY FEEDBACK", "Prototype records", `${dashboard.legacyFeedback.length} reviews`, toggle)}<p class="muted">These records are preserved but excluded from v2 metrics.</p>${rows ? `<div class="list">${rows}</div>` : empty("No legacy feedback", "There are no prototype records in this workspace.", "feedback")}`;
}

function insightsView() {
  const table = (rows, fallback) => rows.length ? `<table><tbody>${rows.map((row) => `<tr><td>${esc(title(row.name))}</td><td>${row.count}</td></tr>`).join("")}</tbody></table>` : `<p>${esc(fallback)}</p>`;
  const insights = dashboard.insights;
  return `${header("INSIGHTS", "How agents experience your product")}<div class="metrics five"><article><strong>${insights.opportunities}</strong><span>Opportunities delivered</span></article><article><strong>${insights.confirmedInteractions}</strong><span>Confirmed agent interactions</span></article><article><strong>${insights.confirmationRate}%</strong><span>Confirmation rate</span></article><article><strong>${insights.reviewRate}%</strong><span>Review rate</span></article><article><strong>${insights.outcomeSuccessRate}%</strong><span>Outcome success rate</span></article></div><div class="three-col"><article><h2>Operations</h2>${table(insights.topOperations, "No operations yet.")}</article><article><h2>Product surfaces</h2>${table(insights.surfaces, "No surface data yet.")}</article><article><h2>Outcomes</h2>${table(insights.outcomes, "No reviews yet.")}</article></div><section class="explanation"><h2>How these numbers work</h2><p>HTTP responses begin as opportunities—not assumed agent traffic. A submitted review confirms the interaction. MCP tool calls are confirmed immediately because the protocol proves a tool-capable client used them.</p></section>`;
}

function interactionsView() {
  const interaction = dashboard.interactions.find((entry) => entry.id === selectedInteraction);
  if (interaction) {
    const linked = dashboard.outcomes.find((entry) => entry.interactionId === interaction.id);
    return `${header("INTERACTION DETAIL", interaction.operation, title(interaction.classification))}<button class="back" data-back="interactions">← All interactions</button><dl class="session-meta"><div><dt>Surface</dt><dd>${esc(title(interaction.surface))}</dd></div><div><dt>Status</dt><dd>${esc(interaction.statusCode || "—")}</dd></div><div><dt>Duration</dt><dd>${interaction.durationMs == null ? "—" : `${interaction.durationMs}ms`}</dd></div><div><dt>Customer</dt><dd>${esc(interaction.customerRef || "Not linked")}</dd></div><div><dt>Agent</dt><dd>Not identified</dd></div></dl><div class="detail-grid"><article><h2>Evidence</h2><dl><dt>Classification</dt><dd>${esc(title(interaction.classification))}</dd><dt>Confirmation method</dt><dd>${esc(title(interaction.confirmationMethod || "none"))}</dd><dt>Runtime hint</dt><dd>${esc(interaction.runtimeHint || "Not provided")}</dd><dt>Occurred</dt><dd>${date(interaction.occurredAt)}</dd></dl></article><article><h2>Outcome</h2>${linked ? `<p class="quote">“${esc(linked.note)}”</p><b class="${outcomeClass(linked.outcome)}">${esc(linked.outcome.toUpperCase())}</b>` : "<p>No review was submitted for this opportunity.</p>"}</article></div>`;
  }
  const rows = dashboard.interactions.map((entry) => `<button class="list-row" data-interaction="${esc(entry.id)}"><b class="${entry.classification === "confirmed" ? "positive" : "neutral"}">${esc(entry.classification.toUpperCase())}</b><span><strong>${esc(entry.operation)}</strong><small>${esc(title(entry.surface))} · ${esc(customer(entry.customerRef))}${entry.statusCode ? ` · HTTP ${entry.statusCode}` : ""}</small></span><time>${date(entry.occurredAt)}</time></button>`).join("");
  return `${header("INTERACTIONS", "Product responses and tool uses", `${dashboard.interactions.length} interactions`)}${rows ? `<div class="list">${rows}</div>` : empty("No interactions yet", "Install the SDK and use one configured product route.")}`;
}

function sessionsView() {
  const session = dashboard.sessions.find((entry) => entry.id === selectedSession);
  if (session) {
    const interactions = dashboard.interactions.filter((entry) => entry.sessionId === session.id);
    const rows = interactions.map((entry) => `<button class="list-row" data-interaction="${esc(entry.id)}"><b>${esc(title(entry.classification))}</b><span><strong>${esc(entry.operation)}</strong><small>${esc(title(entry.surface))}</small></span><time>${date(entry.occurredAt)}</time></button>`).join("");
    return `${header("SESSION DETAIL", `Session ${session.refHint}…`, `${interactions.length} interactions`)}<button class="back" data-back="sessions">← All sessions</button><dl class="session-meta"><div><dt>Proof source</dt><dd>${esc(title(session.source))}</dd></div><div><dt>Started</dt><dd>${date(session.startedAt)}</dd></div><div><dt>Last seen</dt><dd>${date(session.lastSeenAt)}</dd></div></dl><div class="list">${rows}</div>`;
  }
  const rows = dashboard.sessions.map((entry) => `<button class="list-row" data-session="${esc(entry.id)}"><b>${esc(title(entry.source))}</b><span><strong>${esc(entry.refHint)}…</strong><small>Proof-based grouping; never inferred by time or identity</small></span><time>${date(entry.lastSeenAt)}</time></button>`).join("");
  return `${header("SESSIONS", "Optional proven continuity", `${dashboard.sessions.length} sessions`)}<p class="muted">Sessions exist only when your product supplies a session reference or MCP provides protocol continuity. We never guess that two interactions came from the same agent.</p>${rows ? `<div class="list">${rows}</div>` : empty("No proven sessions", "This is normal. Every interaction and review works without a session.", "interactions")}`;
}

const setupSurfaceCopy = {
  mcp: {
    name: "MCP server",
    summary: "Reliable, protocol-backed feedback",
    detail: "We register an explicit feedback tool. A tool call is a confirmed agent interaction.",
  },
  api: {
    name: "HTTP API",
    summary: "Add feedback instructions to selected responses",
    detail: "Each response begins as an opportunity. It becomes confirmed when its receipt returns with feedback.",
  },
  website: {
    name: "Server-rendered website",
    summary: "HTML returned by your app server",
    detail: "The server injects machine-readable feedback instructions without exposing your private key in browser code.",
  },
  static: {
    name: "Static site or CMS",
    summary: "Edge integration coming soon",
    detail: "Static and no-code sites need a server or edge adapter because a private product key cannot live in browser JavaScript.",
    disabled: true,
  },
};

const setupStackOptions = {
  mcp: [
    ["node-mcp", "Node MCP", "Registers and handles the outcome tool automatically."],
    ["manual-mcp", "Another MCP stack", "Implement the small public protocol in any language."],
  ],
  api: [
    ["node-express", "Node · Express", "One global middleware."],
    ["node-fastify", "Node · Fastify", "One registered plugin."],
    ["python-asgi", "Python · ASGI", "FastAPI, Starlette, Quart, or Django ASGI."],
    ["python-wsgi", "Python · WSGI", "Flask, Django WSGI, Bottle, or Pyramid."],
    ["go", "Go", "Standard net/http middleware."],
    ["rust", "Rust", "Axum and Tower layer."],
    ["manual-http", "Another stack", "Use the language-neutral HTTP protocol."],
  ],
  website: [
    ["node-express", "Node · Express", "Injects instructions into eligible HTML."],
    ["node-fastify", "Node · Fastify", "Injects instructions into eligible HTML."],
    ["python-asgi", "Python · ASGI", "FastAPI, Starlette, Quart, or Django ASGI."],
    ["python-wsgi", "Python · WSGI", "Flask, Django WSGI, Bottle, or Pyramid."],
    ["go", "Go", "Standard net/http middleware."],
    ["rust", "Rust", "Axum and Tower layer."],
    ["manual-http", "Another stack", "Use the language-neutral HTML protocol."],
  ],
};

function setupInstructions() {
  const artifacts = `${location.origin}/static`;
  const route = setupSurface === "website" ? "/docs/*" : "/search";
  const nodeInstall = `npm install ${artifacts}/agent-feedback-node-0.1.0.tgz`;
  const environment = `AGENT_FEEDBACK_KEY=${apiSecret || "paste_product_key_here"}`;
  const instructions = {
    "node-mcp": {
      name: "Node MCP",
      install: nodeInstall,
      code: `import { instrumentMcp } from "@agent-feedback/node/mcp";\n\ninstrumentMcp(server, {\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n});`,
      verify: "Call one of your MCP server's normal tools from an agent client.",
    },
    "manual-mcp": {
      name: "Language-neutral MCP protocol",
      install: `curl -O ${artifacts}/agent-feedback-protocol-v1.zip`,
      code: `1. Emit confirmed telemetry for each business tool call.\n2. Add _agentFeedback to the business tool result.\n3. Register report_product_outcome.\n4. Submit only outcome + note with the scoped capability.`,
      verify: "Call a normal tool and confirm the registered outcome tool is visible to the agent.",
    },
    "node-express": {
      name: "Node · Express",
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/express";\n\napp.use(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"],\n}));`,
      advanced: `customerRef: req => req.user?.accountId // optional opaque ID`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "node-fastify": {
      name: "Node · Fastify",
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/fastify";\n\nawait app.register(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"],\n}));`,
      advanced: `customerRef: req => req.user?.accountId // optional opaque ID`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-asgi": {
      name: "Python · ASGI",
      install: `pip install ${artifacts}/agent_feedback-0.1.0-py3-none-any.whl`,
      code: `from agent_feedback import AgentFeedbackASGI\n\napp = AgentFeedbackASGI(\n    app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),\n)`,
      advanced: `customer_ref=lambda scope: scope.get("account_id") # optional opaque ID`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-wsgi": {
      name: "Python · WSGI",
      install: `pip install ${artifacts}/agent_feedback-0.1.0-py3-none-any.whl`,
      code: `from agent_feedback import AgentFeedbackWSGI\n\napp.wsgi_app = AgentFeedbackWSGI(\n    app.wsgi_app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),\n)`,
      advanced: `customer_ref=lambda environ: environ.get("account_id") # optional opaque ID`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    go: {
      name: "Go · net/http",
      install: `go get github.com/open-software-network/os-epode/sdk/go@latest`,
      code: `feedback, err := agentfeedback.New(agentfeedback.Options{\n    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),\n    Include: []string{"${route}"},\n})\nif err != nil { log.Fatal(err) }\ndefer feedback.Shutdown(context.Background())\n\nhandler := feedback.Middleware(router)`,
      advanced: `CustomerRef: func(r *http.Request) string { return accountID(r.Context()) }`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    rust: {
      name: "Rust · Axum/Tower",
      install: `mkdir -p vendor/agent-feedback-rust\ncurl -fsSL ${artifacts}/agent-feedback-rust-0.1.0.tar.gz | tar -xz -C vendor/agent-feedback-rust`,
      code: `// Cargo.toml: agent-feedback = { path = "vendor/agent-feedback-rust" }\nlet feedback = AgentFeedbackLayer::new(\n    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)\n        .include(["${route}"]),\n)?;\n\nlet app = router.layer(feedback);`,
      advanced: `.customer_ref(|request| authenticated_account_id(request)) // optional opaque ID`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "manual-http": {
      name: "Language-neutral HTTP protocol",
      install: `curl -O ${artifacts}/agent-feedback-protocol-v1.zip`,
      code: `GET ${location.origin}/.well-known/agent-feedback-v1.json\n\n1. Sign a two-hour capability locally.\n2. Add the feedback envelope to eligible 2xx responses.\n3. Queue opportunity telemetry without blocking the response.`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")} and inspect _agentFeedback or the Agent-Feedback header.`,
    },
  };
  return { ...instructions[setupStack], environment };
}

function setupConnectionStatus(apiKeyId) {
  const interactions = dashboard.interactions.filter((entry) => entry.apiKeyId === apiKeyId);
  const interactionIds = new Set(interactions.map((entry) => entry.id));
  const outcomes = dashboard.outcomes.filter((entry) => interactionIds.has(entry.interactionId));
  return { interactions, outcomes, firstInteraction: interactions.at(-1) || interactions[0] };
}

function setupAgentPrompt(integration) {
  const surface = setupSurfaceCopy[setupSurface];
  return `Add Agent Feedback to this repository.\n\nProduct surface: ${surface.name}\nIntegration: ${integration.name}\n\nRequirements:\n- Use AGENT_FEEDBACK_KEY from the server environment. It is already configured; never print or expose it.\n- Install the official package with: ${integration.install}\n- Configure the integration once using this reference:\n\n${integration.code}\n\n- For HTTP or HTML, change include routes in code to only the product surfaces used by customer agents.\n- Do not put the product key in browser JavaScript.\n- Do not change existing response shapes, error handling, streams, or binary responses.\n- Start the product and make one real request or MCP tool call so the connection can be verified.\n\nProtocol: ${location.origin}/.well-known/agent-feedback-v1.json`;
}

function productCreateView(firstProduct = false) {
  const heading = firstProduct ? "Create your first product" : "Create a product";
  const copy = firstProduct ? "Products keep feedback and interactions separate. Start with the product your customers' agents use." : "The new product gets its own integration, interactions, feedback, and insights.";
  return `${header(firstProduct ? "WELCOME" : "NEW PRODUCT", heading)}<section class="create-product"><p>${esc(copy)}</p><form id="product-form"><label><span>Product name</span><input name="name" placeholder="Search" maxlength="80" required autofocus></label><button class="button primary">Create product</button></form>${firstProduct ? "" : `<button class="back" data-view="feedback">← Cancel</button>`}</section>`;
}

function setupView() {
  const surface = setupSurfaceCopy[setupSurface];
  const integration = setupInstructions();
  const setupKey = dashboard.apiKeys.find((key) => key.id === setupConnectionId) || dashboard.apiKeys[0];
  const status = setupConnectionId ? setupConnectionStatus(setupConnectionId) : { interactions: [], outcomes: [] };
  const connected = status.interactions.length > 0;
  const reviewed = status.outcomes.length > 0;
  const stacks = setupStackOptions[setupSurface].map(([id, name, copy]) => `<button class="choice-card" data-setup-stack="${esc(id)}" aria-pressed="${setupStack === id}"><strong>${esc(name)}</strong><span>${esc(copy)}</span></button>`).join("");
  const surfaces = Object.entries(setupSurfaceCopy).map(([id, item]) => `<button class="choice-card surface-card" data-setup-surface="${esc(id)}" aria-pressed="${setupSurface === id}" ${item.disabled ? "disabled" : ""}><strong>${esc(item.name)}</strong><span>${esc(item.summary)}</span>${item.disabled ? "<small>COMING SOON</small>" : ""}</button>`).join("");
  const ready = `<div class="connection-created"><b>Installation ready</b><span>${setupKey ? `${esc(setupKey.prefix)}…` : "Preparing the product key…"}</span></div>`;
  const secret = apiSecret ? `<div class="secret-callout"><div><b>Save this server-side key now</b><code>${esc(apiSecret)}</code><small>It was created automatically for this product. Customer agents never receive it.</small></div><button class="button" data-copy="${esc(apiSecret)}">Copy key</button></div>` : `<div class="secret-callout"><div><b>Server-side key ready</b><code>${setupKey ? `${esc(setupKey.prefix)}…` : "Preparing…"}</code><small>Use the value already saved in your server configuration. If it is unavailable, rotate the key below.</small></div></div>`;
  const agentPrompt = setupAgentPrompt(integration);
  const installMode = `<div class="install-methods"><button data-install-mode="agent" aria-pressed="${setupInstallMode === "agent"}">Use a coding agent</button><button data-install-mode="manual" aria-pressed="${setupInstallMode === "manual"}">Manual setup</button></div>`;
  const agentInstall = `<div class="install-panel"><p>Copy this prompt into the coding agent that has access to your product repository. It receives the exact integration and verification requirements, but never the product key.</p><div class="copy-block"><pre><code>${esc(agentPrompt)}</code></pre><button class="button primary" data-copy="${esc(agentPrompt)}">Copy setup prompt</button></div></div>`;
  const manualInstall = `<div class="install-panel"><h3>Install</h3><div class="copy-block"><pre><code>${esc(integration.install)}</code></pre><button class="button" data-copy="${esc(integration.install)}">Copy</button></div><h3>Configure once</h3><div class="copy-block"><pre><code>${esc(integration.code)}</code></pre><button class="button" data-copy="${esc(integration.code)}">Copy</button></div>${integration.advanced ? `<details><summary>Optional customer grouping</summary><p>Use an opaque account ID from authentication your product already has. Do not send names or emails.</p><pre><code>${esc(integration.advanced)}</code></pre></details>` : ""}</div>`;
  const installStep = `<section class="setup-step"><div class="step-number">2</div><div class="step-body"><p class="eyebrow">INSTALL</p><h2>Install ${esc(integration.name)}</h2><p>Your installation is ready. Use the guided agent setup or copy the commands yourself. Your product response never waits for Agent Feedback.</p>${secret}<h3>Set the server environment variable</h3><div class="copy-block"><pre><code>${esc(integration.environment)}</code></pre><button class="button" data-copy="${esc(integration.environment)}">Copy</button></div>${installMode}${setupInstallMode === "agent" ? agentInstall : manualInstall}<a class="text-link" href="/.well-known/agent-feedback-v1.json" target="_blank" rel="noreferrer">Read the protocol contract →</a></div></section>`;
  const surfaceResult = setupSurface === "mcp" ? "A normal MCP tool call will appear as a confirmed interaction." : "A successful response will appear as an opportunity. It becomes confirmed if the agent submits feedback.";
  const verifyStep = `<section class="setup-step"><div class="step-number">3</div><div class="step-body"><p class="eyebrow">VERIFY</p><h2>Send one real interaction</h2><p>${esc(integration.verify)}</p><p>${esc(surfaceResult)}</p><div class="verification"><div class="verification-row ${connected ? "complete" : "waiting"}"><b>${connected ? "✓" : "○"}</b><span><strong>${connected ? (setupSurface === "mcp" ? "Confirmed interaction received" : "Product connection works") : "Waiting for the first interaction"}</strong><small>${connected ? `${status.interactions.length} interaction${status.interactions.length === 1 ? "" : "s"} received for this product.` : "This page checks automatically every few seconds."}</small></span></div><div class="verification-row ${reviewed ? "complete" : "waiting"}"><b>${reviewed ? "✓" : "○"}</b><span><strong>${reviewed ? "Agent feedback received" : "Waiting for agent feedback"}</strong><small>${reviewed ? `${status.outcomes.length} compact review${status.outcomes.length === 1 ? "" : "s"} received.` : "Feedback is a second milestone. The integration works as soon as the first interaction arrives."}</small></span></div></div><div class="setup-actions"><button class="button" data-refresh-setup>Check now</button>${connected ? `<button class="button primary" data-view="interactions">View first interaction</button>` : ""}${reviewed ? `<button class="button primary" data-view="feedback">View feedback</button>` : ""}</div></div></section>`;
  const connections = dashboard.apiKeys.map((key) => {
    const keyStatus = setupConnectionStatus(key.id);
    const state = keyStatus.outcomes.length ? "Feedback received" : keyStatus.interactions.length ? "Connected" : "Never seen";
    return `<div class="connection-row"><span><strong>${esc(key.label)}</strong><small>${esc(key.prefix)}… · created ${date(key.createdAt)}</small></span><b class="${keyStatus.interactions.length ? "positive" : "neutral"}">${esc(state)}</b><button class="link-button" data-revoke-key="${esc(key.id)}">Rotate key</button></div>`;
  }).join("") || `<p class="muted">No integrations yet.</p>`;
  return `${header("SETUP", `Connect ${dashboard.currentProduct.name}`)}<p class="setup-lede">Choose your stack, copy the ready installation, and send the first real interaction.</p><section class="setup-step"><div class="step-number">1</div><div class="step-body"><p class="eyebrow">INTEGRATION</p><h2>Choose how your product is served</h2><div class="choice-grid surfaces">${surfaces}</div><p class="selection-explanation"><strong>${esc(surface.name)}:</strong> ${esc(surface.detail)}</p><h3>Choose the integration</h3><div class="choice-grid stacks">${stacks}</div><p class="muted">For HTTP and HTML, choose which routes receive instructions in code—not in this dashboard.</p>${ready}</div></section>${installStep}${verifyStep}<details class="existing-connections"><summary>Product keys (${dashboard.apiKeys.length})</summary><div>${connections}</div></details>`;
}

function teamView() {
  const isOwner = dashboard.currentRole === "owner";
  const isAdmin = dashboard.currentRole === "admin";
  const canInvite = isOwner || isAdmin;
  const inviteResult = latestInviteLink ? `<div class="secret-callout"><div><b>Invitation ready to share</b><code>${esc(latestInviteLink)}</code><small>The invitation is limited to the matching OS Account and expires in seven days.</small></div><button class="button" data-copy="${esc(latestInviteLink)}">Copy link</button></div>` : "";
  const roleOptions = (role) => `<option value="member" ${role === "member" ? "selected" : ""}>Member</option><option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>`;
  const memberRows = dashboard.teamMembers.map((member) => {
    const isSelf = member.osUserId === dashboard.user.id;
    const canRemove = !isSelf && member.role !== "owner" && (isOwner || (isAdmin && member.role === "member"));
    const roleControl = isOwner && member.role !== "owner" ? `<select class="compact-select" data-member-role="${esc(member.osUserId)}" aria-label="Role for ${esc(member.displayName)}">${roleOptions(member.role)}</select>` : `<b>${esc(title(member.role))}</b>`;
    return `<div class="team-row"><span><strong>${esc(member.displayName)}${isSelf ? " (you)" : ""}</strong><small>@${esc(member.handle)}${member.email ? ` · ${esc(member.email)}` : ""}</small></span>${roleControl}<span>${canRemove ? `<button class="link-button danger" data-remove-member="${esc(member.osUserId)}">Remove</button>` : ""}</span></div>`;
  }).join("");
  const invitationRows = dashboard.teamInvitations.map((invitation) => {
    const link = `${location.origin}/join/${invitation.id}`;
    const canRevoke = isOwner || (isAdmin && invitation.role === "member");
    return `<div class="team-row"><span><strong>${invitation.inviteeKind === "handle" ? "@" : ""}${esc(invitation.inviteeValue)}</strong><small>Invited as ${esc(invitation.role)} · expires ${date(invitation.expiresAt)}</small></span><button class="link-button" data-copy="${esc(link)}">Copy link</button><span>${canRevoke ? `<button class="link-button danger" data-revoke-invitation="${esc(invitation.id)}">Revoke</button>` : ""}</span></div>`;
  }).join("");
  const inviteForm = canInvite ? `<section class="team-invite"><h2>Invite a teammate</h2><p>Enter the email or @handle on their OS Account. Share the generated link; their identity is verified when they sign in.</p><form id="team-invite-form"><label><span>OS Account email or handle</span><input name="invitee" placeholder="teammate@example.com or @teammate" maxlength="160" required></label><label><span>Role</span><select name="role">${isOwner ? `<option value="admin">Admin</option>` : ""}<option value="member" selected>Member</option></select></label><button class="button primary">Create invitation</button></form>${inviteResult}</section>` : `<p class="muted">Your ${esc(dashboard.currentRole)} role can view this team. An owner or admin manages membership.</p>`;
  return `${header("TEAM", dashboard.workspace.name, `${dashboard.teamMembers.length} member${dashboard.teamMembers.length === 1 ? "" : "s"}`)}<div class="role-guide"><article><h2>Owner</h2><p>Full product, team, and role control.</p></article><article><h2>Admin</h2><p>Manages products and can invite or remove members.</p></article><article><h2>Member</h2><p>Can view feedback, interactions, sessions, and insights.</p></article></div>${inviteForm}<section class="team-section"><h2>Members</h2><div class="team-list">${memberRows}</div></section>${canInvite ? `<section class="team-section"><h2>Pending invitations</h2>${invitationRows ? `<div class="team-list">${invitationRows}</div>` : `<p class="muted">No pending invitations.</p>`}</section>` : ""}`;
}

function policyView() {
  const settings = dashboard.currentEnvironment;
  return `${header("COLLECTION POLICY", "Control outcome collection", dashboard.currentProduct.name)}<form id="policy-form" class="policy"><label><span>Feedback mode</span><select name="feedbackMode"><option value="auto" ${settings.feedbackMode === "auto" ? "selected" : ""}>Auto — ask the agent to submit autonomously</option><option value="ask" ${settings.feedbackMode === "ask" ? "selected" : ""}>Ask — make outcome submission optional</option><option value="off" ${settings.feedbackMode === "off" ? "selected" : ""}>Off — reject outcome submissions</option></select></label><label><span>Retention</span><select name="retentionDays">${[7, 30, 90, 365].map((days) => `<option value="${days}" ${settings.retentionDays === days ? "selected" : ""}>${days} days</option>`).join("")}</select></label><input type="hidden" name="collectEventSummaries" value="off"><div class="guardrails"><h2>Always rejected</h2><ul><li>Prompts and transcripts</li><li>Secrets and authentication payloads</li><li>Personal data and raw customer content</li><li>Raw tool inputs or outputs</li><li>Unknown review fields</li></ul></div><button class="button primary">Save policy</button></form>`;
}

function render() {
  if (!dashboard) return;
  document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-current", button.dataset.view === currentView ? "page" : "false"));
  if (!dashboard.products.length && !["team", "new-product"].includes(currentView)) {
    page.innerHTML = dashboard.currentRole === "member" ? empty("No product yet", "An owner or admin needs to create the first product.", "team") : productCreateView(true);
  } else {
    page.innerHTML = ({ feedback: feedbackView, insights: insightsView, interactions: interactionsView, sessions: sessionsView, setup: setupView, policy: policyView, team: teamView, "new-product": productCreateView }[currentView] || feedbackView)();
  }
  if (currentView !== "setup" || !setupConnectionId || setupConnectionStatus(setupConnectionId).outcomes.length) {
    clearInterval(setupMonitor);
    setupMonitor = null;
  } else if (!setupMonitor) {
    setupMonitor = setInterval(async () => {
      try {
        await refresh();
      } catch {
        clearInterval(setupMonitor);
        setupMonitor = null;
      }
    }, 5000);
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.view) {
      navigate(target.dataset.view);
      if (target.dataset.view === "setup") await refresh();
    }
    if (target.hasAttribute("data-new-product")) navigate("new-product");
    if (target.dataset.setupSurface) {
      setupSurface = target.dataset.setupSurface;
      setupStack = setupStackOptions[setupSurface][0][0];
      render();
    }
    if (target.dataset.setupStack) {
      setupStack = target.dataset.setupStack;
      render();
    }
    if (target.dataset.installMode) {
      setupInstallMode = target.dataset.installMode;
      render();
    }
    if (target.dataset.outcome) { selectedOutcome = target.dataset.outcome; render(); }
    if (target.dataset.interaction) { selectedInteraction = target.dataset.interaction; currentView = "interactions"; render(); }
    if (target.dataset.session) { selectedSession = target.dataset.session; render(); }
    if (target.dataset.back) { selectedOutcome = null; selectedInteraction = null; selectedSession = null; render(); }
    if (target.dataset.openInteraction) { currentView = "interactions"; selectedInteraction = target.dataset.openInteraction; render(); }
    if (target.hasAttribute("data-toggle-legacy")) { showingLegacy = !showingLegacy; selectedOutcome = null; render(); }
    if (target.dataset.copy) { await navigator.clipboard.writeText(target.dataset.copy); setNotice("Copied."); }
    if (target.hasAttribute("data-refresh-setup")) {
      await refresh();
      setNotice("Connection status refreshed.");
    }
    if (target.dataset.revokeKey) {
      await request(`/api/settings/api-keys/${target.dataset.revokeKey}`, { method: "DELETE" });
      const body = await request("/api/settings/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Default product key", environmentId: dashboard.currentEnvironment.id }),
      });
      apiSecret = body.secret;
      setupConnectionId = body.apiKey.id;
      rememberSetupSecret(dashboard.currentEnvironment.id, body.secret);
      await refresh();
      setNotice("Product key rotated. Save the new server-side key shown above.");
    }
    if (target.dataset.removeMember) {
      if (!confirm("Remove this member from the team?")) return;
      await request(`/api/team/members/${encodeURIComponent(target.dataset.removeMember)}`, { method: "DELETE" });
      await refresh();
      setNotice("Team member removed.");
    }
    if (target.dataset.revokeInvitation) {
      if (!confirm("Revoke this invitation?")) return;
      await request(`/api/team/invitations/${encodeURIComponent(target.dataset.revokeInvitation)}`, { method: "DELETE" });
      await refresh();
      setNotice("Invitation revoked.");
    }
  } catch (error) {
    setNotice(error.message || "Request failed");
  }
});

document.addEventListener("change", async (event) => {
  try {
    if (event.target.id === "workspace-select") {
      selectedWorkspaceId = event.target.value;
      selectedProductId = "";
      apiSecret = "";
      setupConnectionId = null;
      latestInviteLink = "";
      await refresh();
    }
    if (event.target.id === "product-select") {
      selectedProductId = event.target.value;
      apiSecret = "";
      setupConnectionId = null;
      await refresh();
    }
    if (event.target.dataset.memberRole) {
      await request(`/api/team/members/${encodeURIComponent(event.target.dataset.memberRole)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: event.target.value }),
      });
      await refresh();
      setNotice("Member role updated.");
    }
  } catch (error) {
    setNotice(error.message || "Could not switch product");
  }
});

document.addEventListener("submit", async (event) => {
  if (!["product-form", "policy-form", "team-invite-form"].includes(event.target.id)) return;
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    if (event.target.id === "product-form") {
      const body = await request("/api/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.get("name") }) });
      selectedProductId = body.product.id;
      apiSecret = body.secret || "";
      setupConnectionId = body.apiKey?.id || null;
      rememberSetupSecret(body.environment.id, body.secret);
      currentView = "setup";
      await refresh();
      navigate("setup");
      setNotice(`${body.product.name} created. Choose its first integration.`);
    }
    if (event.target.id === "policy-form") {
      await request("/api/settings/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environmentId: dashboard.currentEnvironment.id, feedbackMode: form.get("feedbackMode"), collectEventSummaries: false, retentionDays: Number(form.get("retentionDays")) }) });
      await refresh();
      setNotice("Collection policy saved for this product.");
    }
    if (event.target.id === "team-invite-form") {
      const body = await request("/api/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitee: form.get("invitee"), role: form.get("role") }),
      });
      latestInviteLink = `${location.origin}${body.joinPath}`;
      event.target.reset();
      await refresh();
      setNotice("Invitation created. Copy and share the invite link.");
    }
  } catch (error) {
    setNotice(error.message || "Request failed");
  }
});

document.querySelector("#signout").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.assign("/");
});
window.addEventListener("popstate", () => {
  const url = new URL(location.href);
  currentView = url.searchParams.get("view") || "feedback";
  selectedWorkspaceId = url.searchParams.get("team") || "";
  selectedProductId = url.searchParams.get("product") || "";
  refresh().catch(() => location.assign("/"));
});
refresh().catch(() => location.assign("/"));
