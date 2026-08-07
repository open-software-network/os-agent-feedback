#!/usr/bin/env bash
# Run workflow and shell-script CI locally and post signoff/workflows.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

signoff_require_command actionlint "Install it with: brew install actionlint"
signoff_require_command shellcheck "Install it with: brew install shellcheck"

actionlint -color
shellcheck \
  scripts/railway-deploy-image.sh \
  scripts/verify-production-observation.sh \
  scripts/verify-image-artifact-ledger.sh \
  scripts/verify-ci-signoffs.sh \
  scripts/verify-public-integration-surface.sh \
  scripts/local-ci.sh \
  scripts/signoff-common.sh \
  scripts/signoff-backend.sh \
  scripts/signoff-e2e.sh \
  scripts/signoff-node.sh \
  scripts/signoff-sdk.sh \
  scripts/signoff-examples.sh \
  scripts/signoff-web.sh \
  scripts/signoff-docs.sh \
  scripts/signoff-workflows.sh

signoff_post workflows
