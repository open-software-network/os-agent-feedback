#!/usr/bin/env bash
# Path-aware local PR checks. Diffs the branch against the PR base, runs only
# the suites the changed paths need, and posts every required signoff/*
# status. Suites that are not relevant to the diff are posted as not
# applicable, so docs-only PRs stay mergeable when the ruleset requires every
# signoff context.
#
# These filters are the source of truth for PR CI. Deployment and release
# workflows remain hosted, but no GitHub Actions workflow runs PR test/build
# CI or posts the required signoff statuses.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

base_ref="$(gh pr view --json baseRefName --jq .baseRefName 2>/dev/null || true)"
base_ref="${base_ref:-main}"
git fetch origin "$base_ref" --quiet
base_sha="$(git merge-base HEAD "origin/$base_ref")"
changed_files="$(git diff --name-only "$base_sha"...HEAD)"

changed() {
  printf '%s\n' "$changed_files" | grep -Eq "$1"
}

needs_backend=false
needs_e2e=false
needs_node=false
needs_sdk_node=false
needs_sdk_packages=false
needs_sdk_python_mcp=false
needs_examples=false
needs_web=false
needs_docs=false
needs_workflows=false

if changed '^(backend/|Makefile$)'; then
  needs_backend=true
fi

if changed '^(package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|biome\.json$|Makefile$|tests/|backend/|sdk/|protocol/|docs/|scripts/hosted-artifact-ledger\.json$|scripts/verify-image-artifact-ledger\.sh$|scripts/verify-public-integration-surface\.sh$)'; then
  needs_node=true
fi

if changed '^(package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|biome\.json$|Makefile$|sdk/node/|tests/customer-context-mcp-e2e\.mjs$)'; then
  needs_sdk_node=true
fi

if changed '^(sdk/|examples/rust-axum/|examples/rust-rmcp/|protocol/v1/|Makefile$|scripts/sdk-release-readiness\.sh$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.github/workflows/sdk-release\.yml$)'; then
  needs_sdk_packages=true
fi

if changed '^(sdk/python/|examples/python-mcp/|protocol/v1/|tests/python-mcp-example-contract\.test\.mjs$)'; then
  needs_sdk_python_mcp=true
fi

if changed '^(examples/|backend/public/agent-feedback-node-[^/]*\.tgz$|sdk/node/|\.dockerignore$|\.github/workflows/build-node-examples\.yml$)'; then
  needs_examples=true
fi

if changed '^(web/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|biome\.json$|Makefile$|backend/openapi\.json$)'; then
  needs_web=true
fi

if changed '^(package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|Makefile$|docs/|sdk/|protocol/|backend/public/app\.js$|tests/docs-contract\.test\.mjs$)'; then
  needs_docs=true
fi

if changed '^(\.github/workflows/|scripts/railway-deploy-image\.sh$|scripts/verify-migration-ledger\.sh$|scripts/verify-ci-signoffs\.sh$|scripts/verify-public-integration-surface\.sh$|scripts/verify-image-artifact-ledger\.sh$|scripts/local-ci\.sh$|scripts/signoff-)'; then
  needs_workflows=true
fi

# The hosted customer enrichment journey runs when backend, sdk-node, or
# examples paths change.
if [[ "$needs_backend" == "true" || "$needs_sdk_node" == "true" || "$needs_examples" == "true" ]]; then
  needs_e2e=true
fi

# Changes to the signoff machinery itself re-verify everything.
if changed '^(Makefile$|scripts/local-ci\.sh$|scripts/signoff-)'; then
  needs_backend=true
  needs_e2e=true
  needs_node=true
  needs_sdk_node=true
  needs_sdk_packages=true
  needs_sdk_python_mcp=true
  needs_examples=true
  needs_web=true
  needs_docs=true
  needs_workflows=true
fi

run_or_skip() {
  local name="$1"
  local needed="$2"
  local script="$3"

  if [[ "$needed" == "true" ]]; then
    "$script"
  else
    echo "No ${name} paths changed; posting signoff/${name} as not applicable."
    signoff_post "$name"
  fi
}

needs_sdk=false
if [[ "$needs_sdk_node" == "true" || "$needs_sdk_packages" == "true" || "$needs_sdk_python_mcp" == "true" ]]; then
  needs_sdk=true
fi

run_or_skip workflows "$needs_workflows" ./scripts/signoff-workflows.sh
run_or_skip backend "$needs_backend" ./scripts/signoff-backend.sh
run_or_skip e2e "$needs_e2e" ./scripts/signoff-e2e.sh
run_or_skip node "$needs_node" ./scripts/signoff-node.sh
run_or_skip sdk "$needs_sdk" ./scripts/signoff-sdk.sh
run_or_skip examples "$needs_examples" ./scripts/signoff-examples.sh
run_or_skip web "$needs_web" ./scripts/signoff-web.sh
run_or_skip docs "$needs_docs" ./scripts/signoff-docs.sh

echo "All applicable signoff suites passed; signoff/* statuses are posted."
