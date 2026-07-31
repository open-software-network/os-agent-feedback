import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../examples/node-express/src/index.js", import.meta.url),
  "utf8",
);
const mcpSource = await readFile(
  new URL("../examples/node-mcp/src/index.js", import.meta.url),
  "utf8",
);

test("the hosted playground creates feedback opportunities and explicit sessions", () => {
  assert.match(source, /include: \["\/api\/status", "\/api\/recommendation"\]/);
  assert.match(source, /sessionRef: \(request\) => request\.header\("x-agent-session"\)/);
  assert.match(source, /customerRef: \(request\) => request\.header\("x-customer-ref"\)/);
  assert.match(source, /runtimeHint: \(request\) => request\.header\("user-agent"\)/);
  assert.match(source, /reliability/);
  assert.match(source, /speed/);
  assert.match(source, /cost/);
});

test("hosted HTTP and MCP examples support both consent modes", () => {
  assert.match(source, /process\.env\.AGENT_FEEDBACK_MODE \|\| "never_ask"/);
  assert.match(source, /feedbackMode,/);
  assert.match(mcpSource, /process\.env\.AGENT_FEEDBACK_MODE \|\| "never_ask"/);
  assert.match(mcpSource, /feedbackMode,/);
  assert.match(mcpSource, /record_product_feedback_consent/);
  assert.match(mcpSource, /Epode—not this client—remembers the decision/);
  assert.match(mcpSource, /Ask the exact returned question before each report/);
  assert.doesNotMatch(mcpSource, /customerRef: \(arguments_\) => arguments_\?\.experimentRef/);
  assert.match(mcpSource, /EPODE_EXAMPLE_ENABLE_EXPERIMENT_REFS/);
  assert.match(mcpSource, /sessionRef: experimentRefsEnabled/);
  assert.match(mcpSource, /verified MCP authentication/);
});
