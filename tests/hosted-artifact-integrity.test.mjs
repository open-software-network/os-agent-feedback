import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { syncExampleSdkIntegrity } from "./sync-example-sdk-integrity.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const immutableArtifacts = new Map([
  [
    "agent-feedback-integrations-0.2.2.json",
    "23d96e8be175c3844fa8c2caec0dc8c6be17444b27d2a3e0cadc36d68b304eaa",
  ],
  [
    "agent-feedback-integrations-0.3.0.json",
    "6620ccc7126c54bfc5bae8c893e62d726bb1351dbaca1b4194f122fd6b657de3",
  ],
  [
    "agent-feedback-integrations-0.3.1.json",
    "b802632b17760d1bbf8df3a96be080bf1468c708e4b3a85bb8ce0d70e267857a",
  ],
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
    "agent-feedback-node-0.2.2.tgz",
    "a108603544c2d17af6859c45d994593a246401ca2f0def1fbeb43f74f5c16fe8",
  ],
  [
    "agent-feedback-node-0.3.0.tgz",
    "0c2ed9e474de55e72b964732ec24b741f3424078c71f4e19f4678cfe88e65a07",
  ],
  [
    "agent-feedback-node-0.3.1.tgz",
    "f5f88617367855adcf10eb11c2e26b197f8a46a99140c1ca170c4d5e9047acb9",
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
    "agent_feedback-0.2.2-py3-none-any.whl",
    "5723fd4e86c140218708f9e23187e932cfa1d39f85b29e9d76cbc8dbb6fb0ea7",
  ],
  [
    "agent_feedback-0.3.0-py3-none-any.whl",
    "e3481b97914c644d041d773866061a9469501e85e77c5448c41e0fde8a6ef730",
  ],
  [
    "agent_feedback-0.3.1-py3-none-any.whl",
    "bc1bdc56eb086d81734ff5dcbd21066a8a17c9bfc5b3dacc961ab3a96305303c",
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
    "agent-feedback-go-0.2.2.tar.gz",
    "7f28ce6fb875167aac3afab974ca7cfc5896043e69ed136c375a99b9cde6cc15",
  ],
  [
    "agent-feedback-go-0.3.0.tar.gz",
    "65ca44b7a44f22eb5f0b9a28c9a2b6076f8e2aada0126fc9d9eabb08dfba811a",
  ],
  [
    "agent-feedback-go-0.3.1.tar.gz",
    "aa39c1fd9b64cf602942520711a6feac1d5c75cfef4dad35d590e2b76d83538e",
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
    "agent-feedback-rust-0.2.2.tar.gz",
    "f5bc42f38cea06b41449f0ae7b753b602d8e3a5dcf4a98fb3d8c21cd25fcfc62",
  ],
  [
    "agent-feedback-rust-0.3.0.tar.gz",
    "27f43efad763e6b0a221146d23fb18bac80e675c58c00995b6112e1277bc31ed",
  ],
  [
    "agent-feedback-rust-0.3.1.tar.gz",
    "0d26e766d1e12ced3919a33d06575ba2dc4aaa8a285f8e7e3b9b069a4144b77b",
  ],
  [
    "agent-feedback-protocol-v1.zip",
    "84c74beccabdbf771070cad001223df9335aa19894f9305b30afd224266188a6",
  ],
  [
    "agent-feedback-protocol-v1-0.2.2.zip",
    "ba3b239e2bf5de1514ca866c5a50a369d9a396ea440c1f65525b529be9025845",
  ],
  [
    "agent-feedback-protocol-v1-0.3.0.zip",
    "ae3a670fcaf903c781155ec5002874cbe079996b2c6d28221414100e5d86735b",
  ],
  [
    "agent-feedback-protocol-v1-0.3.1.zip",
    "ae3a670fcaf903c781155ec5002874cbe079996b2c6d28221414100e5d86735b",
  ],
]);

const releaseVersion = "0.3.1";

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

test("the versioned protocol bundle is byte-identical across timezones and exact to source", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "epode-protocol-bundle-"));
  try {
    const utcBundle = join(scratch, "utc.zip");
    const kiritimatiBundle = join(scratch, "kiritimati.zip");
    for (const [timezone, output] of [
      ["UTC", utcBundle],
      ["Pacific/Kiritimati", kiritimatiBundle],
    ]) {
      await execFileAsync(
        "bash",
        ["tests/build-hosted-artifacts.sh", "--protocol-bundle", output],
        {
          cwd: repoRoot,
          env: { ...process.env, TZ: timezone },
        },
      );
    }
    assert.deepEqual(await readFile(utcBundle), await readFile(kiritimatiBundle));
    const listing = (
      await execFileAsync("unzip", ["-Z1", utcBundle], { cwd: repoRoot, encoding: "utf8" })
    ).stdout
      .trim()
      .split("\n")
      .sort();
    const protocolFiles = [
      "README.md",
      "conformance.json",
      "consent-decision.schema.json",
      "envelope.schema.json",
      "feedback-report.schema.json",
      "telemetry-batch.schema.json",
    ];
    assert.deepEqual(listing, protocolFiles.map((file) => `protocol/v1/${file}`).sort());
    for (const file of protocolFiles) {
      const bundled = (
        await execFileAsync("unzip", ["-p", utcBundle, `protocol/v1/${file}`], {
          cwd: repoRoot,
          encoding: "buffer",
        })
      ).stdout;
      assert.deepEqual(bundled, await readFile(new URL(`../protocol/v1/${file}`, import.meta.url)));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the API image ledger rejects missing, corrupt, empty, and malformed inputs", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "epode-image-ledger-"));
  const fakeBin = join(scratch, "bin");
  const publicDir = join(scratch, "public");
  const ledgerPath = join(scratch, "ledger.json");
  await mkdir(fakeBin);
  await mkdir(publicDir);
  const fakeDocker = join(fakeBin, "docker");
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  create) echo fake-container ;;
  cp) cp -R "\${FAKE_DOCKER_PUBLIC}/." "$3" ;;
  rm) ;;
  *) exit 64 ;;
esac
`,
  );
  await chmod(fakeDocker, 0o755);
  const first = Buffer.from("first immutable artifact\n");
  const second = Buffer.from("second immutable artifact\n");
  const ledger = {
    "agent-feedback-first.tgz": sha256(first),
    "agent-feedback-second.zip": sha256(second),
  };
  const environment = {
    ...process.env,
    FAKE_DOCKER_PUBLIC: publicDir,
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const verify = () =>
    execFileAsync(
      "bash",
      ["scripts/verify-image-artifact-ledger.sh", "example.test/api@sha256:test", ledgerPath],
      { cwd: repoRoot, env: environment },
    );
  try {
    await writeFile(join(publicDir, "agent-feedback-first.tgz"), first);
    await writeFile(join(publicDir, "agent-feedback-second.zip"), second);
    await writeFile(ledgerPath, JSON.stringify(ledger));
    assert.match((await verify()).stdout, /Verified cumulative immutable hosted artifacts/);

    await rm(join(publicDir, "agent-feedback-second.zip"));
    await assert.rejects(verify(), /would remove immutable hosted artifact/);
    await writeFile(join(publicDir, "agent-feedback-second.zip"), "corrupt\n");
    await assert.rejects(verify(), /contains unexpected bytes/);

    await writeFile(ledgerPath, "{}");
    await assert.rejects(verify(), /non-empty filename-to-SHA-256 object/);
    await writeFile(ledgerPath, "not json");
    await assert.rejects(verify(), /non-empty filename-to-SHA-256 object/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("public integration manifest pins every current hosted artifact", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../backend/public/agent-feedback-integrations-0.3.1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.release, releaseVersion);
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [
    "go",
    "node",
    "protocol",
    "python",
    "rust",
  ]);
  for (const artifact of Object.values(manifest.artifacts)) {
    assert.equal(
      immutableArtifacts.get(artifact.filename),
      artifact.sha256,
      `${artifact.filename} is not pinned to the immutable ledger`,
    );
  }
});

test("rollback verifier ledger matches every historical hosted artifact", async () => {
  const rollbackLedger = JSON.parse(
    await readFile(new URL("../scripts/hosted-artifact-ledger.json", import.meta.url), "utf8"),
  );
  const immutablePackageEntries = [...immutableArtifacts].filter(
    ([filename]) => !filename.startsWith("agent-feedback-integrations-"),
  );
  assert.deepEqual(
    Object.fromEntries(immutablePackageEntries),
    rollbackLedger,
    "rollback verification ledger drifted from immutable hosted bytes",
  );
});

test("the example image build context includes every versioned Node artifact", async () => {
  const dockerignore = await readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  assert.match(dockerignore, /^!backend\/public\/agent-feedback-node-\*\.tgz$/m);
  assert.doesNotMatch(dockerignore, /^!backend\/public\/agent-feedback-node-\d/m);
});

test("hosted Node examples lock the exact committed SDK artifact", async () => {
  await syncExampleSdkIntegrity();
});
