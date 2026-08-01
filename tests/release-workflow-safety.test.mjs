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
  assert.match(source, /Verify both production tags by digest/);
  assert.match(source, /id: tag_readback/);
  assert.match(source, /steps\.tag_readback\.outcome != 'success'/);
  assert.match(source, /if: steps\.tag_readback\.outcome == 'success'/);
});

test("SDK release instructions push package tags separately", async () => {
  const source = await readFile(repoFile("sdk/RELEASE.md"), "utf8");
  for (const tag of ["release", "node", "python", "rust", "go"]) {
    assert.match(source, new RegExp(`git push origin sdk/${tag}/vX\\.Y\\.Z`));
  }
  assert.match(source, /more than three tags/);
});
