import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dashboardScript = await readFile(
  new URL("../backend/public/app.js", import.meta.url),
  "utf8",
);

test("setup starts with product surface and reveals only the selected stack", () => {
  assert.match(dashboardScript, /What are your customers' agents using\?/);
  assert.match(dashboardScript, /MCP server/);
  assert.match(dashboardScript, /HTTP API/);
  assert.match(dashboardScript, /Agent-readable website/);
  assert.match(dashboardScript, /setupStackOptions\[setupSurface\]/);
  assert.doesNotMatch(dashboardScript, /Run backend contract test/);
});

test("setup verifies the connection with data from its own product key", () => {
  assert.match(dashboardScript, /entry\.apiKeyId === apiKeyId/);
  assert.match(dashboardScript, /Waiting for the first interaction/);
  assert.match(dashboardScript, /Waiting for agent feedback/);
  assert.match(dashboardScript, /setupConnectionId = body\.apiKey\.id/);
});

test("setup communicates the HTTP and MCP evidence models separately", () => {
  assert.match(dashboardScript, /confirmed agent interaction/);
  assert.match(dashboardScript, /becomes confirmed when its receipt returns/);
  assert.match(dashboardScript, /product response never waits for Agent Feedback/i);
});
