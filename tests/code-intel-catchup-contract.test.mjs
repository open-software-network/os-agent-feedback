import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "verify-code-intel-catchup.sh");
const workflow = path.join(root, ".github", "workflows", "catchup-code-intel-production.yml");

test("code-intel catch-up lint pins every reviewed migration hash", () => {
  const output = execFileSync("bash", [script, "lint"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.match(output, /target_revision=d170746d238930a4d018aa97dcf4e1056c4af6b0/);
  for (const version of [35, 36, 37, 38]) {
    assert.match(output, new RegExp(`migration_${version}_sha256=[0-9a-f]{64}`));
    assert.match(output, new RegExp(`migration_${version}_sha384=[0-9a-f]{96}`));
  }
});

test("code-intel catch-up lint fails closed on migration drift", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "epode-code-intel-catchup-"));
  await mkdir(path.join(scratch, "scripts"), { recursive: true });
  await mkdir(path.join(scratch, "backend", "migrations"), { recursive: true });
  const copiedScript = path.join(scratch, "scripts", "verify-code-intel-catchup.sh");
  await copyFile(script, copiedScript);
  await chmod(copiedScript, 0o755);

  for (const name of [
    "0035_report_code_hints.sql",
    "0036_code_match_verification_analytics.sql",
    "0037_code_match_verification_retries.sql",
    "0038_verified_code_hints.sql",
  ]) {
    await copyFile(
      path.join(root, "backend", "migrations", name),
      path.join(scratch, "backend", "migrations", name),
    );
  }
  const tampered = path.join(scratch, "backend", "migrations", "0038_verified_code_hints.sql");
  await writeFile(tampered, `${await readFile(tampered, "utf8")}\n-- drift\n`);

  const result = spawnSync("bash", [copiedScript, "lint"], {
    cwd: scratch,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /0038_verified_code_hints\.sql SHA-256 mismatch/);
});

test("code-intel catch-up source preserves atomic and rollback safety guards", async () => {
  const source = await readFile(script, "utf8");

  assert.match(source, /lint \| verify-before \| apply \| verify-after \| rollback-empty/);
  assert.match(source, /if \[\[ "\$mode" == "verify-after" \]\]/);
  assert.match(source, /EXPECTED_SCHEMA_FINGERPRINT is required for \$mode/);
  assert.match(source, /emit_output database_version "\$previous_version"/);
  assert.match(source, /emit_output database_version "\$target_version"/);
  assert.match(source, /emit_output schema_fingerprint "\$fingerprint"/);
  assert.match(
    source,
    /pg_try_advisory_xact_lock\(hashtext\('epode'\), hashtext\('additive-schema-expansion'\)\)/,
  );
  assert.match(source, /LOCK TABLE _sqlx_migrations IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(source, /SET LOCAL lock_timeout = '5s'/);
  assert.match(source, /SET LOCAL statement_timeout = '60s'/);
  assert.match(source, /partial catch-up schema appeared after preflight/);
  assert.match(source, /another client transaction became active after preflight/);

  const applyStart = source.indexOf("apply_catchup() {");
  const rollbackStart = source.indexOf("rollback_empty() {");
  const applySource = source.slice(applyStart, rollbackStart);
  assert.ok(applyStart >= 0 && rollbackStart > applyStart);
  assert.equal((applySource.match(/BEGIN;/g) ?? []).length, 1);
  assert.equal((applySource.match(/COMMIT;/g) ?? []).length, 1);
  for (const version of [35, 36, 37, 38]) {
    assert.match(applySource, new RegExp(`\\\\i backend/migrations/00${version}_`));
    assert.match(applySource, new RegExp(`VALUES \\(${version},`));
  }

  assert.match(source, /CONFIRM_EMPTY_ROLLBACK=rollback-code-intel-35-38/);
  assert.match(source, /rollback would destroy % catch-up rows/);
  assert.match(
    source,
    /LOCK TABLE report_code_hints, match_analytics, code_match_queue, code_match_verification_analytics IN ACCESS EXCLUSIVE MODE/,
  );
  assert.doesNotMatch(source, /DROP TABLE[^;]*CASCADE/);
  assert.match(source, /DELETE FROM _sqlx_migrations WHERE version BETWEEN 35 AND 38/);
});

test("code-intel catch-up rejects unknown modes before database access", () => {
  const result = spawnSync("bash", [script, "surprise"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /mode must be lint, verify-before, apply, verify-after, or rollback-empty/,
  );
});

test("catch-up workflow binds real recovery evidence to canary-first production rollout", async () => {
  const source = await readFile(workflow, "utf8");

  assert.match(source, /volumeInstanceBackupList/);
  assert.match(source, /pg_dump "\$PRODUCTION_DATABASE_URL"/);
  assert.match(source, /pg_restore --exit-on-error/);
  assert.match(source, /needs: \[plan, recovery_test\]/);
  assert.match(source, /needs: \[plan, recovery_test, canary_schema\]/);
  assert.match(
    source,
    /EXPECTED_SCHEMA_FINGERPRINT: \$\{\{ needs\.canary_schema\.outputs\.schema_fingerprint \}\}/,
  );
  assert.match(source, /active_id.*previous\.outputs\.api_deployment_id/);
  assert.match(source, /CONFIRM_EMPTY_ROLLBACK: rollback-code-intel-35-38/);
  assert.match(source, /The target API may have become active; schema rollback is forbidden/);
  assert.doesNotMatch(source, /restore_api_after_smoke/);
  assert.doesNotMatch(
    source,
    /railway-deploy-image\.sh[\s\\]+production[\s\\]+"\$API_SERVICE"[\s\\]+"\$\{\{ steps\.previous\.outputs\.api_ref/,
  );
});
