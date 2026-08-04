#!/usr/bin/env bash
# Run the hosted CI "Node and Biome" job locally and post signoff/node.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

make node-install
make biome-check
make node-test

gh signoff node
