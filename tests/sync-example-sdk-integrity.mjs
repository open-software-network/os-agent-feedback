#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = resolve(repoRoot, "backend/public/agent-feedback-node-0.1.0.tgz");
export const exampleLockfiles = [
  resolve(repoRoot, "examples/node-express/package-lock.json"),
  resolve(repoRoot, "examples/node-mcp/package-lock.json"),
];

export async function expectedSdkIntegrity() {
  const artifact = await readFile(artifactPath);
  return `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
}

export async function syncExampleSdkIntegrity({ write = false } = {}) {
  const expected = await expectedSdkIntegrity();
  const stale = [];
  for (const lockfilePath of exampleLockfiles) {
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
    const sdk = lockfile.packages?.["node_modules/@agent-feedback/node"];
    if (!sdk || sdk.resolved !== "file:../../backend/public/agent-feedback-node-0.1.0.tgz") {
      throw new Error(`${lockfilePath} does not resolve the committed Node SDK artifact`);
    }
    if (sdk.integrity === expected) continue;
    stale.push(lockfilePath);
    if (write) {
      sdk.integrity = expected;
      await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
    }
  }
  if (stale.length && !write) {
    throw new Error(
      `Example lockfile integrity is stale for ${stale.join(", ")}. Run pnpm build:artifacts.`,
    );
  }
  return { expected, updated: stale };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const write = process.argv.includes("--write");
  const result = await syncExampleSdkIntegrity({ write });
  process.stdout.write(
    `${write ? "Synchronized" : "Verified"} Node SDK integrity for ${exampleLockfiles.length} example lockfiles${result.updated.length ? ` (${result.updated.length} updated)` : ""}.\n`,
  );
}
