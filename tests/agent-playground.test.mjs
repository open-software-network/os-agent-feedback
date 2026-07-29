import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../examples/node-express/src/index.js", import.meta.url),
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
