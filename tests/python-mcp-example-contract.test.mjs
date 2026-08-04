import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../examples/python-mcp/server.py", import.meta.url), "utf8");

test("Python MCP example takes account identity from trusted deployment config", () => {
  assert.match(source, /authenticated_account\s*=\s*os\.environ\["DEMO_ACCOUNT_REF"\]/);
  assert.match(source, /account\s*=\s*authenticated_account/);
  assert.doesNotMatch(source, /arguments\.get\("account_ref"\)/);
  assert.doesNotMatch(source, /def (?:create|revise)_summary\([^)]*account_ref/);
  assert.match(
    source,
    /result_session\.get\("session_ref"\)\s*or\s*arguments\.get\("session_ref"\)/,
  );
  assert.match(source, /journeys\.get\(session\)\s*!=\s*account/);
});
