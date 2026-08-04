#!/usr/bin/env bash
# Run the hosted CI "Node SDK" and "SDK package artifacts" jobs locally and
# post signoff/sdk. The release-readiness check needs node, pnpm, npm, python,
# go, and cargo on PATH.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

make node-install
make sdk-node-test
SDK_ARTIFACT_DIR=.artifacts/sdk-release bash scripts/sdk-release-readiness.sh

gh signoff sdk
