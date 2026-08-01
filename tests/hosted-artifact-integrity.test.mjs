import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { syncExampleSdkIntegrity } from "./sync-example-sdk-integrity.mjs";

const immutableArtifacts = new Map([
  [
    "agent-feedback-go-0.1.0.tar.gz",
    "4d2eaf5172283ce6b26c280135d2798df0771f8919d116775977dd76dd73ef78",
  ],
  [
    "agent-feedback-node-0.1.0.tgz",
    "1cbc2bae31c0d661ef699480fdd8695bc0163dd981fb5c0684e5677187efc4ea",
  ],
  [
    "agent-feedback-node-0.2.0.tgz",
    "515bbd3802cceee7f639c06765c91186bb1e1335e61df4bb2289282930ef813d",
  ],
  [
    "agent-feedback-node-0.2.1.tgz",
    "bcb14c4a5985f8c10fc67059bc1fb95cdf88c4b2c6cc16109535e1291a95eac7",
  ],
  [
    "agent-feedback-rust-0.1.0.tar.gz",
    "1eead0e3cb8808fc2e0ad288c486457fb8082b3a41b817bf8679035dacad47fc",
  ],
  [
    "agent_feedback-0.1.0-py3-none-any.whl",
    "7990587521ed31e4f347accc871256024ccd8073285a23cb485224e4f5aa795e",
  ],
  [
    "agent_feedback-0.2.0-py3-none-any.whl",
    "eea3fca557fdf39c5b5edfcbfe0bb260578e47b60ea0e6a748bf2dafdf1045af",
  ],
  [
    "agent_feedback-0.2.1-py3-none-any.whl",
    "84780bfa7ddff6f570f298b8cc57043eeca324c317d77af3a2204c24852728fa",
  ],
  [
    "agent-feedback-go-0.2.0.tar.gz",
    "5bab7a77474111c0650b514511f1adf1b247b1913c8af605d5fa52e9a7bbd13e",
  ],
  [
    "agent-feedback-go-0.2.1.tar.gz",
    "9364d1e00ed161e5a1f6c1ba4adae15d2d63e14cec017ab567d24a68e0721969",
  ],
  [
    "agent-feedback-rust-0.2.0.tar.gz",
    "c472a008ad70d3ce2b782d91106cecbedf8818d2074411f3a5c5f0e15be14b7d",
  ],
  [
    "agent-feedback-rust-0.2.1.tar.gz",
    "05375eb2264321b76493d8fc57b112f3906ded80a6deb1a400d18758a5410657",
  ],
  [
    "agent-feedback-protocol-v1.zip",
    "84c74beccabdbf771070cad001223df9335aa19894f9305b30afd224266188a6",
  ],
]);

const releaseVersion = "0.2.1";

test("SDK metadata and user agents share the current release version", async () => {
  const nodeManifest = JSON.parse(
    await readFile(new URL("../sdk/node/package.json", import.meta.url), "utf8"),
  );
  const pythonManifest = await readFile(
    new URL("../sdk/python/pyproject.toml", import.meta.url),
    "utf8",
  );
  const rustManifest = await readFile(new URL("../sdk/rust/Cargo.toml", import.meta.url), "utf8");
  const rustLock = await readFile(new URL("../sdk/rust/Cargo.lock", import.meta.url), "utf8");
  assert.equal(nodeManifest.version, releaseVersion);
  const manifestVersion = new RegExp(`^version = "${releaseVersion.replaceAll(".", "\\.")}"$`, "m");
  assert.match(pythonManifest, manifestVersion);
  assert.match(rustManifest, manifestVersion);
  assert.match(rustLock, manifestVersion);

  for (const sourcePath of [
    "sdk/node/src/agent.ts",
    "sdk/node/src/core.ts",
    "sdk/node/src/mcp.ts",
    "sdk/python/src/agent_feedback/agent.py",
    "sdk/python/src/agent_feedback/core.py",
    "sdk/go/agent.go",
    "sdk/go/agentfeedback.go",
    "sdk/rust/src/lib.rs",
  ]) {
    const source = await readFile(new URL(`../${sourcePath}`, import.meta.url), "utf8");
    assert.ok(source.includes(`/${releaseVersion}`), `${sourcePath} omits ${releaseVersion}`);
    assert.doesNotMatch(
      source,
      /agent-feedback[^"']*\/0\.2\.0/,
      `${sourcePath} still emits a 0.2.0 user agent`,
    );
  }
});

test("published hosted artifact filenames retain their original bytes", async () => {
  for (const [filename, expected] of immutableArtifacts) {
    const artifact = await readFile(new URL(`../backend/public/${filename}`, import.meta.url));
    const actual = createHash("sha256").update(artifact).digest("hex");
    assert.equal(actual, expected, `${filename} changed without a new versioned filename`);
  }
});

test("hosted Node examples lock the exact committed SDK artifact", async () => {
  await syncExampleSdkIntegrity();
});
