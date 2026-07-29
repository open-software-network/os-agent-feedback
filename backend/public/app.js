const initialUrl = new URL(location.href);
const page = document.querySelector("#page");
const notice = document.querySelector("#notice");
const account = document.querySelector("#account");
const productScope = document.querySelector("#product-scope");
let dashboard;
let currentView = initialUrl.searchParams.get("view") || "feedback";
let selectedWorkspaceId = initialUrl.searchParams.get("team") || "";
let selectedProductId = initialUrl.searchParams.get("product") || "";
let selectedOutcome = initialUrl.searchParams.get("outcome");
let selectedInteraction = initialUrl.searchParams.get("interaction");
let selectedSession = initialUrl.searchParams.get("session");
let explorerQuery = initialUrl.searchParams.get("q") || "";
let explorerPrimary = initialUrl.searchParams.get("filter") || "all";
let explorerSecondary = initialUrl.searchParams.get("surface") || "all";
let explorerRange = initialUrl.searchParams.get("range") || "30d";
let showingLegacy = initialUrl.searchParams.get("legacy") === "1";
let apiSecret = "";
let setupSurface = "mcp";
let setupStack = "node-mcp";
let setupConnectionId = null;
let setupInstallMode = "agent";
let setupMonitor = null;
let noticeTimer = null;
let explorerTimer = null;

const validViews = new Set(["feedback", "insights", "interactions", "sessions", "setup", "policy", "team", "new-product"]);
const validRanges = new Set(["24h", "7d", "30d", "all"]);
if (!validViews.has(currentView)) currentView = "feedback";
if (!validRanges.has(explorerRange)) explorerRange = "30d";

function setupSecretKey(environmentId) {
  return `agent-feedback:product-key:${environmentId}`;
}

function isLegacyKeyPrefix(prefix) {
  if (!prefix) return false;
  return !/^af_live_[0-9a-f]{8}$/.test(prefix);
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
const setNotice = (message, timeoutMs = 0) => {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.hidden = !message;
  if (message && timeoutMs) {
    noticeTimer = setTimeout(() => {
      notice.textContent = "";
      notice.hidden = true;
    }, timeoutMs);
  }
};
const outcomeClass = (value) => value === "success" ? "positive" : value === "failure" ? "negative" : "neutral";
const customer = (value) => value ? `Customer ${value}` : "Customer not linked";
const relativeDate = (value) => {
  if (!value) return "—";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const ranges = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.345, "week"], [12, "month"], [Infinity, "year"]];
  let amount = seconds;
  for (const [boundary, unit] of ranges) {
    if (Math.abs(amount) < boundary) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(amount), unit);
    amount /= boundary;
  }
  return date(value);
};
const duration = (milliseconds) => {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  return `${Math.round(milliseconds / 60_000)}m`;
};
const sessionDuration = (session) => duration(Math.max(0, new Date(session.lastSeenAt) - new Date(session.startedAt)));
const badge = (value) => `<span class="status-pill status-${esc(value)}">${esc(title(value))}</span>`;
const rangeMs = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000, all: null };
const inTimeRange = (value) => !rangeMs[explorerRange] || Date.now() - new Date(value).getTime() <= rangeMs[explorerRange];
const matchesQuery = (...values) => !explorerQuery || values.some((value) => String(value || "").toLowerCase().includes(explorerQuery.toLowerCase()));

function syncUrl(mode = "replace") {
  const url = new URL(location.href);
  const values = {
    view: currentView,
    team: selectedWorkspaceId,
    product: selectedProductId,
    outcome: selectedOutcome,
    interaction: selectedInteraction,
    session: selectedSession,
    q: explorerQuery,
    filter: explorerPrimary === "all" ? "" : explorerPrimary,
    surface: explorerSecondary === "all" ? "" : explorerSecondary,
    range: explorerRange === "30d" ? "" : explorerRange,
    legacy: showingLegacy ? "1" : "",
    environment: "",
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history[`${mode}State`]({}, "", url);
}

function resetExplorer() {
  clearTimeout(explorerTimer);
  explorerQuery = "";
  explorerPrimary = "all";
  explorerSecondary = "all";
}

function normalizeDashboardState() {
  if (!validViews.has(currentView)) currentView = "feedback";
  if (!validRanges.has(explorerRange)) explorerRange = "30d";
  const primaryByView = {
    feedback: ["all", "success", "partial", "failure"],
    insights: ["all", "confirmed", "unclassified"],
    interactions: ["all", "confirmed", "unclassified", "reviewed", "unreviewed"],
    sessions: ["all", "reviewed", "unreviewed"],
  };
  if (primaryByView[currentView] && !primaryByView[currentView].includes(explorerPrimary)) explorerPrimary = "all";
  const secondaryValues = currentView === "sessions"
    ? new Set(dashboard.sessions.map((entry) => entry.source))
    : new Set((currentView === "feedback" ? dashboard.outcomes : dashboard.interactions).map((entry) => entry.surface));
  if (explorerSecondary !== "all" && !secondaryValues.has(explorerSecondary)) explorerSecondary = "all";
  const visibleOutcomes = showingLegacy ? dashboard.legacyFeedback : dashboard.outcomes;
  if (selectedOutcome && !visibleOutcomes.some((entry) => entry.id === selectedOutcome)) selectedOutcome = null;
  if (selectedInteraction && !dashboard.interactions.some((entry) => entry.id === selectedInteraction)) selectedInteraction = null;
  if (selectedSession && !dashboard.sessions.some((entry) => entry.id === selectedSession)) selectedSession = null;
  if (currentView !== "feedback") showingLegacy = false;
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Fall back for browsers that drop clipboard permission after an awaited API call.
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    field.remove();
  }
  if (!copied) throw new Error("Could not copy to the clipboard");
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (dashboard?.workspace?.id && path.startsWith("/api/")) {
    headers.set("x-workspace-id", dashboard.workspace.id);
  }
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.assign("/auth/start");
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
  normalizeDashboardState();
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
  account.innerHTML = `<strong>${esc(dashboard.user.displayName)}</strong>${dashboard.user.email ? `<small>${esc(dashboard.user.email)}</small>` : ""}<small>${esc(title(dashboard.currentRole))} · ${esc(dashboard.workspace.name)}</small>`;
  renderProductScope();
  const navigationCounts = { feedback: dashboard.outcomes.length, interactions: dashboard.interactions.length, sessions: dashboard.sessions.length };
  for (const [view, count] of Object.entries(navigationCounts)) {
    const element = document.querySelector(`[data-nav-count="${view}"]`);
    if (element) element.textContent = String(count);
  }
  document.querySelectorAll("[data-editor-only]").forEach((element) => {
    element.hidden = dashboard.currentRole === "member";
  });
  syncUrl("replace");
  const url = new URL(location.href);
  if (url.searchParams.get("invite") === "invalid") {
    url.searchParams.delete("invite");
    history.replaceState({}, "", url);
    setNotice("That invitation is expired, revoked, or was created for a different email address.");
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
  const connectionState = dashboard.interactions.length ? `<span class="scope-state connected"><i></i>Receiving data</span>` : `<span class="scope-state"><i></i>No data yet</span>`;
  productScope.innerHTML = `${teamSelect}<label><span>Product</span><select id="product-select">${productOptions}</select></label><div>${connectionState}${canEdit ? `<button class="link-button" data-new-product>+ New product</button>` : ""}</div>`;
}

function navigate(view) {
  clearTimeout(explorerTimer);
  currentView = view;
  selectedOutcome = null;
  selectedInteraction = null;
  selectedSession = null;
  showingLegacy = false;
  resetExplorer();
  syncUrl("push");
  render();
}

function header(kicker, heading, meta = "", extra = "") {
  return `<header><div><p class="eyebrow">${esc(kicker)}</p><h1>${esc(heading)}</h1></div><div class="header-actions">${extra}<span>${esc(meta)}</span></div></header>`;
}

function empty(heading, copy, view = "setup") {
  return `<div class="empty"><h2>${esc(heading)}</h2><p>${esc(copy)}</p><button class="button primary" data-view="${esc(view)}">Go to ${esc(view)}</button></div>`;
}

function metricStrip(items) {
  return `<div class="metric-strip">${items.map(([value, label, tone = ""]) => `<article class="${esc(tone)}"><strong>${esc(value)}</strong><span>${esc(label)}</span></article>`).join("")}</div>`;
}

function explorerToolbar({ placeholder, primaryLabel, primaryOptions, secondaryLabel = "Surface", secondaryOptions = [] }) {
  const options = (values) => values.map(([value, label]) => `<option value="${esc(value)}" ${explorerPrimary === value ? "selected" : ""}>${esc(label)}</option>`).join("");
  const secondary = secondaryOptions.length ? `<label><span>${esc(secondaryLabel)}</span><select id="explorer-secondary"><option value="all">All ${esc(secondaryLabel.toLowerCase())}</option>${secondaryOptions.map(([value, label]) => `<option value="${esc(value)}" ${explorerSecondary === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>` : "";
  return `<div class="explorer-toolbar" role="search"><label class="explorer-search"><span>Search</span><input id="explorer-search" type="search" value="${esc(explorerQuery)}" placeholder="${esc(placeholder)}" autocomplete="off"></label><label><span>${esc(primaryLabel)}</span><select id="explorer-primary">${options(primaryOptions)}</select></label>${secondary}<label><span>Time range</span><select id="explorer-range"><option value="24h" ${explorerRange === "24h" ? "selected" : ""}>Last 24 hours</option><option value="7d" ${explorerRange === "7d" ? "selected" : ""}>Last 7 days</option><option value="30d" ${explorerRange === "30d" ? "selected" : ""}>Last 30 days</option><option value="all" ${explorerRange === "all" ? "selected" : ""}>All loaded data</option></select></label>${explorerQuery || explorerPrimary !== "all" || explorerSecondary !== "all" || explorerRange !== "30d" ? `<button class="link-button filter-reset" data-clear-filters>Reset</button>` : ""}</div>`;
}

function detailActions() {
  return `<button class="button" data-copy-page-link>Copy link</button>`;
}

function propertyList(items) {
  return `<dl class="property-list">${items.map(([term, value]) => `<div><dt>${esc(term)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function breakdown(rows, total, fallback) {
  if (!rows.length) return `<p class="muted">${esc(fallback)}</p>`;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return `<div class="breakdown">${rows.map((row) => `<div><span><b>${esc(title(row.name))}</b><small>${row.count} · ${total ? Math.round(row.count / total * 100) : 0}%</small></span><i><em style="width:${Math.round(row.count / max * 100)}%"></em></i></div>`).join("")}</div>`;
}

function sessionOutcomeSummary(outcomes) {
  if (!outcomes.length) return "—";
  const counts = outcomes.reduce((result, outcome) => {
    result[outcome.outcome] = (result[outcome.outcome] || 0) + 1;
    return result;
  }, {});
  const details = [["success", "success"], ["partial", "partial"], ["failure", "failed"]]
    .filter(([key]) => counts[key])
    .map(([key, label]) => `${counts[key]} ${label}`)
    .join(" · ");
  return `<span class="session-feedback-summary"><strong>${outcomes.length} review${outcomes.length === 1 ? "" : "s"}</strong><small>${esc(details)}</small></span>`;
}

function renderLoadError(error) {
  const message = error?.message === "Authentication required" ? "Your session needs to be renewed." : "Epode could not load this product’s data.";
  page.innerHTML = `<div class="empty load-error"><h2>${esc(message)}</h2><p>${esc(error?.message || "Check your connection and try again.")}</p><button class="button primary" data-retry-dashboard>Try again</button></div>`;
}

function feedbackView() {
  if (showingLegacy) return legacyFeedbackView();
  const item = dashboard.outcomes.find((entry) => entry.id === selectedOutcome);
  if (item) {
    const interaction = dashboard.interactions.find((entry) => entry.id === item.interactionId);
    const session = item.sessionId ? dashboard.sessions.find((entry) => entry.id === item.sessionId) : null;
    const contextActions = `<div class="detail-links"><button class="linked" data-open-interaction="${esc(item.interactionId)}">Open interaction →</button>${session ? `<button class="linked" data-open-session="${esc(session.id)}">Open session →</button>` : ""}</div>`;
    return `${header("FEEDBACK", title(item.outcome), date(item.createdAt), detailActions())}<button class="back" data-back="feedback">← All feedback</button><div class="detail-layout"><div class="detail-main"><article class="review-card ${outcomeClass(item.outcome)}"><div>${badge(item.outcome)}<small>Submitted by the customer’s agent</small></div><p class="quote">“${esc(item.note)}”</p></article><section class="detail-section"><h2>Linked product context</h2><div class="context-row"><span><small>Operation</small><strong>${esc(item.operation)}</strong></span><span><small>Surface</small><strong>${esc(title(item.surface))}</strong></span><span><small>Duration</small><strong>${duration(item.durationMs)}</strong></span><span><small>Status</small><strong>${esc(item.statusCode || "—")}</strong></span></div>${contextActions}</section></div><aside class="detail-sidebar"><section><h2>Properties</h2>${propertyList([["Received", esc(date(item.createdAt))], ["Review source", esc(title(item.source))], ["Customer", esc(customer(item.customerRef))], ["Classification", esc(title(item.classification))], ["Confirmation", esc(title(item.confirmationMethod || "none"))], ["Runtime hint", esc(item.runtimeHint || "Not provided")], ["Runtime provenance", esc(item.runtimeHintSource || "Not provided")]])}</section><p class="privacy-note"><b>Agent identity is not collected.</b> Runtime values are unverified hints, not identities.</p>${interaction ? `<code class="object-id">${esc(interaction.id)}</code>` : ""}</aside></div>`;
  }
  if (!dashboard.outcomes.length) return `${header("FEEDBACK", "Agent feedback", "0 reviews", `<button class="button" data-refresh-data>Refresh</button>`)}${empty("No feedback yet", "Install Epode on an agent-usable product route, then send one real interaction.")}`;
  const ranged = dashboard.outcomes.filter((entry) => inTimeRange(entry.createdAt));
  const surfaces = [...new Set(dashboard.outcomes.map((entry) => entry.surface))].sort().map((value) => [value, title(value)]);
  const filtered = ranged.filter((entry) => (explorerPrimary === "all" || entry.outcome === explorerPrimary) && (explorerSecondary === "all" || entry.surface === explorerSecondary) && matchesQuery(entry.note, entry.operation, entry.surface, entry.customerRef, entry.runtimeHint));
  const successes = filtered.filter((entry) => entry.outcome === "success").length;
  const failures = filtered.filter((entry) => entry.outcome === "failure").length;
  const partial = filtered.filter((entry) => entry.outcome === "partial").length;
  const rows = filtered.map((entry) => `<button class="table-row feedback-columns" data-outcome="${esc(entry.id)}" aria-label="Open ${esc(entry.outcome)} feedback for ${esc(entry.operation)}"><span>${badge(entry.outcome)}</span><span class="primary-cell"><strong>${esc(entry.note)}</strong><small>${esc(title(entry.source))}</small></span><span><strong>${esc(entry.operation)}</strong><small>${esc(title(entry.surface))}</small></span><span>${esc(entry.customerRef || "Not linked")}</span><time title="${esc(date(entry.createdAt))}">${esc(relativeDate(entry.createdAt))}</time></button>`).join("");
  const toolbar = explorerToolbar({ placeholder: "Search feedback, operation, or customer", primaryLabel: "Outcome", primaryOptions: [["all", "All outcomes"], ["success", "Success"], ["partial", "Partial"], ["failure", "Failure"]], secondaryOptions: surfaces });
  const table = rows ? `<div class="explorer-table"><div class="table-head feedback-columns"><span>Outcome</span><span>Feedback</span><span>Operation</span><span>Customer</span><span>Received</span></div>${rows}</div>` : `<div class="filtered-empty"><h2>No matching feedback</h2><p>Try a wider time range or clear the filters.</p><button class="button" data-clear-filters>Clear filters</button></div>`;
  return `${header("FEEDBACK", "Agent feedback", `${filtered.length} of ${ranged.length} reviews`, `<button class="link-button" data-toggle-legacy>Legacy data</button><button class="button" data-refresh-data>Refresh</button>`)}${metricStrip([[filtered.length, "Reviews"], [filtered.length ? `${Math.round(successes / filtered.length * 100)}%` : "—", "Success rate", "positive"], [partial, "Partial", "neutral"], [failures, "Failed", failures ? "negative" : ""]])}${toolbar}${table}`;
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
  if (!dashboard.interactions.length) return `${header("INSIGHTS", "Product health", "No data", `<button class="button" data-refresh-data>Refresh</button>`)}${empty("No product activity yet", "Finish setup and send one real product request or MCP tool call.")}`;
  const surfaces = [...new Set(dashboard.interactions.map((entry) => entry.surface))].sort().map((value) => [value, title(value)]);
  const interactions = dashboard.interactions.filter((entry) => inTimeRange(entry.occurredAt) && (explorerPrimary === "all" || entry.classification === explorerPrimary) && (explorerSecondary === "all" || entry.surface === explorerSecondary) && matchesQuery(entry.operation, entry.surface, entry.customerRef, entry.runtimeHint));
  const ids = new Set(interactions.map((entry) => entry.id));
  const outcomes = dashboard.outcomes.filter((entry) => ids.has(entry.interactionId));
  const confirmed = interactions.filter((entry) => entry.classification === "confirmed").length;
  const successful = outcomes.filter((entry) => entry.outcome === "success").length;
  const countBy = (items, field) => [...items.reduce((map, item) => map.set(item[field] || "unknown", (map.get(item[field] || "unknown") || 0) + 1), new Map())].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  const operationRows = countBy(interactions, "operation");
  const surfaceRows = countBy(interactions, "surface");
  const outcomeRows = countBy(outcomes, "outcome");
  const failureRows = countBy(outcomes.filter((entry) => entry.outcome === "failure"), "operation");
  const durations = interactions.filter((entry) => entry.durationMs != null).reduce((map, entry) => {
    const value = map.get(entry.operation) || { sum: 0, count: 0 };
    value.sum += entry.durationMs;
    value.count += 1;
    map.set(entry.operation, value);
    return map;
  }, new Map());
  const slowest = [...durations].map(([name, value]) => ({ name, average: Math.round(value.sum / value.count) })).sort((a, b) => b.average - a.average)[0];
  const gap = Math.max(confirmed - outcomes.length, 0);
  const toolbar = explorerToolbar({ placeholder: "Filter by operation, customer, or runtime", primaryLabel: "Classification", primaryOptions: [["all", "All interactions"], ["confirmed", "Confirmed"], ["unclassified", "Unclassified"]], secondaryOptions: surfaces });
  const investigations = `<section class="investigations"><div><p class="eyebrow">INVESTIGATE</p><h2>Where to look next</h2></div><div class="investigation-grid">${failureRows[0] ? `<button data-investigate-view="feedback" data-investigate-filter="failure" data-investigate-query="${esc(failureRows[0].name)}"><span>Most failed operation</span><strong>${esc(failureRows[0].name)}</strong><small>${failureRows[0].count} failed review${failureRows[0].count === 1 ? "" : "s"} →</small></button>` : `<article><span>Failures</span><strong>None found</strong><small>No failed reviews in this view.</small></article>`}${gap ? `<button data-investigate-view="interactions" data-investigate-filter="unreviewed"><span>Feedback gap</span><strong>${gap} confirmed</strong><small>Interactions without feedback →</small></button>` : `<article><span>Feedback gap</span><strong>Fully covered</strong><small>Every confirmed interaction has feedback.</small></article>`}${slowest ? `<button data-investigate-view="interactions" data-investigate-query="${esc(slowest.name)}"><span>Slowest operation</span><strong>${esc(slowest.name)}</strong><small>${duration(slowest.average)} average →</small></button>` : `<article><span>Latency</span><strong>No timing data</strong><small>Duration appears when integrations provide it.</small></article>`}</div></section>`;
  return `${header("INSIGHTS", "Product health", `${interactions.length} interactions in view`, `<button class="button" data-refresh-data>Refresh</button>`)}${toolbar}${metricStrip([[interactions.length, "Opportunities"], [confirmed, "Confirmed"], [interactions.length ? `${Math.round(confirmed / interactions.length * 100)}%` : "—", "Confirmation rate"], [confirmed ? `${Math.round(outcomes.length / confirmed * 100)}%` : "—", "Review rate"], [outcomes.length ? `${Math.round(successful / outcomes.length * 100)}%` : "—", "Outcome success"]])}<section class="funnel"><div><p class="eyebrow">CONVERSION</p><h2>From product response to outcome</h2></div><div class="funnel-steps"><button data-investigate-view="interactions"><strong>${interactions.length}</strong><span>Opportunities</span></button><i>→</i><button data-investigate-view="interactions" data-investigate-filter="confirmed"><strong>${confirmed}</strong><span>Confirmed</span></button><i>→</i><button data-investigate-view="feedback"><strong>${outcomes.length}</strong><span>Reviewed</span></button></div></section><div class="three-col breakdown-grid"><article><h2>Operations</h2>${breakdown(operationRows, interactions.length, "No operations yet.")}</article><article><h2>Product surfaces</h2>${breakdown(surfaceRows, interactions.length, "No surface data yet.")}</article><article><h2>Outcomes</h2>${breakdown(outcomeRows, outcomes.length, "No reviews yet.")}</article></div>${investigations}<section class="explanation compact"><h2>Evidence model</h2><p>HTTP responses begin as opportunities—not assumed agent traffic. A submitted review confirms the interaction. MCP tool calls are confirmed immediately because the protocol proves a tool-capable client used them.</p></section>`;
}

function interactionsView() {
  const interaction = dashboard.interactions.find((entry) => entry.id === selectedInteraction);
  if (interaction) {
    const linked = dashboard.outcomes.find((entry) => entry.interactionId === interaction.id);
    const session = interaction.sessionId ? dashboard.sessions.find((entry) => entry.id === interaction.sessionId) : null;
    return `${header("INTERACTION", interaction.operation, date(interaction.occurredAt), detailActions())}<button class="back" data-back="interactions">← All interactions</button>${metricStrip([[title(interaction.classification), "Classification", interaction.classification === "confirmed" ? "positive" : "neutral"], [title(interaction.surface), "Surface"], [interaction.statusCode || "—", "HTTP status"], [duration(interaction.durationMs), "Duration"]])}<div class="detail-layout"><div class="detail-main"><section class="detail-section"><div class="section-heading"><div><p class="eyebrow">EVIDENCE</p><h2>What proves this interaction</h2></div>${badge(interaction.classification)}</div><p>${interaction.classification === "confirmed" ? `Confirmed by ${esc(title(interaction.confirmationMethod || "outcome submission"))}.` : "This response carried feedback instructions, but no agent action has confirmed it yet."}</p></section><section class="detail-section"><div class="section-heading"><h2>Agent feedback</h2>${linked ? badge(linked.outcome) : ""}</div>${linked ? `<p class="quote">“${esc(linked.note)}”</p><button class="linked" data-open-feedback="${esc(linked.id)}">Open feedback →</button>` : `<div class="inline-empty"><p>No feedback was submitted for this interaction.</p><small>This is expected for many HTTP opportunities.</small></div>`}</section>${session ? `<section class="detail-section"><h2>Session context</h2><p>This interaction belongs to a continuity group supplied by ${esc(title(session.source))}.</p><button class="linked" data-open-session="${esc(session.id)}">Open session →</button></section>` : ""}</div><aside class="detail-sidebar"><section><h2>Properties</h2>${propertyList([["Occurred", esc(date(interaction.occurredAt))], ["Operation", esc(interaction.operation)], ["Customer", esc(interaction.customerRef || "Not linked")], ["Confirmation", esc(title(interaction.confirmationMethod || "none"))], ["Runtime hint", esc(interaction.runtimeHint || "Not provided")], ["Hint provenance", esc(interaction.runtimeHintSource || "Not provided")]])}</section><p class="privacy-note"><b>No agent identity.</b> Epode stores only evidence supplied by the product or protocol.</p><code class="object-id">${esc(interaction.id)}</code></aside></div>`;
  }
  if (!dashboard.interactions.length) return `${header("INTERACTIONS", "Product activity", "0 interactions", `<button class="button" data-refresh-data>Refresh</button>`)}${empty("No interactions yet", "Finish setup and use one configured product route.")}`;
  const outcomeByInteraction = new Map(dashboard.outcomes.map((entry) => [entry.interactionId, entry]));
  const ranged = dashboard.interactions.filter((entry) => inTimeRange(entry.occurredAt));
  const surfaces = [...new Set(dashboard.interactions.map((entry) => entry.surface))].sort().map((value) => [value, title(value)]);
  const filtered = ranged.filter((entry) => {
    const reviewed = outcomeByInteraction.has(entry.id);
    const primaryMatch = explorerPrimary === "all" || explorerPrimary === entry.classification || (explorerPrimary === "reviewed" && reviewed) || (explorerPrimary === "unreviewed" && entry.classification === "confirmed" && !reviewed);
    return primaryMatch && (explorerSecondary === "all" || entry.surface === explorerSecondary) && matchesQuery(entry.operation, entry.surface, entry.customerRef, entry.runtimeHint, entry.statusCode);
  });
  const confirmed = filtered.filter((entry) => entry.classification === "confirmed").length;
  const reviewed = filtered.filter((entry) => outcomeByInteraction.has(entry.id)).length;
  const durations = filtered.filter((entry) => entry.durationMs != null);
  const average = durations.length ? Math.round(durations.reduce((sum, entry) => sum + entry.durationMs, 0) / durations.length) : null;
  const rows = filtered.map((entry) => {
    const outcome = outcomeByInteraction.get(entry.id);
    return `<button class="table-row interaction-columns" data-interaction="${esc(entry.id)}" aria-label="Open ${esc(entry.operation)} interaction"><span>${badge(entry.classification)}</span><span class="primary-cell"><strong>${esc(entry.operation)}</strong><small>${esc(entry.customerRef || "Customer not linked")}</small></span><span>${esc(title(entry.surface))}</span><span>${esc(entry.statusCode || "—")}</span><span>${duration(entry.durationMs)}</span><span>${outcome ? badge(outcome.outcome) : "—"}</span><time title="${esc(date(entry.occurredAt))}">${esc(relativeDate(entry.occurredAt))}</time></button>`;
  }).join("");
  const toolbar = explorerToolbar({ placeholder: "Search operation, customer, status, or runtime", primaryLabel: "Evidence", primaryOptions: [["all", "All interactions"], ["confirmed", "Confirmed"], ["unclassified", "Unclassified"], ["reviewed", "Has feedback"], ["unreviewed", "Confirmed without feedback"]], secondaryOptions: surfaces });
  const table = rows ? `<div class="explorer-table"><div class="table-head interaction-columns"><span>Evidence</span><span>Operation</span><span>Surface</span><span>Status</span><span>Duration</span><span>Feedback</span><span>Occurred</span></div>${rows}</div>` : `<div class="filtered-empty"><h2>No matching interactions</h2><p>Try a wider time range or clear the filters.</p><button class="button" data-clear-filters>Clear filters</button></div>`;
  return `${header("INTERACTIONS", "Product activity", `${filtered.length} of ${ranged.length} interactions`, `<button class="button" data-refresh-data>Refresh</button>`)}${metricStrip([[filtered.length, "Interactions"], [confirmed, "Confirmed", "positive"], [reviewed, "With feedback"], [duration(average), "Average duration"]])}${toolbar}${table}`;
}

function sessionsView() {
  const session = dashboard.sessions.find((entry) => entry.id === selectedSession);
  if (session) {
    const interactions = dashboard.interactions.filter((entry) => entry.sessionId === session.id).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    const outcomeByInteraction = new Map(dashboard.outcomes.map((entry) => [entry.interactionId, entry]));
    const reviewed = interactions.filter((entry) => outcomeByInteraction.has(entry.id));
    const confirmed = interactions.filter((entry) => entry.classification === "confirmed").length;
    const customers = [...new Set(interactions.map((entry) => entry.customerRef).filter(Boolean))];
    const timeline = interactions.map((entry, index) => {
      const outcome = outcomeByInteraction.get(entry.id);
      return `<button class="timeline-event" data-interaction="${esc(entry.id)}"><b>${index + 1}</b><span class="timeline-content"><span><strong>${esc(entry.operation)}</strong>${badge(entry.classification)}</span><small>${esc(title(entry.surface))} · ${duration(entry.durationMs)}${entry.statusCode ? ` · HTTP ${esc(entry.statusCode)}` : ""}</small>${outcome ? `<em class="timeline-feedback ${outcomeClass(outcome.outcome)}">${esc(title(outcome.outcome))}: “${esc(outcome.note)}”</em>` : ""}</span><time title="${esc(date(entry.occurredAt))}">${esc(relativeDate(entry.occurredAt))}</time></button>`;
    }).join("");
    return `${header("SESSION", `Session ${session.refHint}…`, `${interactions.length} interactions`, detailActions())}<button class="back" data-back="sessions">← All sessions</button>${metricStrip([[interactions.length, "Interactions"], [confirmed, "Confirmed"], [reviewed.length, "Reviews"], [sessionDuration(session), "Duration"]])}<div class="detail-layout session-detail"><div class="detail-main"><section class="detail-section"><div class="section-heading"><div><p class="eyebrow">TIMELINE</p><h2>Interaction journey</h2></div><span>${esc(date(session.startedAt))}</span></div>${timeline ? `<div class="session-timeline">${timeline}</div>` : `<div class="inline-empty"><p>No interactions are currently loaded for this session.</p></div>`}</section></div><aside class="detail-sidebar"><section><h2>Session properties</h2>${propertyList([["Proof source", esc(title(session.source))], ["Started", esc(date(session.startedAt))], ["Last seen", esc(date(session.lastSeenAt))], ["Customer", esc(customers.length === 1 ? customers[0] : customers.length > 1 ? "Multiple customer refs" : "Not linked")]])}</section><p class="privacy-note"><b>Proof-based continuity.</b> This session exists only because the product or MCP protocol supplied a stable reference. Epode never groups by time or inferred identity.</p><code class="object-id">${esc(session.id)}</code></aside></div>`;
  }
  if (!dashboard.sessions.length) return `${header("SESSIONS", "Agent journeys", "0 sessions", `<button class="button" data-refresh-data>Refresh</button>`)}<p class="page-context">Sessions connect interactions only when your product or MCP supplies a stable reference. Epode never guesses continuity from timing or identity.</p>${empty("No proven sessions", "This is normal. Feedback and interactions work without a session.", "interactions")}`;
  const interactionsBySession = dashboard.interactions.reduce((map, entry) => {
    if (!entry.sessionId) return map;
    if (!map.has(entry.sessionId)) map.set(entry.sessionId, []);
    map.get(entry.sessionId).push(entry);
    return map;
  }, new Map());
  const outcomeByInteraction = new Map(dashboard.outcomes.map((entry) => [entry.interactionId, entry]));
  const ranged = dashboard.sessions.filter((entry) => inTimeRange(entry.lastSeenAt));
  const sources = [...new Set(dashboard.sessions.map((entry) => entry.source))].sort().map((value) => [value, title(value)]);
  const filtered = ranged.filter((entry) => {
    const interactions = interactionsBySession.get(entry.id) || [];
    const hasFeedback = interactions.some((interaction) => outcomeByInteraction.has(interaction.id));
    const primaryMatch = explorerPrimary === "all" || (explorerPrimary === "reviewed" && hasFeedback) || (explorerPrimary === "unreviewed" && !hasFeedback);
    return primaryMatch && (explorerSecondary === "all" || entry.source === explorerSecondary) && matchesQuery(entry.refHint, entry.source, ...interactions.map((interaction) => interaction.operation));
  });
  const totalInteractions = filtered.reduce((sum, entry) => sum + (interactionsBySession.get(entry.id) || []).length, 0);
  const reviewedSessions = filtered.filter((entry) => (interactionsBySession.get(entry.id) || []).some((interaction) => outcomeByInteraction.has(interaction.id))).length;
  const rows = filtered.map((entry) => {
    const interactions = interactionsBySession.get(entry.id) || [];
    const outcomes = interactions.map((interaction) => outcomeByInteraction.get(interaction.id)).filter(Boolean);
    const customerRefs = [...new Set(interactions.map((interaction) => interaction.customerRef).filter(Boolean))];
    return `<button class="table-row session-columns" data-session="${esc(entry.id)}" aria-label="Open session ${esc(entry.refHint)}"><span class="primary-cell"><strong>${esc(entry.refHint)}…</strong><small>${esc(title(entry.source))}</small></span><span>${interactions.length}</span><span>${sessionOutcomeSummary(outcomes)}</span><span>${esc(customerRefs.length === 1 ? customerRefs[0] : customerRefs.length > 1 ? "Multiple" : "Not linked")}</span><span>${sessionDuration(entry)}</span><time title="${esc(date(entry.lastSeenAt))}">${esc(relativeDate(entry.lastSeenAt))}</time></button>`;
  }).join("");
  const toolbar = explorerToolbar({ placeholder: "Search session, operation, or source", primaryLabel: "Feedback", primaryOptions: [["all", "All sessions"], ["reviewed", "Has feedback"], ["unreviewed", "No feedback"]], secondaryLabel: "Proof source", secondaryOptions: sources });
  const table = rows ? `<div class="explorer-table"><div class="table-head session-columns"><span>Session</span><span>Interactions</span><span>Feedback</span><span>Customer</span><span>Duration</span><span>Last seen</span></div>${rows}</div>` : `<div class="filtered-empty"><h2>No matching sessions</h2><p>Sessions only exist when your product or MCP supplies proof of continuity.</p><button class="button" data-clear-filters>Clear filters</button></div>`;
  return `${header("SESSIONS", "Agent journeys", `${filtered.length} of ${ranged.length} sessions`, `<button class="button" data-refresh-data>Refresh</button>`)}<p class="page-context">Sessions connect interactions only when your product or MCP supplies a stable reference. Epode never guesses continuity from timing or identity.</p>${metricStrip([[filtered.length, "Sessions"], [totalInteractions, "Interactions"], [reviewedSessions, "With feedback"], [filtered.length ? (totalInteractions / filtered.length).toFixed(1) : "—", "Interactions per session"]])}${toolbar}${table}`;
}

const setupSurfaceCopy = {
  mcp: {
    name: "MCP server",
    summary: "Reliable, protocol-backed feedback",
    detail: "MCP 2026-07-28 is stateless. We register an explicit feedback tool, and each product tool call is a confirmed agent interaction.",
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
      install: `${nodeInstall}\nnpm install @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express`,
      code: `import { createMcpInstrumentation } from "@agent-feedback/node/mcp";\nimport { originValidation } from "@modelcontextprotocol/express";\nimport { toNodeHandler } from "@modelcontextprotocol/node";\nimport { createMcpHandler, McpServer } from "@modelcontextprotocol/server";\n\nconst feedback = createMcpInstrumentation({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n});\n\nconst mcp = createMcpHandler(() => {\n  const server = new McpServer({ name: "your-product", version: "1.0.0" });\n  feedback.instrument(server);\n  // Register your product tools after this line.\n  return server;\n}, { legacy: "stateless" });\n\n// [] rejects browser Origin requests; add only trusted browser client hostnames.\napp.use("/mcp", originValidation([]));\nconst handleMcp = toNodeHandler(mcp);\napp.all("/mcp", (req, res) => handleMcp(req, res, req.body));`,
      verify: "Call server/discover, then call one normal product tool from an MCP 2026-07-28 client.",
    },
    "manual-mcp": {
      name: "Language-neutral MCP protocol",
      install: `curl -O ${artifacts}/agent-feedback-protocol-v1.zip`,
      code: `1. Implement stateless MCP 2026-07-28 and server/discover.\n2. Validate MCP-Protocol-Version, Mcp-Method, and Mcp-Name.\n3. Emit confirmed telemetry and add _agentFeedback to product-tool results.\n4. Register report_product_outcome and submit only outcome + note.`,
      verify: "Verify discovery, stateless headers, cache hints, a product tool call, and one outcome-tool review.",
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
  return { interactions, outcomes };
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
  const legacyKey = isLegacyKeyPrefix(setupKey?.prefix);
  const createKeyButton = setupKey ? `<button class="button" data-revoke-key="${esc(setupKey.id)}">Create new key</button>` : "";
  const legacyWarning = legacyKey ? `<div class="secret-callout warning"><div><b>This is a legacy key and cannot produce valid afr2 capabilities</b><code>${esc(setupKey.prefix)}…</code><small>V2 integrations will fail boot validation. Create a new key, then update the <code>AGENT_FEEDBACK_KEY</code> server environment variable.</small></div>${createKeyButton}</div>` : "";
  const secret = apiSecret ? `<div class="secret-callout"><div><b>Save this server-side key now</b><code>${esc(apiSecret)}</code><small>It was created automatically for this product. Customer agents never receive it.</small></div><button class="button" data-copy="${esc(apiSecret)}">Copy key</button>${legacyKey ? "" : createKeyButton}</div>` : `<div class="secret-callout"><div><b>Server-side key ready</b><code>${setupKey ? `${esc(setupKey.prefix)}…` : "Preparing…"}</code><small>Use the value already saved in your server configuration. If it is unavailable, create a new key.</small></div>${legacyKey ? "" : createKeyButton}</div>`;
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
  return `${header("SETUP", `Connect ${dashboard.currentProduct.name}`, connected ? "Receiving data" : "Not connected")}${metricStrip([[setupKey ? "Ready" : "Missing", "Product key", setupKey ? "positive" : "negative"], [connected ? "Connected" : "Waiting", "Telemetry", connected ? "positive" : "neutral"], [reviewed ? "Received" : "Waiting", "Agent feedback", reviewed ? "positive" : "neutral"]])}<p class="setup-lede">Choose your stack, copy the ready installation, and send the first real interaction.</p><section class="setup-step"><div class="step-number">1</div><div class="step-body"><p class="eyebrow">INTEGRATION</p><h2>Choose how your product is served</h2><div class="choice-grid surfaces">${surfaces}</div><p class="selection-explanation"><strong>${esc(surface.name)}:</strong> ${esc(surface.detail)}</p><h3>Choose the integration</h3><div class="choice-grid stacks">${stacks}</div><p class="muted">For HTTP and HTML, choose which routes receive instructions in code—not in this dashboard.</p>${ready}</div></section>${legacyWarning}${installStep}${verifyStep}<details class="existing-connections"><summary>Product keys (${dashboard.apiKeys.length})</summary><div>${connections}</div></details>`;
}

function teamView() {
  const isOwner = dashboard.currentRole === "owner";
  const isAdmin = dashboard.currentRole === "admin";
  const canInvite = isOwner || isAdmin;
  const roleOptions = (role) => `<option value="member" ${role === "member" ? "selected" : ""}>Member</option><option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>`;
  const memberRows = dashboard.teamMembers.map((member) => {
    const isSelf = member.osUserId === dashboard.user.id;
    const canRemove = !isSelf && member.role !== "owner" && (isOwner || (isAdmin && member.role === "member"));
    const roleControl = isOwner && member.role !== "owner" ? `<select class="compact-select" data-member-role="${esc(member.osUserId)}" aria-label="Role for ${esc(member.displayName)}">${roleOptions(member.role)}</select>` : `<b>${esc(title(member.role))}</b>`;
    return `<div class="team-row"><span><strong>${esc(member.displayName)}${isSelf ? " (you)" : ""}</strong>${member.email ? `<small>${esc(member.email)}</small>` : ""}</span>${roleControl}<span>${canRemove ? `<button class="link-button danger" data-remove-member="${esc(member.osUserId)}">Remove</button>` : ""}</span></div>`;
  }).join("");
  const invitationRows = dashboard.teamInvitations.map((invitation) => {
    const link = `${location.origin}/join/${invitation.id}`;
    const canRevoke = isOwner || (isAdmin && invitation.role === "member");
    const recipient = invitation.inviteeKind === "email" ? invitation.inviteeValue : invitation.inviteeKind === "link" ? "Member invite link" : "Private invitation";
    return `<div class="team-row"><span><strong>${esc(recipient)}</strong><small>${esc(title(invitation.role))} · expires ${date(invitation.expiresAt)}</small></span><button class="link-button" data-copy="${esc(link)}">Copy link</button><span>${canRevoke ? `<button class="link-button danger" data-revoke-invitation="${esc(invitation.id)}">Revoke</button>` : ""}</span></div>`;
  }).join("");
  const roleChoices = `${isOwner ? `<option value="admin">Admin</option>` : ""}<option value="member" selected>Member</option>`;
  const inviteForm = canInvite ? `<section class="team-invite"><h2>Invite teammates</h2><form id="team-invite-email-form"><label><span>Email address</span><input name="invitee" type="email" autocomplete="email" placeholder="teammate@example.com" maxlength="160" required></label><label><span>Role</span><select name="role">${roleChoices}</select></label><button class="button primary">Invite</button></form><button class="link-button team-invite-secondary" data-create-invite-link>Copy member invite link</button></section>` : `<p class="muted">Your ${esc(dashboard.currentRole)} role can view this team. An owner or admin manages membership.</p>`;
  return `${header("TEAM", dashboard.workspace.name, `${dashboard.teamMembers.length} member${dashboard.teamMembers.length === 1 ? "" : "s"}`)}${inviteForm}<section class="team-section"><h2>Members</h2><div class="team-list">${memberRows}</div></section>${canInvite ? `<section class="team-section"><h2>Pending invitations</h2>${invitationRows ? `<div class="team-list">${invitationRows}</div>` : `<p class="muted">No pending invitations.</p>`}</section>` : ""}`;
}

function policyView() {
  const settings = dashboard.currentEnvironment;
  return `${header("COLLECTION POLICY", "Data controls", dashboard.currentProduct.name)}<p class="page-context">These controls apply to this product. Product traffic stays available even if Epode is unavailable.</p><form id="policy-form" class="policy"><section><div><p class="eyebrow">FEEDBACK</p><h2>Outcome collection</h2><p>Choose how strongly the machine-readable instruction asks customer agents to report the result.</p></div><label><span>Feedback mode</span><select name="feedbackMode"><option value="auto" ${settings.feedbackMode === "auto" ? "selected" : ""}>Auto — ask the agent to submit autonomously</option><option value="ask" ${settings.feedbackMode === "ask" ? "selected" : ""}>Ask — make outcome submission optional</option><option value="off" ${settings.feedbackMode === "off" ? "selected" : ""}>Off — reject outcome submissions</option></select><small>Independent agents cannot be forced to comply.</small></label></section><section><div><p class="eyebrow">RETENTION</p><h2>Data lifetime</h2><p>Automatically remove interaction, session, and feedback records after this period.</p></div><label><span>Retention period</span><select name="retentionDays">${[7, 30, 90, 365].map((days) => `<option value="${days}" ${settings.retentionDays === days ? "selected" : ""}>${days} days</option>`).join("")}</select></label></section><input type="hidden" name="collectEventSummaries" value="off"><section class="guardrails"><div><p class="eyebrow">PRIVACY</p><h2>Always rejected</h2><p>These fields cannot be enabled.</p></div><ul><li>Prompts and transcripts</li><li>Secrets and authentication payloads</li><li>Personal data and raw customer content</li><li>Raw tool inputs or outputs</li><li>Unknown review fields</li></ul></section><div class="form-footer"><span>Current mode: <b>${esc(title(settings.feedbackMode))}</b> · ${settings.retentionDays} day retention</span><button class="button primary">Save changes</button></div></form>`;
}

function render() {
  if (!dashboard) return;
  document.title = `${title(currentView)} · ${dashboard.currentProduct?.name || dashboard.workspace.name} · Epode`;
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
    if (target.dataset.outcome) { selectedOutcome = target.dataset.outcome; syncUrl("push"); render(); }
    if (target.dataset.interaction) { selectedInteraction = target.dataset.interaction; selectedSession = null; currentView = "interactions"; syncUrl("push"); render(); }
    if (target.dataset.session) { selectedSession = target.dataset.session; syncUrl("push"); render(); }
    if (target.dataset.back) { selectedOutcome = null; selectedInteraction = null; selectedSession = null; syncUrl("push"); render(); }
    if (target.dataset.openInteraction) { currentView = "interactions"; selectedInteraction = target.dataset.openInteraction; selectedOutcome = null; selectedSession = null; syncUrl("push"); render(); }
    if (target.dataset.openSession) { currentView = "sessions"; selectedSession = target.dataset.openSession; selectedOutcome = null; selectedInteraction = null; syncUrl("push"); render(); }
    if (target.dataset.openFeedback) { currentView = "feedback"; selectedOutcome = target.dataset.openFeedback; selectedInteraction = null; selectedSession = null; syncUrl("push"); render(); }
    if (target.hasAttribute("data-copy-page-link")) { await copyText(location.href); setNotice("Link copied.", 1800); }
    if (target.hasAttribute("data-clear-filters")) { resetExplorer(); explorerRange = "30d"; syncUrl("replace"); render(); }
    if (target.dataset.investigateView) {
      currentView = target.dataset.investigateView;
      selectedOutcome = null;
      selectedInteraction = null;
      selectedSession = null;
      explorerPrimary = target.dataset.investigateFilter || "all";
      explorerSecondary = "all";
      explorerQuery = target.dataset.investigateQuery || "";
      syncUrl("push");
      render();
    }
    if (target.hasAttribute("data-toggle-legacy")) { showingLegacy = !showingLegacy; selectedOutcome = null; resetExplorer(); syncUrl("replace"); render(); }
    if (target.dataset.copy) { await copyText(target.dataset.copy); setNotice("Copied.", 1800); }
    if (target.hasAttribute("data-create-invite-link")) {
      const body = await request("/api/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      });
      await copyText(`${location.origin}${body.joinPath}`);
      await refresh();
      setNotice("Invite link copied.", 1800);
    }
    if (target.hasAttribute("data-refresh-setup")) {
      await refresh();
      setNotice("Connection status refreshed.");
    }
    if (target.hasAttribute("data-refresh-data")) {
      await refresh();
      setNotice("Data refreshed.", 1800);
    }
    if (target.hasAttribute("data-retry-dashboard")) {
      target.disabled = true;
      await refresh();
      setNotice("Dashboard loaded.", 1800);
    }
    if (target.dataset.revokeKey) {
      if (!confirm("Create a new product key? The current key stops working immediately.")) return;
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
    if (event.target.id === "explorer-primary") {
      explorerPrimary = event.target.value;
      syncUrl("replace");
      render();
    }
    if (event.target.id === "explorer-secondary") {
      explorerSecondary = event.target.value;
      syncUrl("replace");
      render();
    }
    if (event.target.id === "explorer-range") {
      explorerRange = event.target.value;
      syncUrl("replace");
      render();
    }
    if (event.target.id === "workspace-select") {
      selectedWorkspaceId = event.target.value;
      selectedProductId = "";
      selectedOutcome = null;
      selectedInteraction = null;
      selectedSession = null;
      resetExplorer();
      apiSecret = "";
      setupConnectionId = null;
      await refresh();
    }
    if (event.target.id === "product-select") {
      selectedProductId = event.target.value;
      selectedOutcome = null;
      selectedInteraction = null;
      selectedSession = null;
      resetExplorer();
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
    setNotice(error.message || "Update failed");
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "explorer-search") return;
  explorerQuery = event.target.value;
  clearTimeout(explorerTimer);
  explorerTimer = setTimeout(() => {
    syncUrl("replace");
    render();
    const input = document.querySelector("#explorer-search");
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, 180);
});

document.addEventListener("submit", async (event) => {
  if (!["product-form", "policy-form", "team-invite-email-form"].includes(event.target.id)) return;
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
    if (event.target.id === "team-invite-email-form") {
      const invitee = String(form.get("invitee") || "").trim();
      const body = await request("/api/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invitee, role: form.get("role") }),
      });
      const inviteLink = `${location.origin}${body.joinPath}`;
      const emailHref = `mailto:${encodeURIComponent(invitee)}?subject=${encodeURIComponent(`Join ${dashboard.workspace.name}`)}&body=${encodeURIComponent(`You've been invited to join ${dashboard.workspace.name}.\n\n${inviteLink}`)}`;
      event.target.reset();
      await refresh();
      setNotice("Email draft ready.", 1800);
      location.assign(emailHref);
    }
  } catch (error) {
    setNotice(error.message || "Request failed");
  }
});

document.querySelector("#signout").addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    location.assign("/");
  }
});
window.addEventListener("popstate", () => {
  clearTimeout(explorerTimer);
  const url = new URL(location.href);
  currentView = url.searchParams.get("view") || "feedback";
  selectedWorkspaceId = url.searchParams.get("team") || "";
  selectedProductId = url.searchParams.get("product") || "";
  selectedOutcome = url.searchParams.get("outcome");
  selectedInteraction = url.searchParams.get("interaction");
  selectedSession = url.searchParams.get("session");
  showingLegacy = url.searchParams.get("legacy") === "1";
  explorerQuery = url.searchParams.get("q") || "";
  explorerPrimary = url.searchParams.get("filter") || "all";
  explorerSecondary = url.searchParams.get("surface") || "all";
  explorerRange = validRanges.has(url.searchParams.get("range")) ? url.searchParams.get("range") : "30d";
  refresh().catch(renderLoadError);
});
refresh().catch(renderLoadError);
