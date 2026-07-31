#!/usr/bin/env node

/**
 * Experimental Epode project-rule installer.
 *
 * The public key is deliberately pinned in this executable. The matching private
 * key exists only in the localhost compliance lab. Production must replace both.
 */

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const EXPERIMENT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvrkU6TlsyhWOnTFLrltB8mlpzsjaVjp9bP9dawjl1ZY=
-----END PUBLIC KEY-----`;

const CODEX_BEGIN = "<!-- epode-project-feedback:begin -->";
const CODEX_END = "<!-- epode-project-feedback:end -->";
const ALLOWED_PATHS = {
  codex: new Set([".agents/epode-feedback-preference.md", "AGENTS.md"]),
  claude: new Set([
    ".agents/epode-feedback-preference.md",
    ".claude/rules/epode-product-feedback.md",
  ]),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

export function verifyEnvelope(envelope, runtime, now = Date.now()) {
  if (!exactKeys(envelope, ["manifest", "signature"])) {
    throw new Error("invalid signed envelope");
  }
  const { manifest, signature } = envelope;
  const validSignature = typeof signature === "string" && verify(
    null,
    Buffer.from(canonicalJson(manifest)),
    createPublicKey(EXPERIMENT_PUBLIC_KEY_PEM),
    Buffer.from(signature, "base64"),
  );
  if (!validSignature) throw new Error("manifest signature verification failed");
  if (!exactKeys(manifest, [
    "schemaVersion",
    "manifestId",
    "issuer",
    "productId",
    "productOrigin",
    "purpose",
    "contractVersion",
    "issuedAt",
    "expiresAt",
    "runtime",
    "files",
    "completion",
  ])) throw new Error("invalid manifest fields");
  if (manifest.schemaVersion !== 1 || manifest.contractVersion !== 1) {
    throw new Error("unsupported manifest version");
  }
  if (manifest.issuer !== "https://epode.ai" || manifest.runtime !== runtime) {
    throw new Error("manifest issuer or runtime mismatch");
  }
  if (!Number.isFinite(Date.parse(manifest.issuedAt))
    || !Number.isFinite(Date.parse(manifest.expiresAt))
    || Date.parse(manifest.issuedAt) > now + 60_000
    || Date.parse(manifest.expiresAt) <= now
    || Date.parse(manifest.expiresAt) - Date.parse(manifest.issuedAt) > 10 * 60_000) {
    throw new Error("manifest is expired or has an invalid lifetime");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 2) {
    throw new Error("manifest must contain exactly two files");
  }
  const allowed = ALLOWED_PATHS[runtime];
  const seen = new Set();
  for (const file of manifest.files) {
    if (!exactKeys(file, ["path", "operation", "sha256", "content"])) {
      throw new Error("invalid file manifest");
    }
    if (!allowed?.has(file.path) || seen.has(file.path) || isAbsolute(file.path)) {
      throw new Error("manifest path is not allowed");
    }
    seen.add(file.path);
    if (!["create_exact", "append_exact_block"].includes(file.operation)) {
      throw new Error("unsupported file operation");
    }
    if (file.operation === "append_exact_block"
      && (runtime !== "codex" || file.path !== "AGENTS.md")) {
      throw new Error("append operation is only allowed for Codex AGENTS.md");
    }
    if (typeof file.content !== "string" || file.content.length < 1
      || sha256(file.content) !== file.sha256) {
      throw new Error("manifest content hash mismatch");
    }
  }
  if (!seen.has(".agents/epode-feedback-preference.md")) {
    throw new Error("manifest is missing the revocation policy");
  }
  if (!exactKeys(manifest.completion, [
    "url",
    "method",
    "authorization",
    "idempotencyKey",
  ]) || manifest.completion.method !== "POST") {
    throw new Error("invalid completion action");
  }
  const origin = new URL(manifest.productOrigin);
  const completion = new URL(manifest.completion.url);
  if (origin.origin !== completion.origin || !manifest.completion.authorization
    || !manifest.completion.idempotencyKey) {
    throw new Error("completion action is not same-origin or authenticated");
  }
  return manifest;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertContainedWithoutSymlinks(root, relativePath) {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("target escapes project root");
  }
  let cursor = root;
  for (const segment of rel.split(sep)) {
    cursor = join(cursor, segment);
    if (!await pathExists(cursor)) continue;
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error("symlinked install path is not allowed");
  }
  return target;
}

async function ensureParent(root, target, createdDirectories) {
  const relParent = relative(root, dirname(target));
  let cursor = root;
  for (const segment of relParent.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (await pathExists(cursor)) {
      if (!(await lstat(cursor)).isDirectory()) throw new Error("install parent is not a directory");
      continue;
    }
    await mkdir(cursor);
    createdDirectories.push(cursor);
  }
}

function desiredContent(file, current) {
  if (file.operation === "create_exact") {
    if (current !== null && current !== file.content) throw new Error(`conflict at ${file.path}`);
    return file.content;
  }
  const hasBegin = current?.includes(CODEX_BEGIN);
  const hasEnd = current?.includes(CODEX_END);
  if (hasBegin || hasEnd) {
    if (hasBegin && hasEnd && current.includes(file.content)) return current;
    throw new Error("conflicting Epode block in AGENTS.md");
  }
  return `${current?.trimEnd() || ""}${current ? "\n\n" : ""}${file.content}`;
}

async function stageInstall(manifest, projectRoot, failAfterFirstRename = false) {
  const root = await realpath(projectRoot);
  const lockPath = join(root, ".epode-install.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const createdDirectories = [];
  const plans = [];
  let renamed = 0;
  let closed = false;
  const unlock = async () => {
    if (closed) return;
    closed = true;
    await lock.close();
    await rm(lockPath, { force: true });
  };
  const cleanupDirectories = async () => {
    for (const directory of [...createdDirectories].reverse()) {
      try { await rmdir(directory); } catch {}
    }
  };
  try {
    for (const file of manifest.files) {
      const target = await assertContainedWithoutSymlinks(root, file.path);
      await ensureParent(root, target, createdDirectories);
      const existed = await pathExists(target);
      const current = existed ? await readFile(target, "utf8") : null;
      const desired = desiredContent(file, current);
      const suffix = randomBytes(6).toString("hex");
      const staged = join(dirname(target), `.epode-stage-${suffix}`);
      const backup = join(dirname(target), `.epode-backup-${suffix}`);
      const handle = await open(staged, "wx", 0o600);
      await handle.writeFile(desired);
      await handle.sync();
      await handle.close();
      plans.push({ file, target, staged, backup, existed, desired, changed: desired !== current });
    }
    for (const plan of plans.filter((entry) => entry.changed)) {
      if (plan.existed) await rename(plan.target, plan.backup);
      await rename(plan.staged, plan.target);
      renamed += 1;
      if (failAfterFirstRename && renamed === 1) throw new Error("injected partial-install failure");
    }
    return {
      files: plans.map((plan) => ({
        path: plan.file.path,
        manifestContentSha256: plan.file.sha256,
        installedContentSha256: sha256(plan.desired),
      })),
      async rollback() {
        for (const plan of [...plans].reverse()) {
          await rm(plan.staged, { force: true });
          if (!plan.changed) continue;
          await rm(plan.target, { force: true });
          if (plan.existed && await pathExists(plan.backup)) await rename(plan.backup, plan.target);
        }
        await cleanupDirectories();
        await unlock();
      },
      async finalize() {
        for (const plan of plans) {
          await rm(plan.staged, { force: true });
          await rm(plan.backup, { force: true });
        }
        await unlock();
      },
    };
  } catch (error) {
    for (const plan of [...plans].reverse()) {
      await rm(plan.staged, { force: true });
      if (await pathExists(plan.backup)) {
        await rm(plan.target, { force: true });
        await rename(plan.backup, plan.target);
      } else if (!plan.existed && plan.changed) {
        await rm(plan.target, { force: true });
      }
    }
    await cleanupDirectories();
    await unlock();
    throw error;
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: { ...options?.headers, "x-epode-installer": "1" },
    redirect: "manual",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return body;
}

export async function installSignedManifest({
  manifestUrl,
  authorization,
  project,
  runtime,
  failAfterFirstRename = false,
}) {
  const envelope = await fetchJson(manifestUrl, {
    headers: { authorization },
  });
  const manifest = verifyEnvelope(envelope, runtime);
  const manifestOrigin = new URL(manifestUrl).origin;
  if (new URL(manifest.productOrigin).origin !== manifestOrigin) {
    throw new Error("manifest and product origins differ");
  }
  const transaction = await stageInstall(manifest, project, failAfterFirstRename);
  try {
    const completion = await fetchJson(manifest.completion.url, {
      method: "POST",
      headers: {
        authorization: manifest.completion.authorization,
        "content-type": "application/json",
        "idempotency-key": manifest.completion.idempotencyKey,
      },
      body: JSON.stringify({ manifestId: manifest.manifestId, files: transaction.files }),
    });
    await transaction.finalize();
    return completion;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "manifest-url": { type: "string" },
      authorization: { type: "string" },
      project: { type: "string", default: "." },
      runtime: { type: "string" },
    },
  });
  if (!values["manifest-url"] || !values.authorization
    || !["codex", "claude"].includes(values.runtime)) {
    throw new Error("manifest-url, authorization, and runtime are required");
  }
  const result = await installSignedManifest({
    manifestUrl: values["manifest-url"],
    authorization: values.authorization,
    project: values.project,
    runtime: values.runtime,
    failAfterFirstRename: process.env.EPODE_TEST_FAIL_AFTER_FIRST_RENAME === "1",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
