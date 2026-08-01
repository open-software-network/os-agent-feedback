import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const publicRoot = new URL("../backend/public/", import.meta.url);
const release = "0.3.0";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const artifactBodies = new Map();
const artifact = async (filename, mediaType, metadata = {}) => {
  const body = await readFile(new URL(filename, publicRoot));
  artifactBodies.set(filename, body);
  return { filename, sha256: sha256(body), mediaType, ...metadata };
};
const manifest = {
  schemaVersion: 1,
  release,
  artifacts: {
    node: await artifact(`agent-feedback-node-${release}.tgz`, "application/gzip"),
    python: await artifact(`agent_feedback-${release}-py3-none-any.whl`, "application/zip"),
    go: await artifact(`agent-feedback-go-${release}.tar.gz`, "application/gzip"),
    rust: await artifact(`agent-feedback-rust-${release}.tar.gz`, "application/gzip"),
    protocol: await artifact(`agent-feedback-protocol-v1.zip`, "application/zip"),
  },
};
const legacyArtifacts = structuredClone(manifest.artifacts);
const protocolBody = artifactBodies.get("agent-feedback-protocol-v1.zip");
const versionedProtocolFilename = `agent-feedback-protocol-v1-${release}.zip`;
artifactBodies.set(versionedProtocolFilename, protocolBody);
manifest.artifacts.protocol = {
  filename: versionedProtocolFilename,
  sha256: sha256(protocolBody),
  mediaType: "application/zip",
  protocolVersion: 1,
  bundleRelease: release,
};

test("public integration smoke validates strict manifests, legacy rollback, archive types, and hashes", async () => {
  let discoveryMode = "manifest";
  let servedManifest = structuredClone(manifest);
  let corruptNode = false;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/api/health") {
      response.writeHead(200).end("ok");
      return;
    }
    if (request.url === "/auth/start") {
      response.writeHead(303, {
        location: `${origin}/authorize`,
        "set-cookie": [
          "af_oa_pkce=test; Secure; Path=/; SameSite=Lax; HttpOnly",
          "af_oa_state=test; SameSite=Lax; HttpOnly; Path=/; Secure",
        ],
      });
      response.end();
      return;
    }
    if (request.url === "/.well-known/agent-feedback-v1.json") {
      const advertisedArtifacts =
        discoveryMode === "legacy" ? legacyArtifacts : servedManifest.artifacts;
      const discovery = {
        integrations: Object.fromEntries(
          Object.entries(advertisedArtifacts).map(([name, entry]) => [
            name,
            `${origin}/static/${entry.filename}`,
          ]),
        ),
      };
      if (discoveryMode === "manifest") {
        discovery.integrityManifest = `${origin}/static/agent-feedback-integrations-${release}.json`;
      } else if (discoveryMode === "empty-manifest") {
        discovery.integrityManifest = "";
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(discovery));
      return;
    }
    if (request.url === `/static/agent-feedback-integrations-${release}.json`) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(servedManifest));
      return;
    }
    const filename = request.url?.replace("/static/", "");
    if (filename && artifactBodies.has(filename)) {
      if (corruptNode && filename === manifest.artifacts.node.filename) {
        response.writeHead(200).end("not the reviewed archive");
      } else {
        response.writeHead(200).end(artifactBodies.get(filename));
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const environment = {
    ...process.env,
    EPODE_VERIFY_ALLOW_HTTP_LOCALHOST: "1",
    EPODE_VERIFY_RETRIES: "0",
    EPODE_VERIFY_RETRY_DELAY: "0",
  };
  const verify = () =>
    execFileAsync("bash", ["scripts/verify-public-integration-surface.sh", origin, origin], {
      cwd: new URL("..", import.meta.url),
      env: environment,
    });
  const rejectsWith = async (pattern) => {
    await assert.rejects(verify(), (error) => {
      assert.match(`${error.stdout}${error.stderr}`, pattern);
      return true;
    });
  };
  try {
    assert.match((await verify()).stdout, /Verified public health/);

    discoveryMode = "legacy";
    assert.match((await verify()).stdout, /Verified public health/);

    discoveryMode = "empty-manifest";
    await rejectsWith(/discovery is malformed/);

    discoveryMode = "manifest";
    servedManifest = structuredClone(manifest);
    servedManifest.release = "9.9.9";
    await rejectsWith(/manifest is malformed, incomplete, or version-mixed/);

    servedManifest = structuredClone(manifest);
    servedManifest.artifacts.protocol.bundleRelease = "9.9.9";
    await rejectsWith(/manifest is malformed, incomplete, or version-mixed/);

    servedManifest = structuredClone(manifest);
    servedManifest.artifacts.node.mediaType = "application/octet-stream";
    await rejectsWith(/manifest is malformed, incomplete, or version-mixed/);

    servedManifest = structuredClone(manifest);
    servedManifest.artifacts.node.unreviewed = true;
    await rejectsWith(/manifest is malformed, incomplete, or version-mixed/);

    servedManifest = structuredClone(manifest);
    corruptNode = true;
    await rejectsWith(/does not match the reviewed filename and SHA-256 manifest/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
