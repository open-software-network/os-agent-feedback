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
  assert.match(resolve, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{revision\}/);
  assert.doesNotMatch(
    resolve,
    /if \[\[ "\$OPERATION" == "promote" \]\]; then[\s\S]*git merge-base --is-ancestor/,
    "rollback candidates must pass the same ancestry and exact-CI gates as promotions",
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
  assert.match(
    recoverableState,
    /git ls-tree -r --name-only "\$previous_api_revision" -- backend\/migrations/,
  );
  assert.match(
    recoverableState,
    /git ls-tree -r --name-only "\$TARGET_API_REVISION" -- backend\/migrations/,
  );
  assert.match(recoverableState, /diff --unified=0 "\$previous_migrations" "\$target_migrations"/);
  assert.match(recoverableState, /separately attested migration rollout/);
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

test("additive database expansion is separately approved, attested, and fail-closed", async () => {
  const source = await readFile(repoFile(".github/workflows/migrate-production.yml"), "utf8");
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(source, /group: epode-release-mutation/);
  assert.match(source, /^\s+- stage-production-bridge$/m);
  assert.match(
    source,
    /environment: \$\{\{ contains\(inputs\.operation, 'production'\) && 'production' \|\| 'v2-canary' \}\}/,
  );
  assert.match(source, /stage_production_bridge:[\s\S]*environment: production/);
  assert.match(source, /target_sha must be the exact checked-out 40-character commit/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$\{TARGET_SHA\}/);
  assert.match(source, /MIGRATION_MODE=lint scripts\/verify-migration-ledger\.sh/);
  assert.match(source, /EXPECTED_MIGRATION_SHA256/);
  assert.match(source, /\$OPERATION requires confirm_production/);
  assert.match(
    source,
    /Mutation operations require a migration-marker commit whose only first-parent change/,
  );
  assert.match(source, /backup_verified_at must be valid RFC3339 within the last 24 hours/);
  assert.match(source, /Backup evidence must be an opaque provider ID, never a URL/);
  assert.match(source, /BACKUP_RESTORE_TEST_REFERENCE/);

  const readOnly = source.slice(
    source.indexOf("Verify the selected ledger without mutation"),
    source.indexOf("Invalidate previous canary migration evidence"),
  );
  assert.match(readOnly, /startsWith\(inputs\.operation, 'verify'\)/);
  assert.match(readOnly, /verify-before/);
  assert.match(readOnly, /verify-after/);
  assert.doesNotMatch(readOnly, /MIGRATION_MODE:\s*apply/);
  assert.doesNotMatch(readOnly, /railway (?:redeploy|variable set)/);

  assert.match(source, /EPODE_MIGRATION_STATUS=pending/);
  assert.match(source, /Apply the reviewed migration to canary under advisory lock/);
  assert.match(source, /Restart and verify the exact bridge image on expanded canary schema/);
  assert.match(
    source,
    /railway redeploy \\\n\s+--project "\$RAILWAY_PROJECT_ID" \\\n\s+--environment v2-canary \\\n\s+--service "\$API_SERVICE" \\\n\s+--yes \\\n\s+--json/,
  );
  assert.match(
    source,
    /railway redeploy \\\n\s+--project "\$RAILWAY_PROJECT_ID" \\\n\s+--environment production \\\n\s+--service "\$API_SERVICE" \\\n\s+--yes \\\n\s+--json/,
  );
  assert.match(source, /active_ref" != "\$EXPECTED_BRIDGE_REF"/);
  assert.match(source, /EPODE_MIGRATION_STATUS=verified/);
  assert.match(source, /EPODE_MIGRATION_SCHEMA_FINGERPRINT/);
  assert.match(source, /EPODE_MIGRATION_BRIDGE_DEPLOYMENT_ID/);

  const bridgeStage = source.slice(
    source.indexOf("stage_production_bridge:"),
    source.indexOf("\n  database:"),
  );
  assert.match(bridgeStage, /if: inputs\.operation == 'stage-production-bridge'/);
  assert.match(bridgeStage, /environment: production/);
  assert.match(bridgeStage, /EPODE_CANARY_API_REF == \$api_ref/);
  assert.match(bridgeStage, /EPODE_CANARY_WEB_REF == \$web_ref/);
  assert.match(bridgeStage, /EPODE_MIGRATION_STATUS == "verified"/);
  assert.match(bridgeStage, /api_active_id" != "\$api_attested_id/);
  assert.match(bridgeStage, /web_active_id" != "\$web_attested_id/);
  assert.match(bridgeStage, /Capture the complete restorable production pair/);
  assert.match(bridgeStage, /Stage production API bridge/);
  assert.match(bridgeStage, /Stage production web bridge/);
  assert.ok(
    bridgeStage.indexOf("Stage production API bridge") <
      bridgeStage.indexOf("Stage production web bridge"),
    "production bridge staging must deploy API before web",
  );
  assert.match(bridgeStage, /Restore API after incomplete bridge staging/);
  assert.match(bridgeStage, /Restore web after incomplete bridge staging/);
  assert.match(bridgeStage, /Restore API after failed bridge smoke/);
  assert.match(bridgeStage, /Restore web after failed bridge smoke/);
  assert.match(bridgeStage, /verify-public-integration-surface\.sh/);
  assert.match(bridgeStage, /Move API production tag after bridge smoke/);
  assert.match(bridgeStage, /Move web production tag after API tag/);
  assert.match(bridgeStage, /Restore prior tags after incomplete bridge tag movement/);
  assert.match(bridgeStage, /Restore prior services after incomplete bridge tag movement/);
  assert.match(bridgeStage, /EPODE_PRODUCTION_BRIDGE_STATUS=verified/);
  assert.match(bridgeStage, /EPODE_PRODUCTION_BRIDGE_API_DEPLOYMENT_ID/);
  assert.match(bridgeStage, /EPODE_PRODUCTION_BRIDGE_WEB_DEPLOYMENT_ID/);
  assert.match(bridgeStage, /EPODE_PRODUCTION_BRIDGE_CANARY_MIGRATION_RUN_ID == \$canary_run_id/);
  assert.match(bridgeStage, /EPODE_PRODUCTION_BRIDGE_SCHEMA_FINGERPRINT == \$fingerprint/);
  assert.doesNotMatch(bridgeStage, /DATABASE_URL|sqlx migrate|MIGRATION_MODE:\s*apply/);

  const imageResolution = source.slice(
    source.indexOf("Resolve the immutable migration-marker image pair"),
    source.indexOf("Preserve every previously published hosted artifact"),
  );
  assert.match(imageResolution, /for artifact in api web/);
  assert.match(imageResolution, /org\.opencontainers\.image\.revision/);
  assert.match(imageResolution, /revision" != "\$TARGET_SHA/);
  assert.match(imageResolution, /api_revision" != "\$web_revision/);

  const productionEvidence = source.slice(
    source.indexOf("Verify exact canary and production bridge evidence"),
    source.indexOf("Apply exact canary schema to production under advisory lock"),
  );
  assert.match(productionEvidence, /secrets\.RAILWAY_CANARY_TOKEN/);
  assert.match(productionEvidence, /EPODE_MIGRATION_STATUS == "verified"/);
  assert.match(productionEvidence, /EPODE_PRODUCTION_BRIDGE_STATUS == "verified"/);
  assert.match(productionEvidence, /EPODE_PRODUCTION_BRIDGE_API_REF == \$api_ref/);
  assert.match(productionEvidence, /EPODE_PRODUCTION_BRIDGE_WEB_REF == \$web_ref/);
  assert.match(
    productionEvidence,
    /EPODE_PRODUCTION_BRIDGE_CANARY_MIGRATION_RUN_ID == \$canary_run_id/,
  );
  assert.match(productionEvidence, /active_id" != "\$attested_id/);
  assert.match(productionEvidence, /active_ref" != "\$expected_ref/);
  assert.match(productionEvidence, /active_digest" != "\$expected_digest/);
  assert.match(
    source,
    /EXPECTED_SCHEMA_FINGERPRINT: \$\{\{ steps\.production_evidence\.outputs\.schema_fingerprint \}\}/,
  );
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_STATUS=verified/);
  assert.match(source, /Mark production expansion pending before database mutation/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_STATUS=pending/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_BACKUP_REFERENCE/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_WEB_REF/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_WEB_DIGEST/);
  assert.match(source, /EPODE_PRODUCTION_MIGRATION_WEB_DEPLOYMENT_ID/);
  assert.match(source, /exact staged migration-marker pair remained active/);

  const promotion = await readFile(repoFile(".github/workflows/promote.yml"), "utf8");
  assert.match(promotion, /require identical ledgers before/);
  assert.match(promotion, /separately attested migration rollout/);
  assert.doesNotMatch(
    promotion,
    /EPODE_(?:PRODUCTION_)?MIGRATION_STATUS/,
    "ordinary image promotion must not gain a migration-attestation bypass",
  );
  const ci = await readFile(repoFile(".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /scripts\/verify-migration-ledger\.sh/);
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
  assert.match(source, /schema_fingerprint/);
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
