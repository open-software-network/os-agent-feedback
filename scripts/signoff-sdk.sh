#!/usr/bin/env bash
# Run every SDK CI job locally and post signoff/sdk. The release-readiness
# check needs node, pnpm, npm, python, go, and cargo on PATH.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

make node-install
make sdk-node-test
make linked-journey-conformance
make sdk-rust-test

artifact_dir="$(mktemp -d "${TMPDIR:-/tmp}/epode-sdk-signoff.XXXXXX")"
trap 'rm -rf "$artifact_dir"' EXIT
SDK_ARTIFACT_DIR="$artifact_dir" bash scripts/sdk-release-readiness.sh

(
  cd sdk/python
  uv run --no-project --with '.[mcp]' --with 'mcp==2.0.0' \
    -m unittest discover -s tests -v
)

signoff_post sdk
