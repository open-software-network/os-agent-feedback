const initialUrl = new URL(location.href);
const page = document.querySelector("#page");
const notice = document.querySelector("#notice");
const account = document.querySelector("#account");
const productScope = document.querySelector("#product-scope");
let dashboard;
let currentView = initialUrl.searchParams.get("view") || "home";
let selectedWorkspaceId = initialUrl.searchParams.get("team") || (() => {
  try { return globalThis.localStorage?.getItem("epode:last-team") || ""; } catch { return ""; }
})();
let selectedProductId = initialUrl.searchParams.get("product") || "";
let selectedReport = initialUrl.searchParams.get("report");
let selectedInteraction = initialUrl.searchParams.get("interaction");
let selectedSession = initialUrl.searchParams.get("session");
let explorerQuery = initialUrl.searchParams.get("q") || "";
let explorerPrimary = initialUrl.searchParams.get("filter") || "all";
let explorerSecondary = initialUrl.searchParams.get("surface") || "all";
let explorerRange = initialUrl.searchParams.get("range") || "30d";
let apiSecret = "";
let readSecret = "";
let readKeyId = null;
let readSnippetClient = "claude-code";
let setupSurface = "mcp";
let setupStack = "node-mcp";
let setupConnectionId = null;
let setupInstallMode = "agent";
let setupMonitor = null;
let noticeTimer = null;
let explorerTimer = null;
let refreshGeneration = 0;
let interactionLimit = 250;
let reportLimit = 250;
let sessionLimit = 100;
let pendingHeadingFocus = false;

const validViews = new Set(["home", "feedback", "interactions", "sessions", "setup", "policy", "team", "new-product"]);
const validRanges = new Set(["24h", "7d", "30d", "all"]);
if (!validViews.has(currentView)) currentView = "home";
if (!validRanges.has(explorerRange)) explorerRange = "30d";

function isLegacyKeyPrefix(prefix) {
  if (!prefix) return false;
  return !/^af_(live|read)_[0-9a-f]{8}$/.test(prefix);
}

function keyKind(key) {
  return key?.kind === "read" ? "read" : "write";
}

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const date = (value) => value ? new Date(value).toLocaleString() : "—";
const title = (value) => String(value || "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const feedbackModeLabel = (value) => ({ never_ask: "Never ask", ask_once: "Ask once", ask_always: "Ask every time", off: "Off" })[value] || title(value);
const setNotice = (message, timeoutMs = 2800, tone = "info") => {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.className = `notice notice-${tone}`;
  notice.setAttribute("role", tone === "error" ? "alert" : "status");
  notice.hidden = !message;
  if (message && timeoutMs > 0) {
    noticeTimer = setTimeout(() => {
      notice.textContent = "";
      notice.hidden = true;
    }, timeoutMs);
    noticeTimer?.unref?.();
  }
};
const impactClass = (value) => ["helped", "helped_with_friction"].includes(value) ? "positive" : ["hindered", "blocked"].includes(value) ? "negative" : "neutral";
const reportImpact = (report) => report.impact || "unspecified";
const reportFindings = (report) => Array.isArray(report.findings) ? report.findings : [];
const reportTopics = (report) => reportFindings(report).map((finding) => finding.topic);
const reportSeverity = (report) => reportFindings(report).some((finding) => finding.severity === "blocking") ? "blocking" : reportFindings(report).some((finding) => finding.severity === "major") ? "major" : reportFindings(report).some((finding) => finding.severity === "minor") ? "minor" : "none";
const workflowStatus = (report) => report.workflowStatus || "new";
const findingBadge = (finding) => `<span class="status-pill status-${esc(finding.severity || finding.kind)}">${esc(title(finding.kind))}${finding.severity ? ` · ${esc(title(finding.severity))}` : ""}</span>`;
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
    view: currentView === "home" ? "" : currentView,
    team: selectedWorkspaceId,
    product: selectedProductId,
    report: selectedReport,
    interaction: selectedInteraction,
    session: selectedSession,
    q: explorerQuery,
    filter: explorerPrimary === "all" ? "" : explorerPrimary,
    surface: explorerSecondary === "all" ? "" : explorerSecondary,
    range: explorerRange === "30d" ? "" : explorerRange,
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
  if (!validViews.has(currentView)) currentView = "home";
  if (!validRanges.has(explorerRange)) explorerRange = "30d";
  const primaryByView = {
    feedback: ["all", "new", "investigating", "planned", "resolved", "wont_act"],
    interactions: ["all", "confirmed", "unclassified", "reviewed", "unreviewed"],
    sessions: ["all", "reviewed", "unreviewed"],
  };
  if (!primaryByView[currentView]) explorerPrimary = "all";
  if (primaryByView[currentView] && !primaryByView[currentView].includes(explorerPrimary)) explorerPrimary = "all";
  const secondaryValues = currentView === "sessions"
    ? new Set(dashboard.sessions.map((entry) => entry.source))
    : currentView === "feedback"
      ? new Set(dashboard.reports.map(reportImpact))
      : new Set(dashboard.interactions.map((entry) => entry.surface));
  if (explorerSecondary !== "all" && !secondaryValues.has(explorerSecondary)) explorerSecondary = "all";
  if (selectedReport && !dashboard.reports.some((entry) => entry.id === selectedReport)) selectedReport = null;
  if (selectedInteraction && !dashboard.interactions.some((entry) => entry.id === selectedInteraction)) selectedInteraction = null;
  if (selectedSession && !dashboard.sessions.some((entry) => entry.id === selectedSession)) selectedSession = null;
}

async function copyText(value) {
  const previousFocus = document.activeElement;
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
    previousFocus?.focus?.();
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
  const generation = ++refreshGeneration;
  const query = new URLSearchParams();
  if (selectedWorkspaceId) query.set("workspaceId", selectedWorkspaceId);
  if (selectedProductId) query.set("productId", selectedProductId);
  query.set("interactionLimit", String(interactionLimit));
  query.set("reportLimit", String(reportLimit));
  query.set("sessionLimit", String(sessionLimit));
  const nextDashboard = await request(`/api/dashboard${query.size ? `?${query}` : ""}`);
  if (generation !== refreshGeneration) return false;
  dashboard = nextDashboard;
  selectedWorkspaceId = dashboard.workspace.id;
  try { globalThis.localStorage?.setItem("epode:last-team", selectedWorkspaceId); } catch { /* Browser storage is optional. */ }
  selectedProductId = dashboard.currentProduct?.id || "";
  if (dashboard.currentRole === "member" && ["setup", "policy", "new-product"].includes(currentView)) {
    currentView = "home";
  }
  if (currentView === "setup" && dashboard.currentRole !== "member" && dashboard.currentEnvironment && !dashboard.apiKeys.some((key) => keyKind(key) === "write")) {
    const body = await request("/api/settings/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Default product key", environmentId: dashboard.currentEnvironment.id }),
    });
    apiSecret = body.secret;
    setupConnectionId = body.apiKey.id;
    const updatedDashboard = await request(`/api/dashboard?productId=${encodeURIComponent(selectedProductId)}`);
    if (generation !== refreshGeneration) return false;
    dashboard = updatedDashboard;
  }
  await hydrateSelectedDetails(generation);
  if (generation !== refreshGeneration) return false;
  normalizeDashboardState();
  const setupKey = dashboard.apiKeys.find((key) => key.id === setupConnectionId && keyKind(key) === "write") || dashboard.apiKeys.find((key) => keyKind(key) === "write");
  if (setupKey) {
    setupConnectionId = setupKey.id;
  } else {
    setupConnectionId = null;
    apiSecret = "";
  }
  const readKey = dashboard.apiKeys.find((key) => key.id === readKeyId && keyKind(key) === "read") || dashboard.apiKeys.find((key) => keyKind(key) === "read");
  if (readKey) {
    readKeyId = readKey.id;
  } else {
    readKeyId = null;
    readSecret = "";
  }
  account.innerHTML = `<strong>${esc(dashboard.user.displayName)}</strong>${dashboard.user.email ? `<small>${esc(dashboard.user.email)}</small>` : ""}<small>${esc(title(dashboard.currentRole))} · ${esc(dashboard.workspace.name)}</small>`;
  renderProductScope();
  const navigationCounts = {
    feedback: dashboard.listState?.reportsTotal ?? dashboard.reports.length,
    sessions: dashboard.listState?.sessionsTotal ?? dashboard.sessions.length,
  };
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
    setNotice("That invitation is expired, revoked, or was created for a different email address.", 6000, "error");
  }
  render();
  return true;
}

function appendUnique(items, value) {
  if (value && !items.some((entry) => entry.id === value.id)) items.push(value);
}

async function hydrateSelectedDetails(generation) {
  if (!selectedProductId) return;
  const product = `?productId=${encodeURIComponent(selectedProductId)}`;
  try {
    if (selectedReport && !dashboard.reports.some((entry) => entry.id === selectedReport)) {
      const detail = await request(`/api/dashboard/reports/${encodeURIComponent(selectedReport)}${product}`);
      if (generation !== refreshGeneration) return;
      appendUnique(dashboard.reports, detail.report);
      if (!dashboard.interactions.some((entry) => entry.id === detail.report.interactionId)) {
        const linked = await request(`/api/dashboard/interactions/${encodeURIComponent(detail.report.interactionId)}${product}`);
        if (generation !== refreshGeneration) return;
        appendUnique(dashboard.interactions, linked.interaction);
      }
    }
    if (selectedInteraction && !dashboard.interactions.some((entry) => entry.id === selectedInteraction)) {
      const detail = await request(`/api/dashboard/interactions/${encodeURIComponent(selectedInteraction)}${product}`);
      if (generation !== refreshGeneration) return;
      appendUnique(dashboard.interactions, detail.interaction);
    }
    if (selectedSession && !dashboard.sessions.some((entry) => entry.id === selectedSession)) {
      const detail = await request(`/api/dashboard/sessions/${encodeURIComponent(selectedSession)}${product}`);
      if (generation !== refreshGeneration) return;
      appendUnique(dashboard.sessions, detail.session);
      detail.interactions.forEach((entry) => appendUnique(dashboard.interactions, entry));
      detail.reports.forEach((entry) => appendUnique(dashboard.reports, entry));
    }
  } catch (error) {
    if (generation !== refreshGeneration) return;
    if (selectedReport && !dashboard.reports.some((entry) => entry.id === selectedReport)) selectedReport = null;
    if (selectedInteraction && !dashboard.interactions.some((entry) => entry.id === selectedInteraction)) selectedInteraction = null;
    if (selectedSession && !dashboard.sessions.some((entry) => entry.id === selectedSession)) selectedSession = null;
    setNotice(error.message || "The requested detail could not be loaded.", 4000, "error");
  }
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
  const connectionState = dashboard.insights.opportunities ? `<span class="scope-state connected"><i></i>Receiving data</span>` : `<span class="scope-state"><i></i>No data yet</span>`;
  const productActions = canEdit ? `<span class="scope-links"><button class="link-button" data-rename-product>Rename product</button><button class="link-button danger" data-delete-product>Delete product</button><button class="link-button" data-new-product>+ New product</button></span>` : "";
  productScope.innerHTML = `${teamSelect}<label><span>Product</span><select id="product-select">${productOptions}</select></label><div>${connectionState}${productActions}</div>`;
}

function navigate(view) {
  clearTimeout(explorerTimer);
  currentView = view;
  selectedReport = null;
  selectedInteraction = null;
  selectedSession = null;
  resetExplorer();
  explorerRange = "30d";
  pendingHeadingFocus = true;
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

function listContinuation(kind, loaded, total) {
  if (loaded >= total) return "";
  return `<div class="list-continuation"><p>Showing the newest ${loaded.toLocaleString()} of ${total.toLocaleString()} retained ${esc(kind)}.</p><button class="button" data-load-more="${esc(kind)}">Load older</button></div>`;
}

function sessionFeedbackSummary(reports) {
  if (!reports.length) return "—";
  const findings = reports.flatMap(reportFindings);
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  const friction = findings.filter((finding) => ["friction", "defect", "gap"].includes(finding.kind)).length;
  const details = [blocking ? `${blocking} blocking` : "", friction ? `${friction} friction` : ""].filter(Boolean).join(" · ") || `${findings.length} findings`;
  return `<span class="session-feedback-summary"><strong>${reports.length} report${reports.length === 1 ? "" : "s"}</strong><small>${esc(details)}</small></span>`;
}

function renderLoadError(error) {
  const message = error?.message === "Authentication required" ? "Your session needs to be renewed." : "Epode could not load this product’s data.";
  page.innerHTML = `<div class="empty load-error"><h2>${esc(message)}</h2><p>${esc(error?.message || "Check your connection and try again.")}</p><button class="button primary" data-retry-dashboard>Try again</button></div>`;
}

function feedbackView() {
  const item = dashboard.reports.find((entry) => entry.id === selectedReport);
  if (item) {
    const interaction = dashboard.interactions.find((entry) => entry.id === item.interactionId);
    const session = item.sessionId ? dashboard.sessions.find((entry) => entry.id === item.sessionId) : null;
    const contextActions = `<div class="detail-links"><button class="linked" data-open-interaction="${esc(item.interactionId)}">Open interaction →</button>${session ? `<button class="linked" data-open-session="${esc(session.id)}">Open session →</button>` : ""}</div>`;
    const findings = reportFindings(item);
    const findingRows = findings.length ? findings.map((finding) => `<article class="finding-card"><div>${findingBadge(finding)}<code>${esc(finding.topic)}</code></div><p>${esc(finding.detail)}</p></article>`).join("") : `<div class="inline-empty"><p>No individual findings were supplied.</p></div>`;
    const workaround = item.workaround?.used ? `<section class="detail-section"><p class="eyebrow">WORKAROUND USED</p><h2>How the agent got unstuck</h2><p>${esc(item.workaround.detail)}</p></section>` : "";
    const canManage = dashboard.currentRole !== "member";
    const assigneeOptions = dashboard.teamMembers.map((member) => `<option value="${esc(member.osUserId)}" ${item.assigneeOsUserId === member.osUserId ? "selected" : ""}>${esc(member.displayName)}</option>`).join("");
    const triage = `<section class="detail-section"><div class="section-heading"><div><p class="eyebrow">TRIAGE</p><h2>Team workflow</h2></div>${badge(workflowStatus(item))}</div>${canManage ? `<form id="feedback-workflow-form" data-report-id="${esc(item.id)}" class="workflow-form"><label><span>Status</span><select name="status"><option value="new" ${workflowStatus(item) === "new" ? "selected" : ""}>New</option><option value="investigating" ${workflowStatus(item) === "investigating" ? "selected" : ""}>Investigating</option><option value="planned" ${workflowStatus(item) === "planned" ? "selected" : ""}>Planned</option><option value="resolved" ${workflowStatus(item) === "resolved" ? "selected" : ""}>Resolved</option><option value="wont_act" ${workflowStatus(item) === "wont_act" ? "selected" : ""}>Won’t act</option></select></label><label><span>Assignee</span><select name="assignee"><option value="">Unassigned</option>${assigneeOptions}</select></label><label><span>Tags</span><input name="tags" value="${esc((item.tags || []).join(", "))}" placeholder="docs, latency" maxlength="260"></label><label class="workflow-note"><span>Internal note</span><textarea name="internalNote" rows="4" maxlength="1000" placeholder="What should the team do next?">${esc(item.internalNote || "")}</textarea></label><button class="button primary">Save triage</button></form>` : `<p class="muted">An owner or admin manages status, assignment, tags, and internal notes.</p>`}</section>`;
    return `${header("FEEDBACK", title(reportImpact(item)), date(item.createdAt), detailActions())}<button class="back" data-back="feedback">← All feedback</button><div class="detail-layout"><div class="detail-main"><article class="review-card ${impactClass(item.impact)}"><div>${badge(reportImpact(item))}<small>Submitted by the customer’s agent</small></div><p class="quote">“${esc(item.summary)}”</p></article><section class="detail-section"><div class="section-heading"><div><p class="eyebrow">FINDINGS</p><h2>What the agent observed</h2></div><span>${findings.length} finding${findings.length === 1 ? "" : "s"}</span></div><div class="finding-list">${findingRows}</div></section>${workaround}${triage}<section class="detail-section"><h2>Linked product context</h2><div class="context-row"><span><small>Operation</small><strong>${esc(item.operation)}</strong></span><span><small>Surface</small><strong>${esc(title(item.surface))}</strong></span><span><small>Duration</small><strong>${duration(item.durationMs)}</strong></span><span><small>Status</small><strong>${esc(item.statusCode || "—")}</strong></span></div>${contextActions}</section></div><aside class="detail-sidebar"><section><h2>Properties</h2>${propertyList([["Received", esc(date(item.createdAt))], ["Workflow", esc(title(workflowStatus(item)))], ["Impact", esc(title(reportImpact(item)))], ["Confidence", item.confidence == null ? "Not provided" : `${Math.round(item.confidence * 100)}%`], ["Highest severity", esc(title(reportSeverity(item)))], ["Workaround", item.workaround?.used ? "Used" : "Not used"], ["Customer", esc(customer(item.customerRef))], ["Confirmation", esc(title(item.confirmationMethod || "none"))], ["Runtime hint", esc(item.runtimeHint || "Not provided")]])}</section><p class="privacy-note"><b>Agent identity is not collected.</b> Runtime values are unverified hints, not identities.</p>${interaction ? `<code class="object-id">${esc(interaction.id)}</code>` : ""}</aside></div>`;
  }
  if (!dashboard.reports.length) return `${header("FEEDBACK", "Agent feedback", "0 reports", `<button class="button" data-refresh-data>Refresh</button>`)}${empty("No feedback yet", "Install Epode on an agent-usable product route, then send one real interaction.")}`;
  const ranged = dashboard.reports.filter((entry) => inTimeRange(entry.createdAt));
  const impacts = [...new Set(dashboard.reports.map(reportImpact))].sort().map((value) => [value, title(value)]);
  const filtered = ranged.filter((entry) => (explorerPrimary === "all" || workflowStatus(entry) === explorerPrimary) && (explorerSecondary === "all" || reportImpact(entry) === explorerSecondary) && matchesQuery(entry.summary, entry.operation, entry.surface, entry.customerRef, entry.runtimeHint, workflowStatus(entry), ...(entry.tags || []), ...reportTopics(entry), ...reportFindings(entry).map((finding) => finding.detail)));
  const blockers = filtered.filter((entry) => reportSeverity(entry) === "blocking").length;
  const workarounds = filtered.filter((entry) => entry.workaround?.used).length;
  const findings = filtered.reduce((count, entry) => count + reportFindings(entry).length, 0);
  const rows = filtered.map((entry) => `<button class="table-row feedback-columns" data-report="${esc(entry.id)}" aria-label="Open ${esc(title(workflowStatus(entry)))} ${esc(title(reportImpact(entry)))} feedback: ${esc(entry.summary)}. Operation ${esc(entry.operation)}. ${esc(customer(entry.customerRef))}. Received ${esc(date(entry.createdAt))}."><span>${badge(workflowStatus(entry))}<small>${esc(title(reportImpact(entry)))}</small></span><span class="primary-cell"><strong>${esc(entry.summary)}</strong><small>${reportFindings(entry).length} finding${reportFindings(entry).length === 1 ? "" : "s"}${reportSeverity(entry) !== "none" ? ` · ${esc(title(reportSeverity(entry)))}` : ""}</small></span><span><strong>${esc(entry.operation)}</strong><small>${esc(title(entry.surface))}</small></span><span>${esc(entry.customerRef || "Not linked")}</span><time title="${esc(date(entry.createdAt))}">${esc(relativeDate(entry.createdAt))}</time></button>`).join("");
  const toolbar = explorerToolbar({ placeholder: "Search summaries, findings, tags, operation, or customer", primaryLabel: "Status", primaryOptions: [["all", "All statuses"], ["new", "New"], ["investigating", "Investigating"], ["planned", "Planned"], ["resolved", "Resolved"], ["wont_act", "Won’t act"]], secondaryLabel: "Impact", secondaryOptions: impacts });
  const table = rows ? `<div class="explorer-table"><div class="table-head feedback-columns"><span>Status</span><span>Report</span><span>Operation</span><span>Customer</span><span>Received</span></div>${rows}</div>` : `<div class="filtered-empty"><h2>No matching feedback</h2><p>Try a wider time range or clear the filters.</p><button class="button" data-clear-filters>Clear filters</button></div>`;
  const total = dashboard.listState?.reportsTotal ?? dashboard.reports.length;
  return `${header("FEEDBACK", "Agent feedback", `${filtered.length} matching · ${total} retained`, `<button class="button" data-refresh-data>Refresh</button>`)}${metricStrip([[filtered.length, "Loaded matches"], [findings, "Findings"], [blockers, "With blockers", blockers ? "negative" : ""], [workarounds, "With workarounds"]])}${toolbar}${table}${listContinuation("reports", dashboard.reports.length, total)}`;
}

function homeView() {
  const canConfigure = dashboard.currentRole !== "member";
  const actions = `<button class="button" data-refresh-data>Refresh</button>`;
  const context = `<p class="page-context">A current view of what customer agents are using, what they reported, and where your team should look next.</p>`;
  if (!dashboard.insights.opportunities) {
    return `${header("HOME", dashboard.currentProduct.name, "Product overview", actions)}${context}${metricStrip([[0, "Opportunities"], [0, "Confirmed"], ["—", "Report rate"], [0, "Reports with blockers"]])}${empty("No product activity yet", "Finish setup and send one real product request or MCP tool call.", canConfigure ? "setup" : "team")}`;
  }
  const homeCutoff = Date.now() - rangeMs["30d"];
  const interactions = dashboard.interactions.filter((entry) => new Date(entry.occurredAt).getTime() >= homeCutoff);
  const ids = new Set(interactions.map((entry) => entry.id));
  const reports = dashboard.reports.filter((entry) => ids.has(entry.interactionId));
  const confirmed = dashboard.insights.confirmedInteractions;
  const operationRows = dashboard.insights.topOperations;
  const impactRows = dashboard.insights.impacts;
  const findingRows = dashboard.insights.findingKinds;
  const topicRows = dashboard.insights.topics;
  const blockerRows = dashboard.insights.blockingTopics;
  const slowest = dashboard.insights.p95DurationMs == null ? null : { name: "All operations", average: dashboard.insights.p95DurationMs };
  const gap = Math.max(confirmed - dashboard.insights.reports, 0);
  const blockers = dashboard.insights.reportsWithBlockers;
  const workarounds = dashboard.insights.reportsWithWorkarounds;
  const investigations = `<section class="investigations"><div><p class="eyebrow">INVESTIGATE</p><h2>Where to look next</h2></div><div class="investigation-grid">${blockerRows[0] ? `<button data-investigate-view="feedback" data-investigate-query="${esc(blockerRows[0].name)}"><span>Most common blocker</span><strong>${esc(title(blockerRows[0].name))}</strong><small>${blockerRows[0].count} blocking finding${blockerRows[0].count === 1 ? "" : "s"} →</small></button>` : `<article><span>Blockers</span><strong>None reported</strong><small>No blocking findings in this view.</small></article>`}${gap ? `<button data-investigate-view="interactions" data-investigate-filter="unreviewed"><span>Feedback gap</span><strong>${gap} confirmed</strong><small>Interactions without feedback →</small></button>` : `<article><span>Feedback gap</span><strong>Fully covered</strong><small>Every confirmed interaction has feedback.</small></article>`}${slowest ? `<button data-investigate-view="interactions" data-investigate-query="${esc(slowest.name)}"><span>Slowest operation</span><strong>${esc(slowest.name)}</strong><small>${duration(slowest.average)} average →</small></button>` : `<article><span>Latency</span><strong>No timing data</strong><small>Duration appears when integrations provide it.</small></article>`}</div></section>`;
  const recentReports = [...reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const recentFeedback = recentReports.length ? recentReports.map((report) => `<button class="home-feedback-row" data-open-feedback="${esc(report.id)}"><span>${badge(reportImpact(report))}<strong>${esc(report.summary)}</strong></span><small>${esc(report.operation)} · ${esc(relativeDate(report.createdAt))}</small></button>`).join("") : `<div class="inline-empty"><p>No feedback in the last 30 days.</p><small>Confirmed interactions can exist without a submitted report.</small></div>`;
  const activity = `<div class="home-grid"><section class="home-panel"><div class="section-heading"><div><p class="eyebrow">RECENT FEEDBACK</p><h2>What agents reported</h2></div><button class="link-button" data-view="feedback">View all</button></div><div class="home-feedback-list">${recentFeedback}</div></section><section class="home-panel"><div class="section-heading"><div><p class="eyebrow">USAGE</p><h2>Top operations</h2></div><button class="link-button" data-view="interactions">View all</button></div>${breakdown(operationRows, interactions.length, "No operations in the last 30 days.")}</section></div>`;
  return `${header("HOME", dashboard.currentProduct.name, "Last 30 days", actions)}${context}${metricStrip([[dashboard.insights.opportunities, "Opportunities"], [confirmed, "Confirmed"], [confirmed ? `${dashboard.insights.reviewRate}%` : "—", "Feedback rate"], [blockers, "Reports with blockers", blockers ? "negative" : ""], [workarounds, "Workarounds used"]])}<p class="comparison-note">Recent ${dashboard.insights.comparisonDays}-day activity: ${dashboard.insights.recentOpportunities} opportunities · ${dashboard.insights.recentConfirmedInteractions} confirmed · ${dashboard.insights.recentReports} reports. Previous ${dashboard.insights.comparisonDays} days: ${dashboard.insights.previousOpportunities} · ${dashboard.insights.previousConfirmedInteractions} · ${dashboard.insights.previousReports}.</p>${investigations}${activity}<section class="funnel"><div><p class="eyebrow">CONVERSION</p><h2>From product response to feedback</h2></div><div class="funnel-steps"><button data-investigate-view="interactions"><strong>${dashboard.insights.opportunities}</strong><span>Opportunities</span></button><i>→</i><button data-investigate-view="interactions" data-investigate-filter="confirmed"><strong>${confirmed}</strong><span>Confirmed</span></button><i>→</i><button data-investigate-view="feedback"><strong>${dashboard.insights.reports}</strong><span>Reported</span></button></div></section><div class="three-col breakdown-grid"><article><h2>Impacts</h2>${breakdown(impactRows, dashboard.insights.reports, "No impact data yet.")}</article><article><h2>Finding types</h2>${breakdown(findingRows, findingRows.reduce((sum, row) => sum + row.count, 0), "No findings yet.")}</article><article><h2>Topics</h2>${breakdown(topicRows, topicRows.reduce((sum, row) => sum + row.count, 0), "No topics yet.")}</article></div><section class="explanation compact"><h2>How Epode counts activity</h2><p>HTTP responses begin as opportunities—not assumed agent traffic. A submitted report confirms the interaction. MCP tool calls are confirmed immediately because the protocol proves a tool-capable client used them.</p><p>Latency is reported as p50 ${duration(dashboard.insights.p50DurationMs)} and p95 ${duration(dashboard.insights.p95DurationMs)} across responses that supplied timing.</p></section>`;
}

function interactionsView() {
  const interaction = dashboard.interactions.find((entry) => entry.id === selectedInteraction);
  if (interaction) {
    const linked = dashboard.reports.find((entry) => entry.interactionId === interaction.id);
    const session = interaction.sessionId ? dashboard.sessions.find((entry) => entry.id === interaction.sessionId) : null;
    return `${header("INTERACTION", interaction.operation, date(interaction.occurredAt), detailActions())}<button class="back" data-back="interactions">← All interactions</button>${metricStrip([[title(interaction.classification), "Classification", interaction.classification === "confirmed" ? "positive" : "neutral"], [title(interaction.surface), "Surface"], [interaction.statusCode || "—", "HTTP status"], [duration(interaction.durationMs), "Duration"]])}<div class="detail-layout"><div class="detail-main"><section class="detail-section"><div class="section-heading"><div><p class="eyebrow">EVIDENCE</p><h2>What proves this interaction</h2></div>${badge(interaction.classification)}</div><p>${interaction.classification === "confirmed" ? `Confirmed by ${esc(title(interaction.confirmationMethod || "feedback report"))}.` : "This response carried feedback instructions, but no agent action has confirmed it yet."}</p></section><section class="detail-section"><div class="section-heading"><h2>Agent feedback</h2>${linked ? badge(reportImpact(linked)) : ""}</div>${linked ? `<p class="quote">“${esc(linked.summary)}”</p><small>${reportFindings(linked).length} finding${reportFindings(linked).length === 1 ? "" : "s"}</small><button class="linked" data-open-feedback="${esc(linked.id)}">Open feedback →</button>` : `<div class="inline-empty"><p>No feedback was submitted for this interaction.</p><small>This is expected for many HTTP opportunities.</small></div>`}</section>${session ? `<section class="detail-section"><h2>Session context</h2><p>This interaction belongs to a continuity group supplied by ${esc(title(session.source))}.</p><button class="linked" data-open-session="${esc(session.id)}">Open session →</button></section>` : ""}</div><aside class="detail-sidebar"><section><h2>Properties</h2>${propertyList([["Occurred", esc(date(interaction.occurredAt))], ["Operation", esc(interaction.operation)], ["Customer", esc(interaction.customerRef || "Not linked")], ["Confirmation", esc(title(interaction.confirmationMethod || "none"))], ["Runtime hint", esc(interaction.runtimeHint || "Not provided")], ["Hint provenance", esc(interaction.runtimeHintSource || "Not provided")]])}</section><p class="privacy-note"><b>No agent identity.</b> Epode stores only evidence supplied by the product or protocol.</p><code class="object-id">${esc(interaction.id)}</code></aside></div>`;
  }
  if (!dashboard.interactions.length) return `${header("INTERACTIONS", "Product activity", "0 interactions", `<button class="button" data-refresh-data>Refresh</button>`)}${empty("No interactions yet", "Finish setup and use one configured product route.")}`;
  const reportByInteraction = new Map(dashboard.reports.map((entry) => [entry.interactionId, entry]));
  const ranged = dashboard.interactions.filter((entry) => inTimeRange(entry.occurredAt));
  const surfaces = [...new Set(dashboard.interactions.map((entry) => entry.surface))].sort().map((value) => [value, title(value)]);
  const filtered = ranged.filter((entry) => {
    const reviewed = reportByInteraction.has(entry.id);
    const primaryMatch = explorerPrimary === "all" || explorerPrimary === entry.classification || (explorerPrimary === "reviewed" && reviewed) || (explorerPrimary === "unreviewed" && entry.classification === "confirmed" && !reviewed);
    return primaryMatch && (explorerSecondary === "all" || entry.surface === explorerSecondary) && matchesQuery(entry.operation, entry.surface, entry.customerRef, entry.runtimeHint, entry.statusCode);
  });
  const confirmed = filtered.filter((entry) => entry.classification === "confirmed").length;
  const reviewed = filtered.filter((entry) => reportByInteraction.has(entry.id)).length;
  const durations = filtered.filter((entry) => entry.durationMs != null);
  const average = durations.length ? Math.round(durations.reduce((sum, entry) => sum + entry.durationMs, 0) / durations.length) : null;
  const rows = filtered.map((entry) => {
    const report = reportByInteraction.get(entry.id);
    return `<button class="table-row interaction-columns" data-interaction="${esc(entry.id)}" aria-label="Open ${esc(title(entry.classification))} interaction ${esc(entry.operation)}. Surface ${esc(title(entry.surface))}. Status ${esc(entry.statusCode || "not supplied")}. Duration ${esc(duration(entry.durationMs))}. Feedback ${esc(report ? title(reportImpact(report)) : "not submitted")}. Occurred ${esc(date(entry.occurredAt))}."><span>${badge(entry.classification)}</span><span class="primary-cell"><strong>${esc(entry.operation)}</strong><small>${esc(entry.customerRef || "Customer not linked")}</small></span><span>${esc(title(entry.surface))}</span><span>${esc(entry.statusCode || "—")}</span><span>${duration(entry.durationMs)}</span><span>${report ? badge(reportImpact(report)) : "—"}</span><time title="${esc(date(entry.occurredAt))}">${esc(relativeDate(entry.occurredAt))}</time></button>`;
  }).join("");
  const toolbar = explorerToolbar({ placeholder: "Search operation, customer, status, or runtime", primaryLabel: "Evidence", primaryOptions: [["all", "All interactions"], ["confirmed", "Confirmed"], ["unclassified", "Unclassified"], ["reviewed", "Has feedback"], ["unreviewed", "Confirmed without feedback"]], secondaryOptions: surfaces });
  const table = rows ? `<div class="explorer-table"><div class="table-head interaction-columns"><span>Evidence</span><span>Operation</span><span>Surface</span><span>Status</span><span>Duration</span><span>Feedback</span><span>Occurred</span></div>${rows}</div>` : `<div class="filtered-empty"><h2>No matching interactions</h2><p>Try a wider time range or clear the filters.</p><button class="button" data-clear-filters>Clear filters</button></div>`;
  const total = dashboard.listState?.interactionsTotal ?? dashboard.interactions.length;
  return `${header("INTERACTIONS", "Product activity", `${filtered.length} matching · ${total} retained`, `<button class="button" data-refresh-data>Refresh</button>`)}${metricStrip([[filtered.length, "Loaded matches"], [confirmed, "Confirmed", "positive"], [reviewed, "With feedback"], [duration(average), "Average duration"]])}${toolbar}${table}${listContinuation("interactions", dashboard.interactions.length, total)}`;
}

function sessionsView() {
  const session = dashboard.sessions.find((entry) => entry.id === selectedSession);
  if (session) {
    const interactions = dashboard.interactions.filter((entry) => entry.sessionId === session.id).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    const reportByInteraction = new Map(dashboard.reports.map((entry) => [entry.interactionId, entry]));
    const reviewed = interactions.filter((entry) => reportByInteraction.has(entry.id));
    const confirmed = interactions.filter((entry) => entry.classification === "confirmed").length;
    const customers = [...new Set(interactions.map((entry) => entry.customerRef).filter(Boolean))];
    const timeline = interactions.map((entry, index) => {
      const report = reportByInteraction.get(entry.id);
      return `<button class="timeline-event" data-interaction="${esc(entry.id)}"><b>${index + 1}</b><span class="timeline-content"><span><strong>${esc(entry.operation)}</strong>${badge(entry.classification)}</span><small>${esc(title(entry.surface))} · ${duration(entry.durationMs)}${entry.statusCode ? ` · HTTP ${esc(entry.statusCode)}` : ""}</small>${report ? `<em class="timeline-feedback ${impactClass(report.impact)}">${esc(title(reportImpact(report)))}: “${esc(report.summary)}”</em>` : ""}</span><time title="${esc(date(entry.occurredAt))}">${esc(relativeDate(entry.occurredAt))}</time></button>`;
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
  const reportByInteraction = new Map(dashboard.reports.map((entry) => [entry.interactionId, entry]));
  const ranged = dashboard.sessions.filter((entry) => inTimeRange(entry.lastSeenAt));
  const sources = [...new Set(dashboard.sessions.map((entry) => entry.source))].sort().map((value) => [value, title(value)]);
  const filtered = ranged.filter((entry) => {
    const interactions = interactionsBySession.get(entry.id) || [];
    const hasFeedback = interactions.some((interaction) => reportByInteraction.has(interaction.id));
    const primaryMatch = explorerPrimary === "all" || (explorerPrimary === "reviewed" && hasFeedback) || (explorerPrimary === "unreviewed" && !hasFeedback);
    return primaryMatch && (explorerSecondary === "all" || entry.source === explorerSecondary) && matchesQuery(entry.refHint, entry.source, ...interactions.map((interaction) => interaction.operation));
  });
  const totalInteractions = filtered.reduce((sum, entry) => sum + (interactionsBySession.get(entry.id) || []).length, 0);
  const reviewedSessions = filtered.filter((entry) => (interactionsBySession.get(entry.id) || []).some((interaction) => reportByInteraction.has(interaction.id))).length;
  const rows = filtered.map((entry) => {
    const interactions = interactionsBySession.get(entry.id) || [];
    const reports = interactions.map((interaction) => reportByInteraction.get(interaction.id)).filter(Boolean);
    const customerRefs = [...new Set(interactions.map((interaction) => interaction.customerRef).filter(Boolean))];
    return `<button class="table-row session-columns" data-session="${esc(entry.id)}" aria-label="Open session ${esc(entry.refHint)}. Source ${esc(title(entry.source))}. ${interactions.length} interactions and ${reports.length} feedback reports. Duration ${esc(sessionDuration(entry))}. Last seen ${esc(date(entry.lastSeenAt))}."><span class="primary-cell"><strong>${esc(entry.refHint)}…</strong><small>${esc(title(entry.source))}</small></span><span>${interactions.length}</span><span>${sessionFeedbackSummary(reports)}</span><span>${esc(customerRefs.length === 1 ? customerRefs[0] : customerRefs.length > 1 ? "Multiple" : "Not linked")}</span><span>${sessionDuration(entry)}</span><time title="${esc(date(entry.lastSeenAt))}">${esc(relativeDate(entry.lastSeenAt))}</time></button>`;
  }).join("");
  const toolbar = explorerToolbar({ placeholder: "Search session, operation, or source", primaryLabel: "Feedback", primaryOptions: [["all", "All sessions"], ["reviewed", "Has feedback"], ["unreviewed", "No feedback"]], secondaryLabel: "Proof source", secondaryOptions: sources });
  const table = rows ? `<div class="explorer-table"><div class="table-head session-columns"><span>Session</span><span>Interactions</span><span>Feedback</span><span>Customer</span><span>Duration</span><span>Last seen</span></div>${rows}</div>` : `<div class="filtered-empty"><h2>No matching sessions</h2><p>Sessions only exist when your product or MCP supplies proof of continuity.</p><button class="button" data-clear-filters>Clear filters</button></div>`;
  const total = dashboard.listState?.sessionsTotal ?? dashboard.sessions.length;
  return `${header("SESSIONS", "Agent journeys", `${filtered.length} matching · ${total} retained`, `<button class="button" data-refresh-data>Refresh</button>`)}<p class="page-context">Sessions connect interactions only when your product or MCP supplies a stable reference. Epode never guesses continuity from timing or identity.</p>${metricStrip([[filtered.length, "Loaded matches"], [totalInteractions, "Loaded interactions"], [reviewedSessions, "With feedback"], [filtered.length ? (totalInteractions / filtered.length).toFixed(1) : "—", "Interactions per session"]])}${toolbar}${table}${listContinuation("sessions", dashboard.sessions.length, total)}`;
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
    name: "Static site / hosted docs",
    summary: "Advanced trusted-edge proxy",
    detail: "Bind only dedicated public docs routes to an edge proxy your team controls, never a hostname-wide catch-all. The private product key never enters browser JavaScript.",
  },
};

const setupStackOptions = {
  mcp: [
    ["node-mcp", "Node MCP", "Registers and handles the feedback report tool automatically."],
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
  static: [
    ["static-edge", "Trusted edge proxy", "Dedicated-route, fail-closed, header-only handoff."],
  ],
};

function setupInstructions() {
  const artifacts = `${location.origin}/static`;
  const route = setupSurface === "static" ? "/docs/**" : setupSurface === "website" ? "/docs/*" : "/search";
  const verifiedDownload = (filename, sha256) => `epode_artifact="$(mktemp -d)/${filename}" &&\ncurl -fsSL ${artifacts}/${filename} -o "$epode_artifact" &&\nprintf '%s  %s\\n' '${sha256}' "$epode_artifact" | shasum -a 256 -c -`;
  const nodeDownload = `mkdir -p .epode/artifacts &&\nepode_artifact=".epode/artifacts/agent-feedback-node-0.2.2.tgz" &&\ncurl -fsSL ${artifacts}/agent-feedback-node-0.2.2.tgz -o "$epode_artifact" &&\nprintf '%s  %s\\n' 'a108603544c2d17af6859c45d994593a246401ca2f0def1fbeb43f74f5c16fe8' "$epode_artifact" | shasum -a 256 -c -`;
  const pythonDownload = verifiedDownload("agent_feedback-0.2.2-py3-none-any.whl", "5723fd4e86c140218708f9e23187e932cfa1d39f85b29e9d76cbc8dbb6fb0ea7");
  const goDownload = verifiedDownload("agent-feedback-go-0.2.2.tar.gz", "7f28ce6fb875167aac3afab974ca7cfc5896043e69ed136c375a99b9cde6cc15");
  const rustDownload = verifiedDownload("agent-feedback-rust-0.2.2.tar.gz", "f5bc42f38cea06b41449f0ae7b753b602d8e3a5dcf4a98fb3d8c21cd25fcfc62");
  const protocolDownload = verifiedDownload("agent-feedback-protocol-v1-0.2.2.zip", "ba3b239e2bf5de1514ca866c5a50a369d9a396ea440c1f65525b529be9025845");
  const nodeInstall = `${nodeDownload} &&\nnpm install "$epode_artifact"`;
  const environment = `AGENT_FEEDBACK_KEY=${apiSecret || "paste_product_key_here"}\nAGENT_FEEDBACK_MODE=${dashboard.currentEnvironment?.feedbackMode || "never_ask"}`;
  const instructions = {
    "node-mcp": {
      name: "Node MCP",
      install: `${nodeInstall} &&\nnpm install @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express zod`,
      code: `import { createMcpInstrumentation, type McpInstrumentationContext } from "@agent-feedback/node/mcp";\nimport { createMcpExpressApp, requireBearerAuth } from "@modelcontextprotocol/express";\nimport { toNodeHandler } from "@modelcontextprotocol/node";\nimport { createMcpHandler, McpServer } from "@modelcontextprotocol/server";\nimport { z } from "zod";\nimport { productTokenVerifier } from "./product-auth.js";\n\n// [] rejects browser Origin requests. Add only trusted browser client hostnames.\nconst app = createMcpExpressApp({ host: "0.0.0.0", allowedOrigins: [] });\n// Verify the token and authorize its tenant before the MCP handler runs.\napp.use("/mcp", requireBearerAuth({\n  verifier: productTokenVerifier, // existing signature/introspection verifier\n  requiredScopes: ["mcp"],\n}));\n\nfunction stringField(value: unknown, key: string): string | undefined {\n  if (typeof value !== "object" || value === null) return undefined;\n  const field = Reflect.get(value, key);\n  return typeof field === "string" && field.length > 0 ? field : undefined;\n}\nfunction authenticatedAccountId(context: McpInstrumentationContext) {\n  const accountId = context.http?.authInfo?.extra?.accountId;\n  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;\n}\n\nconst feedback = createMcpInstrumentation({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  includeTools: ["search"],\n  customerRef: (_args, context) => authenticatedAccountId(context),\n  sessionRef: (args, _context, result) =>\n    stringField(args, "agentSessionId") ??\n    stringField(result?.structuredContent, "agentSessionId"),\n});\n\nconst feedbackInstructions =\n  "After each selected product tool call, find _agentFeedback in structuredContent or in a standalone JSON content block. Finish the product task first. For consent_required, show the product answer, ask the exact returned question once, and wait for the user's next turn; call record_product_feedback_consent only for an explicit standalone Yes or No. For feedback_ready, call report_product_feedback exactly once. For feedback_disabled, do nothing unless the user explicitly asks to change permission. Keep successful background reporting out of the final answer.";\n\nfunction productServer() {\n  const server = new McpServer(\n    { name: "your-product", version: "1.0.0" },\n    { instructions: feedbackInstructions },\n  );\n  feedback.instrument(server);\n  server.registerTool("search", {\n    description: "Search your product",\n    inputSchema: z.object({ query: z.string() }),\n  }, async ({ query }) => ({\n    content: [{ type: "text", text: await search(query) }],\n  }));\n  return server;\n}\n\nconst mcp = createMcpHandler(productServer, { legacy: "stateless", responseMode: "json" });\nconst handleMcp = toNodeHandler(mcp);\napp.all("/mcp", (req, res) => handleMcp(req, res, req.body));\napp.listen(Number(process.env.PORT || 3000), "0.0.0.0");`,
      verify: "Call server/discover, then call one normal product tool from an MCP 2026-07-28 client.",
    },
    "manual-mcp": {
      name: "Language-neutral MCP protocol",
      install: protocolDownload,
      code: `1. Implement stateless MCP 2026-07-28 and server/discover.\n2. Authenticate and authorize the tenant before forwarding /mcp; derive customerRef only from that verified identity.\n3. Validate MCP-Protocol-Version, Mcp-Method, and Mcp-Name.\n4. Emit confirmed telemetry and add _agentFeedback to selected product-tool results.\n5. Register record_product_feedback_consent and report_product_feedback with strict schemas.\n6. From consent_required allow only the consent tool; from feedback_ready allow only the report tool.`,
      verify: "Verify authentication, discovery, stateless headers, one product tool call, one explicit consent decision when requested, and one allowed feedback report.",
    },
    "node-express": {
      name: "Node · Express",
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/express";\n\n// Product authentication must establish the verified tenant first.\napp.use(productAuthentication);\napp.use(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"],\n  customerRef: req => req.user?.accountId,\n}));`,
      advanced: `sessionRef: req => req.agentSession?.id // optional proven journey grouping`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "node-fastify": {
      name: "Node · Fastify",
      install: nodeInstall,
      code: `import { agentFeedback } from "@agent-feedback/node/fastify";\n\n// Verify the caller and authorize its tenant before Epode reads req.user.\napp.addHook("preHandler", productAuthentication);\nawait app.register(agentFeedback({\n  apiKey: process.env.AGENT_FEEDBACK_KEY,\n  include: ["${route}"],\n  customerRef: req => req.user?.accountId,\n}));`,
      advanced: `sessionRef: req => req.agentSession?.id // optional proven journey grouping`,
      verify: `npx agent-feedback-doctor https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-asgi": {
      name: "Python · ASGI",
      install: `${pythonDownload} &&\npip install "$epode_artifact"`,
      code: `from agent_feedback import AgentFeedbackASGI\n\napp = AgentFeedbackASGI(\n    app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),\n    customer_ref=lambda scope: scope.get("state", {}).get("account_id"),\n)\n# Authentication is the outer wrapper and populates scope["state"] first.\napp = ProductAuthenticationASGI(app)`,
      advanced: `session_ref=lambda scope: scope.get("state", {}).get("agent_session_id") # optional proven journey`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "python-wsgi": {
      name: "Python · WSGI",
      install: `${pythonDownload} &&\npip install "$epode_artifact"`,
      code: `from agent_feedback import AgentFeedbackWSGI\n\napp.wsgi_app = AgentFeedbackWSGI(\n    app.wsgi_app,\n    api_key=os.environ["AGENT_FEEDBACK_KEY"],\n    include=("${route}",),\n    customer_ref=lambda environ: environ.get("product.account_id"),\n)\n# Authentication is the outer wrapper and populates the verified identity first.\napp.wsgi_app = ProductAuthenticationWSGI(app.wsgi_app)`,
      advanced: `session_ref=lambda environ: environ.get("product.agent_session_id") # optional proven journey`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    go: {
      name: "Go · net/http",
      install: `${goDownload} &&\nmkdir -p .epode/agent-feedback-go-0.2.2 &&\ntar -xzf "$epode_artifact" -C .epode/agent-feedback-go-0.2.2 &&\ngo mod edit -replace=github.com/open-software-network/os-epode/sdk/go=./.epode/agent-feedback-go-0.2.2 &&\ngo mod edit -require=github.com/open-software-network/os-epode/sdk/go@v0.2.2`,
      code: `feedback, err := agentfeedback.New(agentfeedback.Options{\n    APIKey: os.Getenv("AGENT_FEEDBACK_KEY"),\n    Include: []string{"${route}"},\n    CustomerRef: func(r *http.Request) string { return authenticatedAccountID(r.Context()) },\n})\nif err != nil { log.Fatal(err) }\ndefer feedback.Shutdown(context.Background())\n\n// The outer authentication middleware populates the verified context first.\nhandler := productAuthentication(feedback.Middleware(router))`,
      advanced: `SessionRef: func(r *http.Request) string { return agentSessionID(r.Context()) }`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    rust: {
      name: "Rust · Axum/Tower",
      install: `${rustDownload} &&\nmkdir -p vendor/agent-feedback-rust-0.2.2 &&\ntar -xzf "$epode_artifact" -C vendor/agent-feedback-rust-0.2.2`,
      code: `// Cargo.toml: agent-feedback = { path = "vendor/agent-feedback-rust-0.2.2" }\nlet feedback = AgentFeedbackLayer::new(\n    Options::new(std::env::var("AGENT_FEEDBACK_KEY")?)\n        .include(["${route}"])\n        .customer_ref(|request| authenticated_account_id(request)),\n)?;\n\n// Tower executes the last layer first, so authentication establishes extensions first.\nlet app = router.layer(feedback).layer(product_auth_layer());`,
      advanced: `.session_ref(|request| agent_session_id(request)) // optional journey grouping`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")}`,
    },
    "static-edge": {
      name: "Trusted edge proxy",
      install: nodeInstall,
      code: `import { createStaticDocsProxy } from "@agent-feedback/node/edge";

let proxy;
export default {
  fetch(request, env, context) {
    // Bind this Worker only to dedicated public docs routes at the edge.
    proxy ??= createStaticDocsProxy({
      apiKey: env.AGENT_FEEDBACK_KEY,
      feedbackMode: env.AGENT_FEEDBACK_MODE,
      upstreamOrigin: "https://your-docs-origin.example",
      include: ["/docs", "/docs/**"],
    });
    return proxy.fetch(request, context);
  },
};`,
      verify: "Confirm an adjacent path returns 404 and POST returns 405 without reaching upstream. Then compare ordinary and opted-in docs responses: the bodies must be identical, and only the opted-in response has Agent-Feedback.",
    },
    "manual-http": {
      name: "Language-neutral HTTP protocol",
      install: protocolDownload,
      code: `GET ${location.origin}/.well-known/agent-feedback-v1.json\n\n1. Derive an opaque consent subject from your product key and authenticated customer ID.\n2. Resolve Ask once state through /api/v2/consent/state.\n3. Unknown: emit the answer-first decision action.\n4. Approved: emit the report contract. Declined: emit neither.\n5. Queue opportunity telemetry without failing the product response.`,
      verify: `Send one request to https://your-product.example${route.replaceAll("*", "test")} and inspect _agentFeedback or the Agent-Feedback header.`,
    },
  };
  return { ...instructions[setupStack], environment };
}

function setupConnectionStatus(apiKeyId) {
  const interactions = dashboard.interactions.filter((entry) => entry.apiKeyId === apiKeyId);
  const interactionIds = new Set(interactions.map((entry) => entry.id));
  const reports = dashboard.reports.filter((entry) => interactionIds.has(entry.interactionId));
  return { interactions, reports };
}

function setupAgentPrompt(integration) {
  const surface = setupSurfaceCopy[setupSurface];
  const identityRequirement = setupSurface === "static" ? "- Do not invent customerRef for public documentation. Add it only if verified edge authentication supplies a stable opaque account ID." : "- Run product authentication and authorized tenant selection before Agent Feedback. customerRef is a synchronous accessor over that verified identity, not an authentication hook. Use a stable opaque account or tenant ID, never a name, email, or caller-supplied unverified value. It is required for durable Ask once.";
  const routeBoundaryRequirement = setupSurface === "static" ? "- Bind the Worker only to dedicated public docs routes at the edge, never a hostname-wide catch-all. Treat include as a second fail-closed boundary." : setupSurface === "mcp" ? "- Set includeTools to only customer-facing product tools whose use should appear in Epode." : "- Replace the example include route and limit instrumentation to routes used by customer agents.";
  return `Add Agent Feedback to this repository.\n\nProduct surface: ${surface.name}\nIntegration: ${integration.name}\n\nRequirements:\n- Use AGENT_FEEDBACK_KEY from the server environment. It is already configured; never print or expose it.\n- Before installing hosted bytes, read integrityManifest from ${location.origin}/.well-known/agent-feedback-v1.json and verify the selected artifact's filename and SHA-256. Stop on any mismatch.\n- Install the official package with: ${integration.install}\n- Configure the integration once using this reference:\n\n${integration.code}\n\n${routeBoundaryRequirement}\n${identityRequirement}\n- Add sessionRef only when your product already has proof that interactions belong to one journey; never infer continuity.\n- Do not put the product key in browser JavaScript.\n- Preserve response shapes, errors, streams, and binary responses.\n- Run the integration doctor against one real company-authenticated request and prove only the first opportunity.\n- Never approve or decline feedback permission for a tester, fabricate customer feedback, or create a synthetic report. Ask modes require the real tester's explicit decision.\n- Finish by printing a copyable customer-agent activation task for a real tester. That separate task should use the product normally and follow the returned feedback action.\n\nProtocol: ${location.origin}/.well-known/agent-feedback-v1.json`;
}

function readKeyClientSnippets() {
  const url = `${location.origin}/mcp`;
  return {
    "claude-code": {
      name: "Claude Code",
      note: "Claude Code expands ${VAR} inside headers. \"type\" is required — an entry with a url but no type is read as a stdio server and skipped.",
      config: `{\n  "mcpServers": {\n    "agent-feedback": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer \${AGENT_FEEDBACK_READ_KEY}" }\n    }\n  }\n}`,
    },
    cursor: {
      name: "Cursor",
      note: "Cursor interpolates with ${env:VAR} — note the env: prefix inside the braces, unlike Claude Code.",
      config: `{\n  "mcpServers": {\n    "agent-feedback": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer \${env:AGENT_FEEDBACK_READ_KEY}" }\n    }\n  }\n}`,
    },
    "vs-code": {
      name: "VS Code",
      note: "VS Code prompts for the secret once and stores it securely, so nothing lands in the file. The top-level key is \"servers\", not \"mcpServers\".",
      config: `{\n  "inputs": [\n    {\n      "type": "promptString",\n      "id": "epode-read-key",\n      "description": "Agent Feedback read key",\n      "password": true\n    }\n  ],\n  "servers": {\n    "agent-feedback": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer \${input:epode-read-key}" }\n    }\n  }\n}`,
    },
  };
}

function productCreateView(firstProduct = false) {
  const heading = firstProduct ? "Create your first product" : "Create a product";
  const copy = firstProduct ? "Products keep feedback and interactions separate. Start with the product your customers' agents use." : "The new product gets its own Home overview, integration, interactions, feedback, and sessions.";
  return `${header(firstProduct ? "WELCOME" : "NEW PRODUCT", heading)}<section class="create-product"><p>${esc(copy)}</p><form id="product-form"><label><span>Product name</span><input name="name" placeholder="Search" maxlength="80" required autofocus></label><button class="button primary">Create product</button></form>${firstProduct ? "" : `<button class="back" data-view="home">← Cancel</button>`}</section>`;
}

function setupView() {
  const surface = setupSurfaceCopy[setupSurface];
  const integration = setupInstructions();
  const setupKey = dashboard.apiKeys.find((key) => key.id === setupConnectionId && keyKind(key) === "write") || dashboard.apiKeys.find((key) => keyKind(key) === "write");
  const status = setupConnectionId ? setupConnectionStatus(setupConnectionId) : { interactions: [], reports: [] };
  const connected = status.interactions.length > 0;
  const reviewed = status.reports.length > 0;
  const stacks = setupStackOptions[setupSurface].map(([id, name, copy]) => `<button class="choice-card" data-setup-stack="${esc(id)}" aria-pressed="${setupStack === id}"><strong>${esc(name)}</strong><span>${esc(copy)}</span></button>`).join("");
  const surfaces = Object.entries(setupSurfaceCopy).map(([id, item]) => `<button class="choice-card surface-card" data-setup-surface="${esc(id)}" aria-pressed="${setupSurface === id}"><strong>${esc(item.name)}</strong><span>${esc(item.summary)}</span></button>`).join("");
  const ready = `<div class="connection-created"><b>Installation ready</b><span>${setupKey ? `${esc(setupKey.prefix)}…` : "Preparing the product key…"}</span></div>`;
  const legacyKey = isLegacyKeyPrefix(setupKey?.prefix);
  const createKeyButton = setupKey ? `<button class="button" data-revoke-key="${esc(setupKey.id)}">Create new key</button>` : "";
  const legacyWarning = legacyKey ? `<div class="secret-callout warning"><div><b>This is a legacy key and cannot produce valid afr2 capabilities</b><code>${esc(setupKey.prefix)}…</code><small>V2 integrations will fail boot validation. Create a new key, then update the <code>AGENT_FEEDBACK_KEY</code> server environment variable.</small></div>${createKeyButton}</div>` : "";
  const secret = apiSecret ? `<div class="secret-callout"><div><b>Save this server-side key now</b><code>${esc(apiSecret)}</code><small>It stays only in page memory and disappears on reload. Move it directly to trusted server configuration; customer agents never receive it.</small></div><button class="button" data-copy="${esc(apiSecret)}">Copy key</button>${legacyKey ? "" : createKeyButton}</div>` : `<div class="secret-callout"><div><b>Full server-side key is hidden</b><code>${setupKey ? `${esc(setupKey.prefix)}…` : "Preparing…"}</code><small>Epode does not save full keys in browser storage. Use the value already in trusted server configuration, or create a new key and replace the lost value.</small></div>${legacyKey ? "" : createKeyButton}</div>`;
  const agentPrompt = setupAgentPrompt(integration);
  const installMode = `<div class="install-methods"><button data-install-mode="agent" aria-pressed="${setupInstallMode === "agent"}">Use a coding agent</button><button data-install-mode="manual" aria-pressed="${setupInstallMode === "manual"}">Manual setup</button></div>`;
  const agentInstall = `<div class="install-panel"><p>Copy this prompt into the coding agent that has access to your product repository. It receives the exact integration and verification requirements, but never the product key.</p><div class="copy-block"><pre><code>${esc(agentPrompt)}</code></pre><button class="button primary" data-copy="${esc(agentPrompt)}">Copy setup prompt</button></div></div>`;
  const identityCopy = setupSurface === "static" ? "Public documentation needs no customerRef. Add one only when verified edge authentication supplies a stable opaque account ID." : "<b>customerRef</b> must be a stable opaque ID from your existing authentication. Epode needs it to remember Ask once approval or refusal; never use a name or email.";
  const manualInstall = `<div class="install-panel"><h3>Install</h3><div class="copy-block"><pre><code>${esc(integration.install)}</code></pre><button class="button" data-copy="${esc(integration.install)}">Copy</button></div><h3>Configure once</h3><p>${identityCopy}</p><div class="copy-block"><pre><code>${esc(integration.code)}</code></pre><button class="button" data-copy="${esc(integration.code)}">Copy</button></div>${integration.advanced ? `<details><summary>Optional session grouping</summary><p>Only supply a session reference when your product already has proof that interactions belong together.</p><pre><code>${esc(integration.advanced)}</code></pre></details>` : ""}</div>`;
  const installStep = `<section class="setup-step"><div class="step-number">2</div><div class="step-body"><p class="eyebrow">INSTALL</p><h2>Install ${esc(integration.name)}</h2><p>Your installation is ready. Telemetry and Ask once state refreshes run in the background and never delay the product response.</p>${secret}<h3>Set the server environment variable</h3><div class="copy-block"><pre><code>${esc(integration.environment)}</code></pre><button class="button" data-copy="${esc(integration.environment)}">Copy</button></div>${installMode}${setupInstallMode === "agent" ? agentInstall : manualInstall}<p><a class="text-link" href="https://docs.epode.ai" target="_blank" rel="noreferrer">Read the integration docs →</a> · <a class="text-link" href="/.well-known/agent-feedback-v1.json" target="_blank" rel="noreferrer">Protocol contract →</a></p></div></section>`;
  const surfaceResult = setupSurface === "mcp" ? "A normal MCP tool call will appear as a confirmed interaction." : "A successful response will appear as an opportunity. It becomes confirmed if the agent submits feedback.";
  const companionInstall = `codex plugin marketplace add open-software-network/os-epode\ncodex plugin add epode-companion@epode`;
  const nativeMcpCoverage = `<div class="coverage-note"><b>Customer-agent coverage: native MCP</b><p>No separate Epode install is required. The feedback tool is part of your MCP server and product tool calls are confirmed interactions.</p></div>`;
  const coverageStep = setupSurface === "mcp" ? "" : `<section class="setup-step"><div class="step-number">3</div><div class="step-body"><p class="eyebrow">CUSTOMER COVERAGE</p><h2>Choose how reliably agents handle feedback</h2><p><strong>Your company-side integration is complete without another install.</strong> Generic agents may ignore HTTP response metadata, so feedback remains best effort.</p><p>For reliable Codex and Claude Code handling, optionally share Epode Companion once with customers or workspace admins. One user-side install works across every Epode-instrumented product; there is no Epode account, key, or per-product setup for the user.</p><div class="copy-block"><pre><code>${esc(companionInstall)}</code></pre><button class="button" data-copy="${esc(companionInstall)}">Copy Codex install</button></div><p><a class="text-link" href="https://docs.epode.ai/integrations/companion" target="_blank" rel="noreferrer">Codex, Claude Code, privacy, and removal instructions →</a></p></div></section>`;
  const verifyStepNumber = setupSurface === "mcp" ? 3 : 4;
  const verifyStep = `<section class="setup-step"><div class="step-number">${verifyStepNumber}</div><div class="step-body"><p class="eyebrow">VERIFY</p><h2>Send one real interaction</h2><p>${esc(integration.verify)}</p><p>${esc(surfaceResult)}</p><div class="verification"><div class="verification-row ${connected ? "complete" : "waiting"}"><b>${connected ? "✓" : "○"}</b><span><strong>${connected ? (setupSurface === "mcp" ? "Confirmed interaction received" : "Product connection works") : "Waiting for the first interaction"}</strong><small>${connected ? `${status.interactions.length} interaction${status.interactions.length === 1 ? "" : "s"} received for this product.` : "This page checks automatically every few seconds."}</small></span></div><div class="verification-row ${reviewed ? "complete" : "waiting"}"><b>${reviewed ? "✓" : "○"}</b><span><strong>${reviewed ? "Agent feedback received" : "Waiting for agent feedback"}</strong><small>${reviewed ? `${status.reports.length} feedback report${status.reports.length === 1 ? "" : "s"} received.` : "Feedback is a second milestone. The integration works as soon as the first interaction arrives."}</small></span></div></div><div class="setup-actions"><button class="button" data-refresh-setup>Check now</button>${connected ? `<button class="button primary" data-view="interactions">View first interaction</button>` : ""}${reviewed ? `<button class="button primary" data-view="feedback">View feedback</button>` : ""}</div>${setupSurface === "mcp" ? nativeMcpCoverage : ""}</div></section>`;
  const connections = dashboard.apiKeys.map((key) => {
    const keyStatus = setupConnectionStatus(key.id);
    const state = keyStatus.reports.length ? "Feedback received" : keyStatus.interactions.length ? "Connected" : "Never seen";
    return `<div class="connection-row"><span><strong>${esc(key.label)} <i class="key-kind ${esc(keyKind(key))}">${esc(keyKind(key))}</i></strong><small>${esc(key.prefix)}… · created ${date(key.createdAt)}</small><small>expires ${key.expiresAt ? date(key.expiresAt) : "never"} · ${key.lastUsedAt ? `last used ${date(key.lastUsedAt)}` : "never used"}</small></span><b class="${keyStatus.interactions.length ? "positive" : "neutral"}">${esc(state)}</b><button class="link-button" data-revoke-key="${esc(key.id)}">Rotate key</button></div>`;
  }).join("") || `<p class="muted">No integrations yet.</p>`;
  const readKeys = dashboard.apiKeys.filter((key) => keyKind(key) === "read");
  const visibleReadKey = dashboard.apiKeys.find((key) => key.id === readKeyId && keyKind(key) === "read") || readKeys[0];
  const readSecretCallout = readSecret ? `<div class="secret-callout"><div><b>Save this read key now</b><code>${esc(readSecret)}</code><small>It stays only in page memory and disappears on reload. Keep it in your MCP client environment as <code>AGENT_FEEDBACK_READ_KEY</code>. It can read this product's feedback but never write.</small></div><button class="button" data-copy="${esc(readSecret)}">Copy key</button></div>` : visibleReadKey ? `<div class="secret-callout"><div><b>Full read key is hidden</b><code>${esc(visibleReadKey.prefix)}…</code><small>Epode does not save full keys in browser storage. If it is not already in your MCP client, rotate this read key below and save the replacement during this page load.</small></div></div>` : "";
  const clientSnippets = readKeyClientSnippets();
  const activeClient = clientSnippets[readSnippetClient] ? readSnippetClient : "claude-code";
  const clientTabs = `<div class="install-methods">${Object.entries(clientSnippets).map(([id, client]) => `<button data-read-client="${esc(id)}" aria-pressed="${activeClient === id}">${esc(client.name)}</button>`).join("")}</div>`;
  const clientSnippet = clientSnippets[activeClient];
  const readEnvironment = `AGENT_FEEDBACK_READ_KEY=${readSecret || "paste_read_key_here"}`;
  const readConnect = readKeys.length ? `<h3>Set the client environment variable</h3><div class="copy-block"><pre><code>${esc(readEnvironment)}</code></pre><button class="button" data-copy="${esc(readEnvironment)}">Copy</button></div>${clientTabs}<div class="install-panel"><p>${esc(clientSnippet.note)}</p><div class="copy-block"><pre><code>${esc(clientSnippet.config)}</code></pre><button class="button" data-copy="${esc(clientSnippet.config)}">Copy</button></div></div>` : "";
  const readPanel = `<div class="read-key-panel"><h3>Read key for MCP clients</h3><p>A read key goes in an MCP client config — not a server environment variable — so an agent in your product's repository can pull this product's feedback. It cannot write.</p><form id="read-key-form" class="connection-form"><label><span>Label</span><input name="label" maxlength="80" placeholder="Repo read key"></label><label><span>Expires</span><select name="expiresIn"><option value="2592000">30 days</option><option value="7776000" selected>90 days</option><option value="31536000">1 year</option><option value="never">Never</option></select></label><button class="button">Create read key</button></form>${readSecretCallout}${readConnect}</div>`;
  return `${header("SETUP", `Connect ${dashboard.currentProduct.name}`, connected ? "Receiving data" : "Not connected")}${metricStrip([[setupKey ? "Ready" : "Missing", "Product key", setupKey ? "positive" : "negative"], [connected ? "Connected" : "Waiting", "Telemetry", connected ? "positive" : "neutral"], [reviewed ? "Received" : "Waiting", "Agent feedback", reviewed ? "positive" : "neutral"]])}<p class="setup-lede">Choose your stack, copy the ready installation, and send the first real interaction.</p><section class="setup-step"><div class="step-number">1</div><div class="step-body"><p class="eyebrow">INTEGRATION</p><h2>Choose how your product is served</h2><div class="choice-grid surfaces">${surfaces}</div><p class="selection-explanation"><strong>${esc(surface.name)}:</strong> ${esc(surface.detail)}</p><h3>Choose the integration</h3><div class="choice-grid stacks">${stacks}</div><p class="muted">For HTTP and HTML, choose which routes receive instructions in code—not in this dashboard.</p>${ready}</div></section>${legacyWarning}${installStep}${coverageStep}${verifyStep}<details class="existing-connections"><summary>Product keys (${dashboard.apiKeys.length})</summary><div>${connections}</div>${readPanel}</details>`;
}

function teamView() {
  const isOwner = dashboard.currentRole === "owner";
  const isAdmin = dashboard.currentRole === "admin";
  const canInvite = isOwner || isAdmin;
  const roleOptions = (role) => `<option value="member" ${role === "member" ? "selected" : ""}>Member</option><option value="admin" ${role === "admin" ? "selected" : ""}>Admin</option>`;
  const memberRows = dashboard.teamMembers.map((member) => {
    const isSelf = member.osUserId === dashboard.user.id;
    const canRemove = !isSelf && member.role !== "owner" && (isOwner || (isAdmin && member.role === "member"));
    const canTransfer = isOwner && !isSelf && member.role !== "owner";
    const roleControl = isOwner && member.role !== "owner" ? `<select class="compact-select" data-member-role="${esc(member.osUserId)}" aria-label="Role for ${esc(member.displayName)}">${roleOptions(member.role)}</select>` : `<b>${esc(title(member.role))}</b>`;
    return `<div class="team-row"><span><strong>${esc(member.displayName)}${isSelf ? " (you)" : ""}</strong>${member.email ? `<small>${esc(member.email)}</small>` : ""}</span>${roleControl}<span class="team-actions">${canTransfer ? `<button class="link-button" data-transfer-owner="${esc(member.osUserId)}" data-member-name="${esc(member.displayName)}">Transfer ownership</button>` : ""}${canRemove ? `<button class="link-button danger" data-remove-member="${esc(member.osUserId)}">Remove</button>` : ""}</span></div>`;
  }).join("");
  const pendingInvitations = dashboard.teamInvitations.filter((invitation) => invitation.inviteeKind !== "link");
  const invitationRows = pendingInvitations.map((invitation) => {
    const link = `${location.origin}/join/${invitation.id}`;
    const canRevoke = isOwner || (isAdmin && invitation.role === "member");
    const recipient = invitation.inviteeKind === "email" ? invitation.inviteeValue : "Private invitation";
    return `<div class="team-row"><span><strong>${esc(recipient)}</strong><small>${esc(title(invitation.role))} · expires ${date(invitation.expiresAt)}</small></span><button class="link-button" data-copy="${esc(link)}">Copy link</button><span>${canRevoke ? `<button class="link-button danger" data-revoke-invitation="${esc(invitation.id)}">Revoke</button>` : ""}</span></div>`;
  }).join("");
  const roleChoices = `${isOwner ? `<option value="admin">Admin</option>` : ""}<option value="member" selected>Member</option>`;
  const inviteForm = canInvite ? `<section class="team-invite"><h2>Invite teammates</h2><form id="team-invite-email-form"><label><span>Email address</span><input name="invitee" type="email" autocomplete="email" placeholder="teammate@example.com" maxlength="160" required></label><label><span>Role</span><select name="role">${roleChoices}</select></label><button class="button primary">Open email draft</button></form><button class="link-button team-invite-secondary" data-create-invite-link>Copy member invite link</button></section>` : `<p class="muted">Your ${esc(dashboard.currentRole)} role can view this team. An owner or admin manages membership.</p>`;
  const renameAction = canInvite ? `<button class="button" data-rename-team>Rename team</button>` : "";
  return `${header("TEAM", dashboard.workspace.name, `${dashboard.teamMembers.length} member${dashboard.teamMembers.length === 1 ? "" : "s"}`, renameAction)}${inviteForm}<section class="team-section"><h2>Members</h2><div class="team-list">${memberRows}</div></section>${canInvite ? `<section class="team-section"><h2>Pending invitations</h2>${invitationRows ? `<div class="team-list">${invitationRows}</div>` : `<p class="muted">No pending invitations.</p>`}</section>` : ""}`;
}

function policyView() {
  const settings = dashboard.currentEnvironment;
  return `${header("COLLECTION POLICY", "Data controls", dashboard.currentProduct.name)}<p class="page-context">These controls decide which machine-readable action a customer agent receives and how long product data stays available. Product traffic stays available if Epode is unavailable.</p><form id="policy-form" class="policy"><section><div><p class="eyebrow">FEEDBACK</p><h2>Feedback collection</h2><p>Choose how customer agents submit structured feedback after using your product.</p></div><label><span>Feedback mode</span><select name="feedbackMode"><option value="never_ask" ${settings.feedbackMode === "never_ask" ? "selected" : ""}>Never ask — submit autonomously</option><option value="ask_once" ${settings.feedbackMode === "ask_once" ? "selected" : ""}>Ask once — Epode remembers the answer</option><option value="ask_always" ${settings.feedbackMode === "ask_always" ? "selected" : ""}>Ask every time — request permission for each report</option><option value="off" ${settings.feedbackMode === "off" ? "selected" : ""}>Off — do not request feedback</option></select><small>Ask once lets the agent answer first, then returns only the permission action. Epode stores the decision under an HMAC-derived subject. Your opaque customerRef is stored separately with interaction telemetry for dashboard grouping and is never shown to the agent. A report action appears only after approval. Silence or ambiguity never becomes approval. Generic HTTP agents may still ignore a stored decision; MCP and trusted adapters are higher confidence.</small></label></section><input type="hidden" name="collectEventSummaries" value="off"><section><div><p class="eyebrow">RETENTION</p><h2>Data retention</h2><p>Choose a common period or enter any whole number from 1 to 365 days.</p></div><label><span>Retention days</span><input name="retentionDays" type="number" min="1" max="365" step="1" list="retention-day-presets" value="${esc(settings.retentionDays)}" required><datalist id="retention-day-presets"><option value="7"></option><option value="30"></option><option value="90"></option><option value="180"></option><option value="365"></option></datalist><small>Dashboard filtering changes immediately. Feedback reports, interactions, and sessions outside this window stop appearing right away; physical deletion may take up to the scheduled purge interval. Expired feedback, interactions, and sessions are then permanently removed. Durable Ask-once permission is separate and survives retention until it is explicitly changed or the product is deleted.</small></label></section><section class="guardrails"><div><p class="eyebrow">PRIVACY</p><h2>Outside the feedback protocol</h2><p>Integrations must never submit these values. Epode rejects unknown fields and common secret patterns, but your product remains responsible for keeping personal or customer content out of summaries.</p></div><ul><li>Prompts and transcripts</li><li>Secrets and authentication payloads</li><li>Personal data and raw customer content</li><li>Raw tool inputs or outputs</li><li>Unknown report fields</li></ul></section><div class="form-footer"><span>Current mode: <b>${esc(feedbackModeLabel(settings.feedbackMode))}</b> · ${esc(settings.retentionDays)} days</span><button class="button primary">Save changes</button></div></form>`;
}

function render() {
  if (!dashboard) return;
  document.title = `${title(currentView)} · ${dashboard.currentProduct?.name || dashboard.workspace.name} · Epode`;
  document.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-current", button.dataset.view === currentView ? "page" : "false"));
  if (!dashboard.products.length && !["team", "new-product"].includes(currentView)) {
    page.innerHTML = dashboard.currentRole === "member" ? empty("No product yet", "An owner or admin needs to create the first product.", "team") : productCreateView(true);
  } else {
    page.innerHTML = ({ home: homeView, feedback: feedbackView, interactions: interactionsView, sessions: sessionsView, setup: setupView, policy: policyView, team: teamView, "new-product": productCreateView }[currentView] || homeView)();
  }
  if (pendingHeadingFocus) {
    const heading = page.querySelector("h1, h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
    pendingHeadingFocus = false;
  }
  if (currentView !== "setup" || !setupConnectionId || setupConnectionStatus(setupConnectionId).reports.length) {
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
    if (target.hasAttribute("data-rename-team")) {
      const proposed = prompt("Team name", dashboard.workspace.name);
      if (proposed === null) return;
      const name = proposed.trim();
      if (name === dashboard.workspace.name) return;
      await request("/api/team", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await refresh();
      setNotice("Team renamed.");
    }
    if (target.hasAttribute("data-rename-product")) {
      const proposed = prompt("Product name", dashboard.currentProduct.name);
      if (proposed === null) return;
      const name = proposed.trim();
      if (name === dashboard.currentProduct.name) return;
      await request(`/api/products/${encodeURIComponent(dashboard.currentProduct.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await refresh();
      setNotice("Product renamed.");
    }
    if (target.hasAttribute("data-delete-product")) {
      const product = dashboard.currentProduct;
      const confirmation = prompt(`Type "${product.name}" to permanently delete this product and all of its data.`);
      if (confirmation === null) return;
      if (confirmation.trim() !== product.name) {
        setNotice("Product name did not match. Nothing was deleted.", 4500, "error");
        return;
      }
      await request(`/api/products/${encodeURIComponent(product.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });
      selectedProductId = "";
      selectedReport = null;
      selectedInteraction = null;
      selectedSession = null;
      apiSecret = "";
      setupConnectionId = null;
      currentView = "home";
      await refresh();
      setNotice(`${product.name} and its data were deleted.`);
    }
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
    if (target.dataset.report) { selectedReport = target.dataset.report; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.dataset.interaction) { selectedInteraction = target.dataset.interaction; selectedSession = null; currentView = "interactions"; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.dataset.session) { selectedSession = target.dataset.session; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.dataset.back) { selectedReport = null; selectedInteraction = null; selectedSession = null; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.dataset.openInteraction) { currentView = "interactions"; selectedInteraction = target.dataset.openInteraction; selectedReport = null; selectedSession = null; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.dataset.openSession) { currentView = "sessions"; selectedSession = target.dataset.openSession; selectedReport = null; selectedInteraction = null; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.dataset.openFeedback) { currentView = "feedback"; selectedReport = target.dataset.openFeedback; selectedInteraction = null; selectedSession = null; pendingHeadingFocus = true; syncUrl("push"); render(); }
    if (target.hasAttribute("data-copy-page-link")) { await copyText(location.href); setNotice("Link copied.", 1800); }
    if (target.hasAttribute("data-clear-filters")) { resetExplorer(); explorerRange = "30d"; syncUrl("replace"); render(); }
    if (target.dataset.loadMore) {
      target.disabled = true;
      if (target.dataset.loadMore === "reports") reportLimit = Math.min(reportLimit + 250, 10_000);
      if (target.dataset.loadMore === "interactions") interactionLimit = Math.min(interactionLimit + 250, 10_000);
      if (target.dataset.loadMore === "sessions") sessionLimit = Math.min(sessionLimit + 100, 10_000);
      await refresh();
      setNotice("Older data loaded.", 1800);
    }
    if (target.dataset.investigateView) {
      currentView = target.dataset.investigateView;
      selectedReport = null;
      selectedInteraction = null;
      selectedSession = null;
      explorerPrimary = target.dataset.investigateFilter || "all";
      explorerSecondary = "all";
      explorerQuery = target.dataset.investigateQuery || "";
      syncUrl("push");
      render();
    }
    if (target.dataset.copy) { await copyText(target.dataset.copy); setNotice("Copied.", 1800); }
    if (target.hasAttribute("data-create-invite-link")) {
      const body = await request("/api/team/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      });
      await copyText(`${location.origin}${body.joinPath}`);
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
      try {
        await refresh();
        setNotice("Dashboard loaded.", 1800);
      } finally {
        target.disabled = false;
      }
    }
    if (target.dataset.revokeKey) {
      const rotated = dashboard.apiKeys.find((key) => key.id === target.dataset.revokeKey);
      const kind = keyKind(rotated);
      if (!confirm(`Rotate this ${kind} key? The current key will keep working for one hour so you can deploy the replacement safely.`)) return;
      target.disabled = true;
      try {
        const body = await request(`/api/settings/api-keys/${target.dataset.revokeKey}/rotate`, {
          method: "POST",
        });
        if (kind === "read") {
          readSecret = body.secret;
          readKeyId = body.apiKey.id;
        } else {
          apiSecret = body.secret;
          setupConnectionId = body.apiKey.id;
        }
        await refresh();
        setNotice(kind === "read" ? "Read key rotated. Update AGENT_FEEDBACK_READ_KEY within one hour." : "Product key rotated. Deploy the new server-side key within one hour.", 6000);
      } finally {
        if (target.isConnected) target.disabled = false;
      }
    }
    if (target.dataset.readClient) {
      readSnippetClient = target.dataset.readClient;
      render();
    }
    if (target.dataset.removeMember) {
      if (!confirm("Remove this member from the team?")) return;
      await request(`/api/team/members/${encodeURIComponent(target.dataset.removeMember)}`, { method: "DELETE" });
      await refresh();
      setNotice("Team member removed.");
    }
    if (target.dataset.transferOwner) {
      if (!confirm(`Transfer team ownership to ${target.dataset.memberName}? You will become an admin.`)) return;
      await request(`/api/team/ownership/${encodeURIComponent(target.dataset.transferOwner)}`, { method: "POST" });
      await refresh();
      setNotice("Team ownership transferred.", 4500);
    }
    if (target.dataset.revokeInvitation) {
      if (!confirm("Revoke this invitation?")) return;
      await request(`/api/team/invitations/${encodeURIComponent(target.dataset.revokeInvitation)}`, { method: "DELETE" });
      await refresh();
      setNotice("Invitation revoked.");
    }
  } catch (error) {
    setNotice(error.message || "Request failed", 6000, "error");
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
      selectedReport = null;
      selectedInteraction = null;
      selectedSession = null;
      resetExplorer();
      apiSecret = "";
      setupConnectionId = null;
      readSecret = "";
      readKeyId = null;
      interactionLimit = 250;
      reportLimit = 250;
      sessionLimit = 100;
      await refresh();
    }
    if (event.target.id === "product-select") {
      selectedProductId = event.target.value;
      selectedReport = null;
      selectedInteraction = null;
      selectedSession = null;
      resetExplorer();
      apiSecret = "";
      setupConnectionId = null;
      readSecret = "";
      readKeyId = null;
      interactionLimit = 250;
      reportLimit = 250;
      sessionLimit = 100;
      await refresh();
    }
    if (event.target.dataset.memberRole) {
      const member = dashboard.teamMembers.find((entry) => entry.osUserId === event.target.dataset.memberRole);
      const previousRole = member?.role || "member";
      event.target.disabled = true;
      try {
        await request(`/api/team/members/${encodeURIComponent(event.target.dataset.memberRole)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: event.target.value }),
        });
        await refresh();
        setNotice("Member role updated.");
      } catch (error) {
        event.target.value = previousRole;
        throw error;
      } finally {
        if (event.target.isConnected) event.target.disabled = false;
      }
    }
  } catch (error) {
    setNotice(error.message || "Update failed", 6000, "error");
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
  if (!["product-form", "policy-form", "team-invite-email-form", "read-key-form", "feedback-workflow-form"].includes(event.target.id)) return;
  event.preventDefault();
  const form = new FormData(event.target);
  const submitButton = event.target.querySelector?.('[type="submit"], button');
  if (submitButton) submitButton.disabled = true;
  try {
    if (event.target.id === "feedback-workflow-form") {
      await request(`/api/dashboard/reports/${encodeURIComponent(event.target.dataset.reportId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: dashboard.currentProduct.id,
          status: form.get("status"),
          assigneeOsUserId: form.get("assignee") || null,
          tags: String(form.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
          internalNote: String(form.get("internalNote") || "").trim() || null,
        }),
      });
      await refresh();
      setNotice("Feedback triage updated.", 2200);
    }
    if (event.target.id === "product-form") {
      const body = await request("/api/products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: form.get("name") }) });
      selectedProductId = body.product.id;
      apiSecret = body.secret || "";
      setupConnectionId = body.apiKey?.id || null;
      currentView = "setup";
      await refresh();
      navigate("setup");
      setNotice(`${body.product.name} created. Choose its first integration.`, 4500);
    }
    if (event.target.id === "policy-form") {
      const retentionDays = Number(form.get("retentionDays"));
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
        throw new Error("Retention must be a whole number from 1 to 365 days.");
      }
      await request("/api/settings/policy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ environmentId: dashboard.currentEnvironment.id, feedbackMode: form.get("feedbackMode"), collectEventSummaries: false, retentionDays }) });
      await refresh();
      setNotice("Policy enforced. Update AGENT_FEEDBACK_MODE in deployed integrations so their instructions stay in sync.", 6000);
    }
    if (event.target.id === "read-key-form") {
      const expiresIn = String(form.get("expiresIn") || "7776000");
      const payload = { label: String(form.get("label") || "").trim() || "Repo read key", environmentId: dashboard.currentEnvironment.id, kind: "read" };
      if (expiresIn !== "never") payload.expiresInSeconds = Number(expiresIn);
      const body = await request("/api/settings/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      readSecret = body.secret;
      readKeyId = body.apiKey.id;
      await refresh();
      setNotice("Read key created. Save it now — it is shown once.");
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
    setNotice(error.message || "Request failed", 6000, "error");
  } finally {
    if (submitButton?.isConnected) submitButton.disabled = false;
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
  currentView = url.searchParams.get("view") || "home";
  selectedWorkspaceId = url.searchParams.get("team") || "";
  selectedProductId = url.searchParams.get("product") || "";
  selectedReport = url.searchParams.get("report");
  selectedInteraction = url.searchParams.get("interaction");
  selectedSession = url.searchParams.get("session");
  explorerQuery = url.searchParams.get("q") || "";
  explorerPrimary = url.searchParams.get("filter") || "all";
  explorerSecondary = url.searchParams.get("surface") || "all";
  explorerRange = validRanges.has(url.searchParams.get("range")) ? url.searchParams.get("range") : "30d";
  pendingHeadingFocus = true;
  refresh().catch(renderLoadError);
});
refresh().catch(renderLoadError);
