import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJson,
  installSignedManifest,
} from "../experiments/agent-compliance/trusted-project-rule-installer.mjs";

const PRIVATE_KEY = createPrivateKey(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOqQd0H/Igu6l0Ir88iHXv0Bc+icc+1gmjUnEv1R3fG2
-----END PRIVATE KEY-----`);
const POLICY_PATH = ".agents/epode-feedback-preference.md";
const POLICY = "# Signed Epode preference\n";
const RULE =
  "<!-- epode-project-feedback:begin -->\n# Signed rule\n<!-- epode-project-feedback:end -->\n";

function sha256(value) {
  return import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(value).digest("hex"),
  );
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture({ completionStatus = 200, mutateManifest } = {}) {
  const requests = [];
  const issuedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    manifestId: "manifest_test",
    issuer: "https://epode.ai",
    productId: "test-product",
    productOrigin: null,
    purpose: "bounded_product_outcome_feedback",
    contractVersion: 1,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 300_000).toISOString(),
    runtime: "codex",
    files: [
      {
        path: POLICY_PATH,
        operation: "create_exact",
        sha256: await sha256(POLICY),
        content: POLICY,
      },
      {
        path: "AGENTS.md",
        operation: "append_exact_block",
        sha256: await sha256(RULE),
        content: RULE,
      },
    ],
    completion: {
      url: null,
      method: "POST",
      authorization: "Bearer completion_test",
      idempotencyKey: "installation_test",
    },
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (request.url === "/manifest") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(server.envelope));
      return;
    }
    if (request.url === "/complete") {
      response.writeHead(completionStatus, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          completionStatus === 200
            ? { accepted: true, immediateFeedback: { action: "categorical_only" } }
            : { error: "unavailable" },
        ),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const origin = await listen(server);
  manifest.productOrigin = origin;
  manifest.completion.url = `${origin}/complete`;
  mutateManifest?.(manifest);
  server.envelope = {
    manifest,
    signature: sign(null, Buffer.from(canonicalJson(manifest)), PRIVATE_KEY).toString("base64"),
  };
  return {
    origin,
    manifest,
    requests,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withProject(callback) {
  const project = await mkdtemp(join(tmpdir(), "epode-installer-test-"));
  try {
    await mkdir(join(project, ".git"));
    await writeFile(join(project, "AGENTS.md"), "# Existing project rule\n");
    return await callback(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test("trusted installer verifies, atomically installs, and safely replays", async () => {
  const lab = await fixture();
  try {
    await withProject(async (project) => {
      const input = {
        manifestUrl: `${lab.origin}/manifest`,
        authorization: "Bearer manifest_test",
        project,
        runtime: "codex",
      };
      const first = await installSignedManifest(input);
      const second = await installSignedManifest(input);
      assert.equal(first.accepted, true);
      assert.equal(second.accepted, true);
      assert.equal(await readFile(join(project, POLICY_PATH), "utf8"), POLICY);
      const agents = await readFile(join(project, "AGENTS.md"), "utf8");
      assert.match(agents, /Existing project rule/);
      assert.equal(agents.split("epode-project-feedback:begin").length - 1, 1);
      assert.equal(lab.requests.filter((request) => request.url === "/complete").length, 2);
      for (const request of lab.requests) {
        assert.equal(request.headers["x-epode-installer"], "1");
      }
      assert.equal(lab.requests.at(-1).headers["idempotency-key"], "installation_test");
    });
  } finally {
    await lab.close();
  }
});

test("trusted installer rejects a forged signature before writing", async () => {
  const lab = await fixture();
  lab.server.envelope.signature = Buffer.alloc(64).toString("base64");
  try {
    await withProject(async (project) => {
      const before = await readFile(join(project, "AGENTS.md"), "utf8");
      await assert.rejects(
        () =>
          installSignedManifest({
            manifestUrl: `${lab.origin}/manifest`,
            authorization: "Bearer manifest_test",
            project,
            runtime: "codex",
          }),
        /signature/,
      );
      assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), before);
      await assert.rejects(readFile(join(project, POLICY_PATH)), /ENOENT/);
    });
  } finally {
    await lab.close();
  }
});

test("trusted installer rejects signed path escapes and symlinked parents", async (t) => {
  await t.test("path escape", async () => {
    const lab = await fixture({
      mutateManifest: (manifest) => {
        manifest.files[0].path = "../outside.md";
      },
    });
    try {
      await withProject(async (project) => {
        await assert.rejects(
          () =>
            installSignedManifest({
              manifestUrl: `${lab.origin}/manifest`,
              authorization: "Bearer manifest_test",
              project,
              runtime: "codex",
            }),
          /path is not allowed/,
        );
      });
    } finally {
      await lab.close();
    }
  });

  await t.test("symlinked parent", async () => {
    const lab = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "epode-installer-outside-"));
    try {
      await withProject(async (project) => {
        await symlink(outside, join(project, ".agents"));
        await assert.rejects(
          () =>
            installSignedManifest({
              manifestUrl: `${lab.origin}/manifest`,
              authorization: "Bearer manifest_test",
              project,
              runtime: "codex",
            }),
          /symlinked install path/,
        );
        await assert.rejects(readFile(join(outside, "epode-feedback-preference.md")), /ENOENT/);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
      await lab.close();
    }
  });
});

test("trusted installer rolls back partial writes and backend failure", async (t) => {
  await t.test("injected rename failure", async () => {
    const lab = await fixture();
    try {
      await withProject(async (project) => {
        const before = await readFile(join(project, "AGENTS.md"), "utf8");
        await assert.rejects(
          () =>
            installSignedManifest({
              manifestUrl: `${lab.origin}/manifest`,
              authorization: "Bearer manifest_test",
              project,
              runtime: "codex",
              failAfterFirstRename: true,
            }),
          /partial-install/,
        );
        assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), before);
        await assert.rejects(readFile(join(project, POLICY_PATH)), /ENOENT/);
        assert.equal(lab.requests.filter((request) => request.url === "/complete").length, 0);
      });
    } finally {
      await lab.close();
    }
  });

  await t.test("completion failure", async () => {
    const lab = await fixture({ completionStatus: 503 });
    try {
      await withProject(async (project) => {
        const before = await readFile(join(project, "AGENTS.md"), "utf8");
        await assert.rejects(
          () =>
            installSignedManifest({
              manifestUrl: `${lab.origin}/manifest`,
              authorization: "Bearer manifest_test",
              project,
              runtime: "codex",
            }),
          /request failed \(503\)/,
        );
        assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), before);
        await assert.rejects(readFile(join(project, POLICY_PATH)), /ENOENT/);
      });
    } finally {
      await lab.close();
    }
  });
});
