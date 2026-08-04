#!/usr/bin/env bash
# Run the hosted CI "Documentation" job locally and post signoff/docs.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

make node-install
make docs-validate
make docs-a11y

gh signoff docs
