import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoFile = (path) => new URL(`../${path}`, import.meta.url);

test("API and web images are built together for every protected-main commit", async () => {
  for (const workflow of ["build-api.yml", "build-web.yml"]) {
    const source = await readFile(repoFile(`.github/workflows/${workflow}`), "utf8");
    assert.match(source, /push:\s*\n\s+branches:\s*\[main\]/);
    assert.doesNotMatch(source, /^\s+paths(?:-ignore)?:/m);
    assert.match(source, /org\.opencontainers\.image\.revision/);
  }
});

test("canary deployment is main-only, same-commit, serialized, and fail-closed", async () => {
  const source = await readFile(repoFile(".github/workflows/deploy-v2-canary.yml"), "utf8");
  assert.match(source, /group: epode-release-mutation/);
  assert.match(source, /Require a protected-main workflow definition/);
  assert.match(source, /refs\/heads\/\$\{DEFAULT_BRANCH\}/);
  assert.match(source, /api_resolved_revision" != "\$web_resolved_revision/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /verify-image-artifact-ledger\.sh/);
  assert.match(source, /EPODE_CANARY_STATUS=pending/);
  assert.match(source, /EPODE_CANARY_STATUS=verified/);
  assert.match(source, /EPODE_CANARY_API_REF=invalidated/);
  assert.doesNotMatch(
    source,
    /"EPODE_CANARY_(?:API_REF|API_DIGEST|API_DEPLOYMENT_ID|REVISION|WEB_REF|WEB_DIGEST|WEB_DEPLOYMENT_ID)="/,
    "Railway CLI rejects empty KEY= assignments, so invalidation must use explicit sentinel values",
  );
  assert.match(source, /Restore previous routing and API after failed canary validation/);
  assert.match(source, /Restore previous web after failed canary validation/);
  assert.ok(
    source.indexOf("Capture recoverable canary state") <
      source.indexOf("Validate services and domains; provision public variables"),
    "the old routes and images must be captured before canary routing is changed",
  );
  const routing = source.slice(
    source.indexOf("Validate services and domains; provision public variables"),
    source.indexOf("Invalidate any previous canary attestation"),
  );
  assert.match(routing, /PREVIOUS_PUBLIC_BASE_URL/);
  assert.match(routing, /PREVIOUS_WEB_APP_URL/);
  assert.match(routing, /PREVIOUS_API_URL/);
  assert.match(routing, /trap restore_routing_on_error EXIT/);
  const restoreApi = source.slice(
    source.indexOf("Restore previous routing and API after failed canary validation"),
    source.indexOf("Restore previous web after failed canary validation"),
  );
  assert.match(restoreApi, /PUBLIC_BASE_URL=\$PREVIOUS_PUBLIC_BASE_URL/);
  assert.match(restoreApi, /WEB_APP_URL=\$PREVIOUS_WEB_APP_URL/);
  assert.match(restoreApi, /API_URL=\$PREVIOUS_API_URL/);
  assert.match(restoreApi, /restore_status=0/);
  assert.match(restoreApi, /railway-deploy-image\.sh[\s\S]*\|\| restore_status=1/);
  assert.ok(
    source.lastIndexOf("EPODE_CANARY_STATUS=verified") >
      source.lastIndexOf("Verify web health and authentication start"),
    "canary attestation must become verified only after the final public smoke",
  );
});

test("production promotion verifies the active canary pair and can compensate either service", async () => {
  const source = await readFile(repoFile(".github/workflows/promote.yml"), "utf8");
  assert.match(source, /group: epode-release-mutation/);
  assert.match(source, /EPODE_CANARY_STATUS/);
  assert.match(source, /EPODE_CANARY_API_DEPLOYMENT_ID/);
  assert.match(source, /EPODE_CANARY_WEB_DEPLOYMENT_ID/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /verify-image-artifact-ledger\.sh/);
  assert.match(source, /Restore API after an incomplete paired change/);
  assert.match(source, /Restore web after a failed web change/);
  assert.match(source, /Restore API production tag after incomplete tag movement/);
  assert.match(source, /Restore web production tag after incomplete tag movement/);
  const resolve = source.slice(
    source.indexOf("Resolve API and web SHA tags"),
    source.indexOf("Preserve every previously published hosted artifact"),
  );
  assert.match(resolve, /api_resolved_revision" != "\$web_resolved_revision/);
  assert.match(resolve, /git merge-base --is-ancestor/);
  assert.match(resolve, /scripts\/verify-ci-signoffs\.sh "\$revision"/);
  assert.doesNotMatch(
    resolve,
    /if \[\[ "\$OPERATION" == "promote" \]\]; then[\s\S]*git merge-base --is-ancestor/,
    "rollback candidates must pass the same ancestry and local-signoff gates as promotions",
  );
  const canaryVerification = source.slice(
    source.indexOf("Verify the exact promotion pair passed canary"),
    source.indexOf("Capture recoverable production state"),
  );
  assert.match(
    canaryVerification,
    /RAILWAY_TOKEN: \$\{\{ secrets\.RAILWAY_CANARY_TOKEN \}\}/,
    "a production-scoped Railway token cannot read the environment-scoped canary attestation",
  );
  assert.doesNotMatch(canaryVerification, /RAILWAY_TOKEN: \$\{\{ secrets\.RAILWAY_TOKEN \}\}/);
  assert.match(
    canaryVerification,
    /--service "\$CANARY_API_SERVICE"/,
    "canary attestation lookup must not reuse the production API service name",
  );
  assert.match(canaryVerification, /service="\$CANARY_API_SERVICE"/);
  assert.match(canaryVerification, /service="\$CANARY_WEB_SERVICE"/);
  assert.doesNotMatch(canaryVerification, /--service "\$API_SERVICE"/);
  const routing = source.slice(
    source.indexOf("Validate production routing configuration"),
    source.indexOf("Verify the exact promotion pair passed canary"),
  );
  assert.match(routing, /WEB_API_URL/);
  assert.match(routing, /private production API origin/);
  const recoverableState = source.slice(
    source.indexOf("Capture recoverable production state"),
    source.indexOf("- name: Promote API"),
  );
  assert.match(recoverableState, /org\.opencontainers\.image\.revision/);
  assert.match(recoverableState, /git diff --name-status/);
  assert.match(recoverableState, /at most one additive migration boundary/);
  assert.match(recoverableState, /Existing migrations are immutable/);
  assert.match(recoverableState, /EPODE_PRODUCTION_MIGRATION_STATUS == "verified"/);
  assert.match(recoverableState, /EPODE_PRODUCTION_MIGRATION_PATH == \$path/);
  assert.match(recoverableState, /EPODE_PRODUCTION_MIGRATION_SHA256 == \$sha/);
  assert.match(recoverableState, /EPODE_ADDITIVE_MIGRATION_MAX_VERSION/);
  assert.match(
    recoverableState,
    /"\$previous_ref" == "\$target_ref" && "\$previous_digest" == "\$target_digest"/,
    "an interrupted exact-pair promotion may resume even before its production tags move",
  );
  assert.match(source, /Verify both production tags by digest/);
  assert.match(source, /id: tag_readback/);
  assert.match(source, /steps\.tag_readback\.outcome != 'success'/);
  assert.match(source, /if: steps\.tag_readback\.outcome == 'success'/);
});

test("additive database expansion is derived, retry-safe, attested, and fail-closed", async () => {
  const source = await readFile(repoFile(".github/workflows/migrate-production.yml"), "utf8");
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(source, /group: epode-release-mutation/);
  assert.doesNotMatch(source, /stage-production-bridge|recover-canary/);
  assert.match(
    source,
    /environment: \$\{\{ contains\(inputs\.operation, 'production'\) && 'production' \|\| 'v2-canary' \}\}/,
  );
  assert.match(source, /target_sha must be the exact checked-out 40-character commit/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /scripts\/verify-ci-signoffs\.sh "\$TARGET_SHA"/);
  assert.match(source, /Derive the single added migration/);
  assert.match(
    source,
    /git diff --name-status "\$\{TARGET_SHA\}\^1" "\$TARGET_SHA" -- backend\/migrations/,
  );
  assert.match(source, /target_sha must add exactly one migration/);
  assert.match(source, /migration_sha256="\$\(sha256sum "\$migration_path"/);
  assert.match(source, /expected_previous_version="\$\(\(migration_version - 1\)\)"/);
  assert.doesNotMatch(
    source.slice(0, source.indexOf("permissions:")),
    /^\s+(?:migration_path|migration_sha256|expected_previous_version|expected_schema_fingerprint):/m,
  );
  assert.match(source, /apply-production requires confirm_production/);
  assert.match(source, /backup_verified_at must be valid RFC3339 within the last 24 hours/);
  assert.match(source, /Backup evidence must be an opaque provider ID, never a URL/);
  assert.match(source, /BACKUP_RESTORE_TEST_REFERENCE/);

  const readOnly = source.slice(
    source.indexOf("Verify the selected ledger without mutation"),
    source.indexOf("Capture the active application before expansion"),
  );
  assert.match(readOnly, /startsWith\(inputs\.operation, 'verify'\)/);
  assert.match(readOnly, /verify-before/);
  assert.match(readOnly, /verify-after/);
  assert.match(readOnly, /steps\.canary\.outputs\.schema_fingerprint/);
  assert.doesNotMatch(readOnly, /MIGRATION_MODE:\s*apply/);
  assert.doesNotMatch(readOnly, /railway (?:redeploy|variable set)/);

  assert.match(source, /Authorize the additive suffix and mark expansion pending/);
  assert.match(source, /EPODE_ADDITIVE_MIGRATION_MAX_VERSION=\$MIGRATION_VERSION/);
  assert.match(source, /Refusing to lower or replace the current additive migration authorization/);
  assert.match(source, /Apply the reviewed migration under advisory lock/);
  assert.match(source, /Restart the same application against the expanded schema/);
  assert.match(source, /scripts\/railway-deploy-image\.sh/);
  assert.match(source, /steps\.active\.outputs\.ref/);
  assert.match(source, /steps\.active\.outputs\.digest/);
  assert.match(source, /EPODE_MIGRATION_STATUS=verified/);
  assert.match(source, /EPODE_MIGRATION_SCHEMA_FINGERPRINT/);
  assert.match(source, /EPODE_MIGRATION_API_DEPLOYMENT_ID/);
  assert.match(source, /EPODE_MIGRATION_API_DEPLOYMENT_ID == \$deployment_id/);

  const productionEvidence = source.slice(
    source.indexOf("Read verified canary schema evidence"),
    source.indexOf("Verify the selected ledger without mutation"),
  );
  assert.match(productionEvidence, /secrets\.RAILWAY_CANARY_TOKEN/);
  assert.match(productionEvidence, /EPODE_MIGRATION_STATUS == "verified"/);
  assert.match(productionEvidence, /EPODE_MIGRATION_SCHEMA_FINGERPRINT/);
  assert.match(
    source,
    /EXPECTED_SCHEMA_FINGERPRINT: \$\{\{ steps\.canary\.outputs\.schema_fingerprint/,
  );
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_STATUS=verified/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_BACKUP_REFERENCE/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_API_REF/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_API_DEPLOYMENT_ID == \$deployment_id/);
  assert.doesNotMatch(source, /EPODE_PRODUCTION_MIGRATION_WEB_REF|migration-marker pair/);

  const promotion = await readFile(repoFile(".github/workflows/promote.yml"), "utf8");
  assert.match(promotion, /A release may cross one additive migration boundary/);
  assert.match(promotion, /EPODE_PRODUCTION_MIGRATION_STATUS == "verified"/);
  const localCi = await readFile(repoFile("scripts/local-ci.sh"), "utf8");
  assert.match(localCi, /scripts\/verify-migration-ledger\\\.sh/);
});

test("delivery workflows consume local CI signoff attestations", async () => {
  const verifier = await readFile(repoFile("scripts/verify-ci-signoffs.sh"), "utf8");
  for (const context of ["workflows", "backend", "e2e", "node", "sdk", "examples", "web", "docs"]) {
    assert.match(verifier, new RegExp(`signoff/${context}`));
  }
  assert.match(verifier, /commits\/\$\{target_sha\}\/pulls/);
  assert.match(verifier, /\.merge_commit_sha ==/);
  assert.match(verifier, /verify_commit_statuses "\$pull_head_sha"/);

  for (const workflow of [
    "promote.yml",
    "sdk-release.yml",
    "catchup-code-intel-production.yml",
    "migrate-production.yml",
  ]) {
    const source = await readFile(repoFile(`.github/workflows/${workflow}`), "utf8");
    assert.match(source, /scripts\/verify-ci-signoffs\.sh/);
    assert.doesNotMatch(source, /actions\/workflows\/ci\.yml\/runs/);
    assert.match(source, /pull-requests: read/);
    assert.match(source, /statuses: read/);
  }
});

test("migration ledger helper permits only exact one-step additive DDL", async () => {
  const source = await readFile(repoFile("scripts/verify-migration-ledger.sh"), "utf8");
  assert.match(source, /lint \| verify-before \| apply \| verify-after/);
  assert.match(source, /actual_sha256.*expected_sha256/);
  assert.match(source, /migration_version != expected_previous_version \+ 1/);
  assert.match(source, /the target commit contains a migration after the reviewed migration/);
  assert.match(source, /DROP\|TRUNCATE\|RENAME/);
  assert.match(source, /DELETE\[\[:space:\]\]\+FROM/);
  assert.match(source, /INSERT\[\[:space:\]\]\+INTO/);
  assert.match(source, /UPDATE\[\[:space:\]\]/);
  assert.match(source, /SQLx checksum mismatch for migration/);
  assert.match(source, /Sha384|sha384_file/);
  assert.match(
    source,
    /pg_advisory_lock\(hashtext\('epode'\), hashtext\('additive-schema-expansion'\)\)/,
  );
  assert.match(source, /lock_timeout=5000/);
  assert.match(source, /statement_timeout=300000/);
  assert.match(source, /\\if :SHELL_ERROR/);
  assert.match(source, /migration_applied false/);
  assert.match(
    source,
    /database is neither immediately before nor exactly at the reviewed migration/,
  );
  assert.match(source, /schema_fingerprint/);
  assert.match(
    source,
    /verify-before must not compare the pre-migration schema to a post-migration fingerprint/,
  );
  assert.match(source, /information_schema\.columns/);
  assert.match(source, /pg_get_constraintdef/);
  assert.match(source, /pg_indexes/);
  assert.doesNotMatch(source, /echo .*DATABASE_URL/);
});

test("SDK release instructions push package tags separately", async () => {
  const source = await readFile(repoFile("sdk/RELEASE.md"), "utf8");
  for (const tag of ["release", "node", "python", "rust", "go"]) {
    assert.match(source, new RegExp(`git push origin sdk/${tag}/vX\\.Y\\.Z`));
  }
  assert.match(source, /more than three tags/);
});
