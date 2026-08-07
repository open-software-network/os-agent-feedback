#!/usr/bin/env bash
# Run the hosted CI "Web" job locally and post signoff/web.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

make node-install
make web-types-check
make web-check
make web-typecheck
make web-test
make web-build
make web-release-e2e

signoff_post web
