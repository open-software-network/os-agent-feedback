#!/usr/bin/env bash
set -euo pipefail

# Validate one reviewed, additive SQLx migration and, when explicitly asked,
# apply it while a PostgreSQL advisory lock prevents a competing rollout.
#
# Required environment:
#   MIGRATION_MODE                  lint | verify-before | apply | verify-after
#   MIGRATION_PATH                  repository-relative migration path
#   EXPECTED_MIGRATION_SHA256       externally reviewed SHA-256
#   EXPECTED_PREVIOUS_VERSION       current production SQLx version
#
# Database modes additionally require DATABASE_URL. verify-after and apply may
# set EXPECTED_SCHEMA_FINGERPRINT to compare the resulting public schema.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${MIGRATION_MODE:-${1:-lint}}"
migration_path="${MIGRATION_PATH:-}"
expected_sha256="${EXPECTED_MIGRATION_SHA256:-}"
expected_previous_version="${EXPECTED_PREVIOUS_VERSION:-}"
expected_schema_fingerprint="${EXPECTED_SCHEMA_FINGERPRINT:-}"

fail() {
  echo "migration verification failed: $*" >&2
  exit 1
}

emit_output() {
  local name="$1"
  local value="$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "${name}=${value}" >> "$GITHUB_OUTPUT"
  fi
  echo "${name}=${value}"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha384_file() {
  if command -v sha384sum >/dev/null 2>&1; then
    sha384sum "$1" | awk '{print $1}'
  else
    shasum -a 384 "$1" | awk '{print $1}'
  fi
}

case "$mode" in
  lint | verify-before | apply | verify-after) ;;
  *) fail "MIGRATION_MODE must be lint, verify-before, apply, or verify-after" ;;
esac

[[ "$migration_path" =~ ^backend/migrations/[0-9]{4}_[A-Za-z0-9_]+\.sql$ ]] ||
  fail "MIGRATION_PATH must name one four-digit SQL file under backend/migrations"
[[ -f "$migration_path" && ! -L "$migration_path" ]] || fail "migration file is missing or is a symlink"
[[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "EXPECTED_MIGRATION_SHA256 must be lowercase SHA-256"
[[ "$expected_previous_version" =~ ^[0-9]+$ ]] || fail "EXPECTED_PREVIOUS_VERSION must be a non-negative integer"
if [[ -n "$expected_schema_fingerprint" && ! "$expected_schema_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
  fail "EXPECTED_SCHEMA_FINGERPRINT must be lowercase SHA-256"
fi
if [[ "$mode" == "verify-before" && -n "$expected_schema_fingerprint" ]]; then
  fail "verify-before must not compare the pre-migration schema to a post-migration fingerprint"
fi

migration_name="$(basename "$migration_path")"
migration_prefix="${migration_name%%_*}"
migration_version="$((10#$migration_prefix))"
if (( migration_version != expected_previous_version + 1 )); then
  fail "the reviewed migration must be exactly one version after EXPECTED_PREVIOUS_VERSION"
fi

max_source_version="$({
  find backend/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -print
} | sed -nE 's#^.*/0*([0-9]+)_.*$#\1#p' | sort -n | tail -1)"
[[ "$max_source_version" == "$migration_version" ]] ||
  fail "the target commit contains a migration after the reviewed migration"

actual_sha256="$(sha256_file "$migration_path")"
[[ "$actual_sha256" == "$expected_sha256" ]] || fail "migration SHA-256 does not match the reviewed value"

# Expansion migrations deliberately exclude destructive DDL and all DML. Data
# backfills are separate, bounded application jobs after the schema expansion.
normalized_sql="$({
  perl -0pe 's{/\*.*?\*/}{}gs; s/--[^\n]*//g' "$migration_path"
} | tr '[:lower:]' '[:upper:]')"
if grep -Eq '(^|[^A-Z_])(DROP|TRUNCATE|RENAME)([^A-Z_]|$)|DELETE[[:space:]]+FROM|INSERT[[:space:]]+INTO|MERGE[[:space:]]+INTO|UPDATE[[:space:]]+[A-Z0-9_."]+[[:space:]]+SET' <<< "$normalized_sql"; then
  fail "the dedicated expansion path accepts additive DDL only"
fi
if grep -Eq 'CREATE[[:space:]]+OR[[:space:]]+REPLACE|ALTER[[:space:]]+TABLE[^;]*(DROP|ALTER)[[:space:]]' <<< "$normalized_sql"; then
  fail "replacement, destructive ALTER, and column rewrites require a separate reviewed contract rollout"
fi

emit_output migration_path "$migration_path"
emit_output migration_version "$migration_version"
emit_output migration_sha256 "$actual_sha256"

if [[ "$mode" == "lint" ]]; then
  exit 0
fi

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required for database verification"
command -v psql >/dev/null 2>&1 || fail "psql is required"

psql_value() {
  psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"
}

ledger_state() {
  psql_value "SELECT COALESCE(MAX(version) FILTER (WHERE success), 0)::text || '|' || COUNT(*) FILTER (WHERE NOT success)::text FROM _sqlx_migrations;"
}

verify_known_checksums() {
  local version
  local installed_checksum
  local file
  local expected_checksum
  while IFS='|' read -r version installed_checksum; do
    [[ -n "$version" ]] || continue
    file="$(find backend/migrations -maxdepth 1 -type f -name "$(printf '%04d' "$version")_*.sql" -print -quit)"
    [[ -n "$file" ]] || fail "applied migration $version is absent from the reviewed source ledger"
    expected_checksum="$(sha384_file "$file")"
    [[ "$installed_checksum" == "$expected_checksum" ]] || fail "SQLx checksum mismatch for migration $version"
  done < <(
    psql "$DATABASE_URL" -X -qAt -F '|' -v ON_ERROR_STOP=1 \
      -c "SELECT version, encode(checksum, 'hex') FROM _sqlx_migrations WHERE success ORDER BY version"
  )
}

schema_fingerprint() {
  # Canonical public-schema facts only: no row contents, owners, database URLs,
  # or environment-specific object IDs enter the fingerprint.
  psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL' | {
WITH facts AS (
  SELECT 'column|' || table_name || '|' || ordinal_position || '|' || column_name || '|' ||
    data_type || '|' || udt_name || '|' || is_nullable || '|' || COALESCE(column_default, '') AS fact
  FROM information_schema.columns
  WHERE table_schema = 'public'
  UNION ALL
  SELECT 'constraint|' || n.nspname || '|' || c.relname || '|' || x.conname || '|' ||
    pg_get_constraintdef(x.oid, true)
  FROM pg_constraint x
  JOIN pg_class c ON c.oid = x.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'index|' || schemaname || '|' || tablename || '|' || indexname || '|' || indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
)
SELECT fact FROM facts ORDER BY fact;
SQL
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum | awk '{print $1}'
    else
      shasum -a 256 | awk '{print $1}'
    fi
  }
}

IFS='|' read -r current_version failed_count <<< "$(ledger_state)"
[[ "$failed_count" == "0" ]] || fail "the SQLx ledger contains a failed migration"
verify_known_checksums

target_count="$(psql_value "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ${migration_version} AND success")"
if [[ "$mode" == "verify-before" ]]; then
  [[ "$current_version" == "$expected_previous_version" ]] ||
    fail "database is not at the reviewed pre-migration version"
  [[ "$target_count" == "0" ]] || fail "reviewed migration is already applied"
fi

if [[ "$mode" == "apply" ]]; then
  if [[ "$current_version" == "$migration_version" && "$target_count" == "1" ]]; then
    emit_output migration_applied false
  else
    [[ "$current_version" == "$expected_previous_version" && "$target_count" == "0" ]] ||
      fail "database is neither immediately before nor exactly at the reviewed migration"
    command -v sqlx >/dev/null 2>&1 || fail "the pinned SQLx CLI is required to apply a migration"
    # Expansion may inspect existing rows for a new constraint or index, but it
    # must never wait indefinitely for a live table lock or monopolize the
    # database. Operators can make these limits stricter, never looser, in the
    # protected workflow environment.
    export PGOPTIONS="${PGOPTIONS:--c lock_timeout=5000 -c statement_timeout=300000}"
    # The psql session owns the advisory lock while SQLx performs its own normal
    # transactional migration in a child process. Losing this session releases
    # the lock automatically. SHELL_ERROR makes a failed SQLx child fail closed.
    psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_advisory_lock(hashtext('epode'), hashtext('additive-schema-expansion'));
\! sqlx migrate run --source backend/migrations
\if :SHELL_ERROR
  SELECT pg_advisory_unlock(hashtext('epode'), hashtext('additive-schema-expansion'));
  \quit 3
\endif
SELECT pg_advisory_unlock(hashtext('epode'), hashtext('additive-schema-expansion'));
SQL
    emit_output migration_applied true
  fi
  current_version=""
  failed_count=""
  IFS='|' read -r current_version failed_count <<< "$(ledger_state)"
  target_count="$(psql_value "SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ${migration_version} AND success")"
  verify_known_checksums
fi

if [[ "$mode" == "verify-after" || "$mode" == "apply" ]]; then
  [[ "$failed_count" == "0" && "$current_version" == "$migration_version" && "$target_count" == "1" ]] ||
    fail "database did not converge to exactly the reviewed migration"
fi

fingerprint="$(schema_fingerprint)"
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "could not compute the schema fingerprint"
if [[ -n "$expected_schema_fingerprint" && "$fingerprint" != "$expected_schema_fingerprint" ]]; then
  fail "schema fingerprint differs from the reviewed canary schema"
fi

emit_output database_version "$current_version"
emit_output schema_fingerprint "$fingerprint"
