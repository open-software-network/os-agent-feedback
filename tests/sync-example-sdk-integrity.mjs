#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesRoot = resolve(repoRoot, "examples");
const artifactPath = resolve(repoRoot, "backend/public/agent-feedback-node-0.1.0.tgz");
const dependencyName = "@agent-feedback/node";
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];

async function findFiles(directory, filename) {
  const found = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      found.push(...(await findFiles(path, filename)));
    } else if (entry.isFile() && entry.name === filename) {
      found.push(path);
    }
  }
  return found;
}

function resolvesToHostedArtifact(specifier, ownerPath) {
  return (
    typeof specifier === "string" &&
    specifier.startsWith("file:") &&
    resolve(dirname(ownerPath), specifier.slice("file:".length)) === artifactPath
  );
}

function hostedLockEntries(lockfile, lockfilePath) {
  return Object.entries(lockfile.packages || {}).filter(
    ([packagePath, metadata]) =>
      packagePath.endsWith("node_modules/@agent-feedback/node") &&
      resolvesToHostedArtifact(metadata?.resolved, lockfilePath),
  );
}

export async function findHostedExampleLockfiles() {
  const [manifestPaths, lockfilePaths] = await Promise.all([
    findFiles(examplesRoot, "package.json"),
    findFiles(examplesRoot, "package-lock.json"),
  ]);
  const availableLockfiles = new Set(lockfilePaths);
  const requiredLockfiles = new Set();

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const usesHostedArtifact = dependencySections.some((section) =>
      resolvesToHostedArtifact(manifest[section]?.[dependencyName], manifestPath),
    );
    if (!usesHostedArtifact) continue;

    const lockfilePath = resolve(dirname(manifestPath), "package-lock.json");
    if (!availableLockfiles.has(lockfilePath)) {
      throw new Error(
        `${relative(repoRoot, manifestPath)} uses the hosted Node SDK artifact without a package-lock.json`,
      );
    }
    requiredLockfiles.add(lockfilePath);
  }

  const hostedLockfiles = [];
  for (const lockfilePath of lockfilePaths) {
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
    const entries = hostedLockEntries(lockfile, lockfilePath);
    if (requiredLockfiles.has(lockfilePath) && entries.length === 0) {
      throw new Error(
        `${relative(repoRoot, lockfilePath)} does not lock the hosted Node SDK artifact`,
      );
    }
    if (entries.length > 0) hostedLockfiles.push(lockfilePath);
  }

  if (hostedLockfiles.length === 0) {
    throw new Error("No example lockfiles resolve the hosted Node SDK artifact");
  }
  return hostedLockfiles;
}

export async function expectedSdkIntegrity() {
  const artifact = await readFile(artifactPath);
  return `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
}

export async function syncExampleSdkIntegrity({ write = false } = {}) {
  const [expected, lockfilePaths] = await Promise.all([
    expectedSdkIntegrity(),
    findHostedExampleLockfiles(),
  ]);
  const staleLockfiles = [];

  for (const lockfilePath of lockfilePaths) {
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
    const entries = hostedLockEntries(lockfile, lockfilePath);
    if (entries.every(([, metadata]) => metadata.integrity === expected)) continue;

    staleLockfiles.push(lockfilePath);
    if (write) {
      for (const [, metadata] of entries) metadata.integrity = expected;
      await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
    }
  }

  if (staleLockfiles.length > 0 && !write) {
    throw new Error(
      `Example lockfile integrity is stale for ${staleLockfiles
        .map((lockfilePath) => relative(repoRoot, lockfilePath))
        .join(", ")}. Run pnpm build:artifacts.`,
    );
  }

  return {
    expected,
    lockfiles: lockfilePaths.map((lockfilePath) => relative(repoRoot, lockfilePath)),
    updated: staleLockfiles.map((lockfilePath) => relative(repoRoot, lockfilePath)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const write = process.argv.includes("--write");
  const result = await syncExampleSdkIntegrity({ write });
  process.stdout.write(
    `${write ? "Synchronized and verified" : "Verified"} Node SDK integrity for ${result.lockfiles.join(", ")}${result.updated.length > 0 ? ` (${result.updated.length} updated)` : ""}.\n`,
  );
}
