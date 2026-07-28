import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("../backend/public/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../backend/public/styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../backend/public/app.html", import.meta.url), "utf8");

test("observability explorers share search, facets, time range, and deep links", () => {
  assert.match(script, /function explorerToolbar/);
  assert.match(script, /Last 24 hours/);
  assert.match(script, /Last 7 days/);
  assert.match(script, /Last 30 days/);
  assert.match(script, /outcome: selectedOutcome/);
  assert.match(script, /interaction: selectedInteraction/);
  assert.match(script, /session: selectedSession/);
  assert.match(script, /data-copy-page-link/);
  assert.match(script, /data-refresh-data/);
  assert.match(script, /document\.title = `\$\{title\(currentView\)\}/);
  assert.match(styles, /\.explorer-toolbar/);
  assert.match(styles, /\.explorer-table/);
});

test("feedback connects qualitative outcome to interaction and session context", () => {
  assert.match(script, /Submitted by the customer’s agent/);
  assert.match(script, /Linked product context/);
  assert.match(script, /data-open-interaction/);
  assert.match(script, /data-open-session/);
  assert.match(script, /Runtime provenance/);
  assert.match(script, /Agent identity is not collected/);
  assert.match(script, /Search feedback, operation, or customer/);
});

test("sessions expose proof-based grouping, aggregate health, and a linked timeline", () => {
  assert.match(script, /Agent journeys/);
  assert.match(script, /Proof-based continuity/);
  assert.match(script, /Interactions per session/);
  assert.match(script, /Interaction journey/);
  assert.match(script, /timeline-feedback/);
  assert.match(script, /never guesses continuity from timing or identity/);
  assert.match(styles, /\.session-timeline/);
});

test("insights turn aggregate metrics into investigations", () => {
  assert.match(script, /From product response to outcome/);
  assert.match(script, /Where to look next/);
  assert.match(script, /Most failed operation/);
  assert.match(script, /Feedback gap/);
  assert.match(script, /Slowest operation/);
  assert.match(script, /data-investigate-view/);
  assert.match(styles, /\.investigation-grid/);
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
