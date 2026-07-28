const page = document.querySelector("#page");
const notice = document.querySelector("#notice");
const account = document.querySelector("#account");
let dashboard;
let currentView = new URL(location.href).searchParams.get("view") || "feedback";
let selectedOutcome = null;
let selectedInteraction = null;
let selectedSession = null;
let showingLegacy = false;
let apiSecret = "";

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const date = (value) => value ? new Date(value).toLocaleString() : "—";
const title = (value) => String(value || "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const setNotice = (message) => { notice.textContent = message; notice.hidden = !message; };
const outcomeClass = (value) => value === "success" ? "positive" : value === "failure" ? "negative" : "neutral";
const customer = (value) => value ? `Customer ${value}` : "Customer not linked";

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.assign("/");
    throw new Error("Authentication required");
  }
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

async function refresh() {
  dashboard = await request("/api/dashboard");
  const identity = `@${dashboard.user.handle}${dashboard.user.email ? ` · ${dashboard.user.email}` : ""}`;
  account.innerHTML = `<strong>${esc(dashboard.user.displayName)}</strong><small>${esc(identity)}</small>`;
  render();
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

function setupView() {
  const artifacts = `${location.origin}/static`;
  const nodeInstall = `npm install ${artifacts}/agent-feedback-node-0.1.0.tgz`;
  const pythonInstall = `pip install ${artifacts}/agent_feedback-0.1.0-py3-none-any.whl`;
  const goInstall = `go get github.com/open-software-network/os-agent-feedback/sdk/go@latest`;
  const rustInstall = `mkdir -p vendor/agent-feedback-rust\ncurl -fsSL ${artifacts}/agent-feedback-rust-0.1.0.tar.gz | tar -xz -C vendor/agent-feedback-rust`;
  const expressCode = `import { agentFeedback } from "@agent-feedback/node/express";\n\napp.use(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["/search", "/docs/*"],\n  customerRef: req => req.user?.accountId, // optional\n}));`;
  const fastifyCode = `import { agentFeedback } from "@agent-feedback/node/fastify";\n\nawait app.register(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["/search", "/docs/*"],\n}));`;
  const pythonCode = `from agent_feedback import AgentFeedbackASGI\n\napp = AgentFeedbackASGI(\n    app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("/search", "/docs/*"),\n)`;
  const goCode = `feedback, _ := agentfeedback.New(agentfeedback.Options{\n    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),\n    Include: []string{"/search", "/docs/**"},\n})\nhandler := feedback.Middleware(router)`;
  const rustCode = `// Cargo.toml: agent-feedback = { path = "vendor/agent-feedback-rust" }\nlet feedback = AgentFeedbackLayer::new(\n    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)\n        .include(["/search", "/docs/**"]),\n)?;\nlet app = router.layer(feedback);`;
  const mcpCode = `import { instrumentMcp } from "@agent-feedback/node/mcp";\n\ninstrumentMcp(server, {\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n});`;
  const protocolCode = `GET ${location.origin}/.well-known/agent-feedback-v1.json\n\n# Language-neutral schemas and signing vector:\ncurl -O ${artifacts}/agent-feedback-protocol-v1.zip`;
  const doctor = `npx agent-feedback-doctor https://your-product.example/search?q=test`;
  const keys = dashboard.apiKeys.map((key) => `<div class="list-row"><b>${esc(key.label)}</b><span><code>${esc(key.prefix)}…</code><small>Last used: ${date(key.lastUsedAt)} · Expires: ${date(key.expiresAt)}</small></span><time>${date(key.createdAt)} <button class="link-button" data-revoke-key="${esc(key.id)}">Revoke</button></time></div>`).join("") || "<p>No product keys.</p>";
  const adapter = (name, install, code) => `<article><h3>${esc(name)}</h3><pre><code>${esc(install)}</code></pre><button class="button" data-copy="${esc(install)}">Copy install</button><pre><code>${esc(code)}</code></pre><button class="button" data-copy="${esc(code)}">Copy setup</button></article>`;
  return `${header("SETUP", "Instrument your product once")}
    <section class="identity-guide"><h2>One protocol—not one programming language</h2><p>Node, Python, Go, Rust, MCP, and manual HTTP adapters all create the same two-hour, write-only receipt locally. Your response never waits for Agent Feedback.</p><div class="identity-cards"><article><b>HTTP</b><p>Best-effort for generic agents; deterministic with a feedback-aware runtime.</p></article><article><b>MCP</b><p>Protocol-backed through an explicit outcome tool.</p></article><article><b>Identity</b><p>Never required or claimed.</p></article></div></section>
    <ol class="steps">
      <li><div><h2>1. Create a private v2 product key</h2><p>Every language signs the same receipt locally. The key stays on your server and is shown only once.</p><label><span>Key label</span><input id="api-key-label" value="Production product" maxlength="80"></label><label><span>Expiration</span><select id="api-key-expiration"><option value="2592000">30 days</option><option value="7776000" selected>90 days</option><option value="31536000">365 days</option></select></label></div><button class="button primary" data-create-key>Create product key</button></li>
      ${apiSecret ? `<li class="secret"><div><h2>Copy this key now</h2><code>${esc(apiSecret)}</code></div><button class="button" data-copy="${esc(apiSecret)}">Copy</button></li>` : ""}
      <li><div><h2>2. Pick your stack</h2><p>Use a framework adapter or implement the public protocol directly. Route handlers do not change.</p><div class="setup-tabs">${adapter("Node · Express", nodeInstall, expressCode)}${adapter("Node · Fastify", nodeInstall, fastifyCode)}${adapter("Python · ASGI/WSGI", pythonInstall, pythonCode)}${adapter("Go · net/http", goInstall, goCode)}${adapter("Rust · Axum/Tower", rustInstall, rustCode)}${adapter("MCP", nodeInstall, mcpCode)}${adapter("Any language · protocol", "No SDK required", protocolCode)}</div></div></li>
      <li><div><h2>3. Verify a real response</h2><p>The doctor checks response injection and submits a real synthetic review with only the scoped receipt.</p><pre><code>${esc(doctor)}</code></pre></div><button class="button" data-copy="${esc(doctor)}">Copy doctor command</button></li>
      <li><div><h2>4. Verify this workspace backend</h2><p>This browser test independently signs a v2 receipt, sends non-blocking telemetry, and submits the compact synthetic review.</p></div><button class="button primary" data-run-test ${apiSecret ? "" : "disabled"}>Run backend contract test</button></li>
    </ol><h2>Product keys</h2><div class="list">${keys}</div>`;
}

function policyView() {
  const workspace = dashboard.workspace;
  return `${header("COLLECTION POLICY", "Control outcome collection")}<form id="policy-form" class="policy"><label><span>Feedback mode</span><select name="feedbackMode"><option value="auto" ${workspace.feedbackMode === "auto" ? "selected" : ""}>Auto — ask the agent to submit autonomously</option><option value="ask" ${workspace.feedbackMode === "ask" ? "selected" : ""}>Ask — make outcome submission optional</option><option value="off" ${workspace.feedbackMode === "off" ? "selected" : ""}>Off — reject outcome submissions</option></select></label><label><span>Retention</span><select name="retentionDays">${[7, 30, 90, 365].map((days) => `<option value="${days}" ${workspace.retentionDays === days ? "selected" : ""}>${days} days</option>`).join("")}</select></label><input type="hidden" name="collectEventSummaries" value="off"><div class="guardrails"><h2>Always rejected</h2><ul><li>Prompts and transcripts</li><li>Secrets and authentication payloads</li><li>Personal data and raw customer content</li><li>Raw tool inputs or outputs</li><li>Unknown review fields</li></ul></div><button class="button primary">Save policy</button></form>`;
}

function render() {
  if (!dashboard) return;
  document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-current", button.dataset.view === currentView ? "page" : "false"));
  page.innerHTML = ({ feedback: feedbackView, insights: insightsView, interactions: interactionsView, sessions: sessionsView, setup: setupView, policy: policyView }[currentView] || feedbackView)();
}

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

async function signedCapability(secret, interactionId) {
  const match = /^af_live_([0-9a-f]{32})_(.{20,})$/i.exec(secret);
  if (!match) throw new Error("Create a new v2 product key first.");
  const now = Math.floor(Date.now() / 1000);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
  const claims = { v: 1, i: interactionId, iat: now, exp: now + 7200, n: nonce };
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const input = `afr2_${match[1].toLowerCase()}.${payload}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return `${input}.${base64url(signature)}`;
}

async function runTest() {
  if (!apiSecret) return;
  setNotice("Running the v2 backend contract test…");
  const interactionId = crypto.randomUUID();
  const receipt = await signedCapability(apiSecret, interactionId);
  const companyHeaders = { "content-type": "application/json", authorization: `Bearer ${apiSecret}` };
  await request("/api/v2/telemetry/batches", { method: "POST", headers: companyHeaders, body: JSON.stringify({ events: [{ interactionId, surface: "http_json", operation: "/doctor", statusCode: 200, durationMs: 12, classification: "unclassified", customerRef: "demo_account_123", occurredAt: new Date().toISOString() }] }) });
  await request("/api/v2/outcomes", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${receipt}` }, body: JSON.stringify({ outcome: "success", note: "The workspace backend accepted the v2 receipt and compact review." }) });
  await refresh();
  navigate("feedback");
  setNotice("V2 contract test passed. The review and confirmed interaction are now visible.");
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.view) navigate(target.dataset.view);
    if (target.dataset.outcome) { selectedOutcome = target.dataset.outcome; render(); }
    if (target.dataset.interaction) { selectedInteraction = target.dataset.interaction; currentView = "interactions"; render(); }
    if (target.dataset.session) { selectedSession = target.dataset.session; render(); }
    if (target.dataset.back) { selectedOutcome = null; selectedInteraction = null; selectedSession = null; render(); }
    if (target.dataset.openInteraction) { currentView = "interactions"; selectedInteraction = target.dataset.openInteraction; render(); }
    if (target.hasAttribute("data-toggle-legacy")) { showingLegacy = !showingLegacy; selectedOutcome = null; render(); }
    if (target.dataset.copy) { await navigator.clipboard.writeText(target.dataset.copy); setNotice("Copied."); }
    if (target.hasAttribute("data-create-key")) {
      const label = document.querySelector("#api-key-label")?.value.trim() || "Production";
      const expiresInSeconds = Number(document.querySelector("#api-key-expiration")?.value || 7776000);
      const body = await request("/api/settings/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label, expiresInSeconds }) });
      apiSecret = body.secret;
      await refresh();
      setNotice("V2 product key created. Copy it now; it will not be shown again.");
    }
    if (target.dataset.revokeKey) {
      await request(`/api/settings/api-keys/${target.dataset.revokeKey}`, { method: "DELETE" });
      apiSecret = "";
      await refresh();
      setNotice("Product key revoked.");
    }
    if (target.hasAttribute("data-run-test")) await runTest();
  } catch (error) {
    setNotice(error.message || "Request failed");
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id !== "policy-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await request("/api/settings/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedbackMode: form.get("feedbackMode"), collectEventSummaries: false, retentionDays: Number(form.get("retentionDays")) }) });
    await refresh();
    setNotice("Collection policy saved.");
  } catch (error) {
    setNotice(error.message || "Request failed");
  }
});

document.querySelector("#signout").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.assign("/");
});
window.addEventListener("popstate", () => {
  currentView = new URL(location.href).searchParams.get("view") || "feedback";
  render();
});
refresh().catch(() => location.assign("/"));
