import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../backend/public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../backend/public/styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../backend/public/app.html", import.meta.url), "utf8");
const store = await readFile(new URL("../backend/src/store.rs", import.meta.url), "utf8");

test("observability explorers share search, facets, time range, and deep links", () => {
  assert.match(script, /function explorerToolbar/);
  assert.match(script, /Last 24 hours/);
  assert.match(script, /Last 7 days/);
  assert.match(script, /Last 30 days/);
  assert.match(script, /report: selectedReport/);
  assert.match(script, /interaction: selectedInteraction/);
  assert.match(script, /session: selectedSession/);
  assert.match(script, /data-copy-page-link/);
  assert.match(script, /data-refresh-data/);
  assert.match(script, /document\.title = `\$\{title\(currentView\)\}/);
  assert.match(script, /function renderLoadError/);
  assert.match(script, /function copyText/);
  assert.match(styles, /\.explorer-toolbar/);
  assert.match(styles, /\.explorer-table/);
});

test("feedback connects structured reports to interaction and session context", () => {
  assert.match(script, /Submitted by the customer’s agent/);
  assert.match(script, /Linked product context/);
  assert.match(script, /data-open-interaction/);
  assert.match(script, /data-open-session/);
  assert.match(script, /Highest severity/);
  assert.match(script, /Agent identity is not collected/);
  assert.match(script, /Search summaries, findings, topics, operation, or customer/);
  assert.match(script, /What the agent observed/);
  assert.match(script, /WORKAROUND USED/);
});

test("sessions expose proof-based grouping, aggregate health, and a linked timeline", () => {
  assert.match(script, /Agent journeys/);
  assert.match(script, /Proof-based continuity/);
  assert.match(script, /Interactions per session/);
  assert.match(script, /Interaction journey/);
  assert.match(script, /timeline-feedback/);
  assert.match(script, /never guesses continuity from timing or identity/);
  assert.match(styles, /\.session-timeline/);
  assert.match(script, /function sessionFeedbackSummary/);
  assert.doesNotMatch(script, /reports\.at\(-1\)\.impact/);
  assert.match(store, /started_at = LEAST\(sessions_v2\.started_at, EXCLUDED\.started_at\)/);
});

test("Home turns product health into an operational overview", () => {
  assert.match(html, /data-view="home">Home/);
  assert.doesNotMatch(html, /data-view="insights"/);
  assert.match(script, /function homeView/);
  assert.match(script, /view: currentView === "home" \? "" : currentView/);
  assert.match(script, /header\("HOME", dashboard\.currentProduct\.name, "Last 30 days"/);
  assert.match(script, /What agents reported/);
  assert.match(script, /Top operations/);
  assert.match(script, /From product response to feedback/);
  assert.match(script, /Where to look next/);
  assert.match(script, /Most common blocker/);
  assert.match(script, /Feedback gap/);
  assert.match(script, /Slowest operation/);
  assert.match(script, /data-investigate-view/);
  assert.match(styles, /\.investigation-grid/);
  assert.match(styles, /\.home-grid/);
});

test("the full app exposes live counts, setup health, and structured policy controls", () => {
  assert.match(html, /data-nav-count="feedback"/);
  assert.match(html, /data-nav-count="interactions"/);
  assert.match(html, /data-nav-count="sessions"/);
  assert.match(script, /Receiving data/);
  assert.match(script, /Product key/);
  assert.match(script, /Current mode:/);
  assert.match(script, /Independent agents cannot be forced to comply/);
});
