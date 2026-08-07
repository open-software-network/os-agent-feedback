#!/usr/bin/env bash
# Run the hosted CI "Backend" job locally and post signoff/backend.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight
signoff_require_rust_toolchain 1.95.0
export RUSTUP_TOOLCHAIN=1.95.0

make backend-fmt-check
make backend-clippy
make backend-test
make backend-openapi-check

DATABASE_URL="$(signoff_database_url)"
export DATABASE_URL
if ! pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; then
  make dev-db
fi
(cd backend && cargo test --locked -- --ignored --test-threads=1)

signoff_post backend
