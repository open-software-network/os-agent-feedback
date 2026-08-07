#!/usr/bin/env bash
# Run the hosted CI "Customer enrichment journey" job locally and post
# signoff/e2e. The journey scripts build and spawn the disposable backend and
# example apps themselves; they only need PostgreSQL and the SDK dependencies.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight
signoff_require_rust_toolchain 1.95.0
export RUSTUP_TOOLCHAIN=1.95.0

make node-install
npm --prefix examples/mvp-retail-express install --ignore-scripts --no-audit --no-fund
npm --prefix examples/mvp-anonymous-express install --ignore-scripts --no-audit --no-fund

DATABASE_URL="$(signoff_database_url)"
export DATABASE_URL
if ! pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
  make dev-db
fi
pnpm test:customer-enrichment-e2e
pnpm test:customer-context-mcp-e2e

signoff_post e2e
