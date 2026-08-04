#!/usr/bin/env bash
set -euo pipefail

# One-time, fail-closed production catch-up from SQLx 34 to 38. Apply runs
# every reviewed migration and ledger insert in one PostgreSQL transaction.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${CATCHUP_MODE:-${1:-lint}}"
expected_schema_fingerprint="${EXPECTED_SCHEMA_FINGERPRINT:-}"
rollback_confirmation="${CONFIRM_EMPTY_ROLLBACK:-}"
target_revision="d170746d238930a4d018aa97dcf4e1056c4af6b0"
previous_version=34
target_version=38

fail() {
  echo "code-intel catch-up verification failed: $*" >&2
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
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

sha384_file() {
  if command -v sha384sum >/dev/null 2>&1; then sha384sum "$1" | awk '{print $1}';
  else shasum -a 384 "$1" | awk '{print $1}'; fi
}

migration_contract() {
  cat <<'CONTRACT'
35|backend/migrations/0035_report_code_hints.sql|report code hints|1db4d0bc8d4a3ba88f2d1c111240a51cf02fea8032410a9097dd653771c59064|23bd237f63e64e17ec35b81fa76a0cf3450a6cb0b625f593182b86350fb845f0073ed3e12392768f9a12f58118e4c3ca
36|backend/migrations/0036_code_match_verification_analytics.sql|code match verification analytics|ffcda53f00a31e99c3b7affc1964cda0f95df764673aab7ffecc2e7e47537efa|88b39c2cc3d994b1b815c4c55fe8b703fbd2774ac3887c796724c0d30aa07b136b5c8446c149ab0723de1580e5f21301
37|backend/migrations/0037_code_match_verification_retries.sql|code match verification retries|d4b62c2a4a50ad436ed924dd84857923d1b455ba8553e67e6e67178275f35ba1|33a6f1b3f3d8b37b1f1ee69d96dadef024682c84a0a2d2d80f7f5a3c8ceebfeab0c1796bb6bd4a0557ec102e755b5f8a
38|backend/migrations/0038_verified_code_hints.sql|verified code hints|40343a6daa84636bf67458dc182a2e3c0ba8ffa7ee62443a76b135e02982474a|22401a3050b77aeff86f6fbeaca0715ea9951faefe427168dfa5810c474561e31a312008f58e483e3b048d6c77662ddb
CONTRACT
}

validate_source_contract() {
  local version path description expected_sha256 expected_sha384 actual_sha256 actual_sha384
  while IFS='|' read -r version path description expected_sha256 expected_sha384; do
    [[ -n "$version" ]] || continue
    [[ "$path" =~ ^backend/migrations/003[5-8]_[A-Za-z0-9_]+\.sql$ ]] || fail "invalid migration path"
    [[ -f "$path" && ! -L "$path" ]] || fail "$path is missing or is a symlink"
    actual_sha256="$(sha256_file "$path")"
    actual_sha384="$(sha384_file "$path")"
    [[ "$actual_sha256" == "$expected_sha256" ]] || fail "$path SHA-256 mismatch"
    [[ "$actual_sha384" == "$expected_sha384" ]] || fail "$path SQLx SHA-384 mismatch"
    emit_output "migration_${version}_sha256" "$actual_sha256"
    emit_output "migration_${version}_sha384" "$actual_sha384"
    emit_output "migration_${version}_description" "$description"
  done < <(migration_contract)
  emit_output target_revision "$target_revision"
}

case "$mode" in
  lint | verify-before | apply | capture-after | verify-after | rollback-empty) ;;
  *) fail "mode must be lint, verify-before, apply, capture-after, verify-after, or rollback-empty" ;;
esac
if [[ -n "$expected_schema_fingerprint" && ! "$expected_schema_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
  fail "EXPECTED_SCHEMA_FINGERPRINT must be lowercase SHA-256"
fi
if [[ "$mode" == "verify-before" && -n "$expected_schema_fingerprint" ]]; then
  fail "verify-before must not compare a pre-catch-up schema to the target fingerprint"
fi
if [[ "$mode" == "verify-after" ]]; then
  [[ -n "$expected_schema_fingerprint" ]] || fail "EXPECTED_SCHEMA_FINGERPRINT is required for $mode"
fi

validate_source_contract
[[ "$mode" == "lint" ]] && exit 0
[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required for $mode"
command -v psql >/dev/null 2>&1 || fail "psql is required for $mode"

psql_value() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"; }

ledger_state() {
  psql_value "SELECT COALESCE(MAX(version) FILTER (WHERE success),0)::text || '|' || COUNT(*) FILTER (WHERE NOT success)::text || '|' || COUNT(*)::text FROM _sqlx_migrations;"
}

verify_installed_checksums() {
  local expected_max="$1" version installed_checksum file expected_checksum matches
  while IFS='|' read -r version installed_checksum; do
    [[ -n "$version" ]] || continue
    matches="$(find backend/migrations -maxdepth 1 -type f -name "$(printf '%04d' "$version")_*.sql" -print)"
    [[ "$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')" == "1" ]] ||
      fail "applied migration $version does not resolve to exactly one source file"
    file="$matches"
    expected_checksum="$(sha384_file "$file")"
    [[ "$installed_checksum" == "$expected_checksum" ]] || fail "SQLx checksum mismatch for migration $version"
  done < <(psql "$DATABASE_URL" -X -qAt -F '|' -v ON_ERROR_STOP=1 \
    -c "SELECT version,encode(checksum,'hex') FROM _sqlx_migrations WHERE version <= ${expected_max} AND success ORDER BY version")
}

schema_fingerprint() {
  psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL' | {
WITH facts AS (
  SELECT 'column|'||table_name||'|'||ordinal_position||'|'||column_name||'|'||data_type||'|'||udt_name||'|'||is_nullable||'|'||COALESCE(column_default,'') AS fact
  FROM information_schema.columns WHERE table_schema='public'
  UNION ALL
  SELECT 'constraint|'||n.nspname||'|'||c.relname||'|'||x.conname||'|'||pg_get_constraintdef(x.oid,true)
  FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'index|'||schemaname||'|'||tablename||'|'||indexname||'|'||indexdef FROM pg_indexes WHERE schemaname='public'
)
SELECT fact FROM facts ORDER BY fact;
SQL
    if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}';
    else shasum -a 256 | awk '{print $1}'; fi
  }
}

verify_preflight() {
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE ledger_count BIGINT; ledger_min BIGINT; ledger_max BIGINT; failed_count BIGINT; version_34_checksum TEXT;
BEGIN
  IF current_setting('server_version_num')::INTEGER < 120000 THEN RAISE EXCEPTION 'PostgreSQL 12 or newer is required'; END IF;
  IF to_regclass('public._sqlx_migrations') IS NULL THEN RAISE EXCEPTION 'production SQLx migration ledger is missing'; END IF;
  SELECT COUNT(*),MIN(version),MAX(version),COUNT(*) FILTER(WHERE NOT success)
    INTO ledger_count,ledger_min,ledger_max,failed_count FROM _sqlx_migrations;
  IF ledger_count<>34 OR ledger_min<>1 OR ledger_max<>34 OR failed_count<>0 THEN RAISE EXCEPTION 'ledger is not exactly successful versions 1 through 34'; END IF;
  SELECT encode(checksum,'hex') INTO version_34_checksum FROM _sqlx_migrations WHERE version=34 AND success;
  IF version_34_checksum<>'e43ce57441739aeec57c7a013c5472aceb37aa57640b5aae856dfd3cd80f5b75cc4dae84068b02054c6816ef97110f53' THEN RAISE EXCEPTION 'version 34 checksum mismatch'; END IF;
  IF to_regclass('public.feedback_reports') IS NULL OR to_regclass('public.products') IS NULL THEN RAISE EXCEPTION 'required foreign-key parent table is missing'; END IF;
  IF to_regclass('public.report_code_hints') IS NOT NULL OR to_regclass('public.match_analytics') IS NOT NULL OR to_regclass('public.code_match_queue') IS NOT NULL OR to_regclass('public.code_match_verification_analytics') IS NOT NULL THEN RAISE EXCEPTION 'partial or unattested version-35-plus schema exists'; END IF;
  IF NOT has_schema_privilege(current_user,'public','CREATE') OR NOT has_table_privilege(current_user,'public._sqlx_migrations','SELECT,INSERT,DELETE') THEN RAISE EXCEPTION 'migration role has insufficient privileges'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start IS NOT NULL) THEN RAISE EXCEPTION 'another client transaction is active; drain and scale the API to zero'; END IF;
END $$;
SELECT 'feedback_reports' AS relation,COUNT(*) AS rows FROM feedback_reports UNION ALL SELECT 'products',COUNT(*) FROM products;
ROLLBACK;
SQL
  verify_installed_checksums "$previous_version"
  emit_output database_version "$previous_version"
}

verify_after() {
  local current_version failed_count ledger_count fingerprint
  IFS='|' read -r current_version failed_count ledger_count <<< "$(ledger_state)"
  [[ "$current_version" == "$target_version" && "$failed_count" == "0" && "$ledger_count" == "38" ]] || fail "ledger is not exactly successful versions 1 through 38"
  verify_installed_checksums "$target_version"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
DO $$
DECLARE table_count BIGINT; invalid_constraints BIGINT; invalid_indexes BIGINT; invalid_rows BIGINT;
BEGIN
  SELECT COUNT(*) INTO table_count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ('report_code_hints','match_analytics','code_match_queue','code_match_verification_analytics');
  IF table_count<>4 THEN RAISE EXCEPTION 'catch-up table set is incomplete'; END IF;
  SELECT COUNT(*) INTO invalid_constraints FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('report_code_hints','match_analytics','code_match_queue','code_match_verification_analytics') AND NOT x.convalidated;
  IF invalid_constraints<>0 THEN RAISE EXCEPTION 'catch-up schema contains an unvalidated constraint'; END IF;
  SELECT COUNT(*) INTO invalid_indexes FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('report_code_hints','match_analytics','code_match_queue','code_match_verification_analytics') AND (NOT i.indisvalid OR NOT i.indisready);
  IF invalid_indexes<>0 THEN RAISE EXCEPTION 'catch-up schema contains an invalid index'; END IF;
  SELECT
    (SELECT COUNT(*) FROM report_code_hints WHERE jsonb_typeof(hints)<>'array' OR jsonb_path_query_array(hints,'$[*] ? (@.verified == true)')<>hints OR (outcome IS NOT NULL AND outcome NOT IN ('matched','no_match','proven_absent','terminal_unverifiable','unverified_dropped')))
    +(SELECT COUNT(*) FROM code_match_verification_analytics WHERE candidates_seen<>dropped_as_absent+kept_verified+kept_unverified)
    +(SELECT COUNT(*) FROM code_match_queue WHERE (claimed_at IS NULL)<>(claim_token IS NULL) OR (dead_lettered_at IS NOT NULL AND claimed_at IS NOT NULL) OR (verification_retry_sha IS NULL)<>(verification_retry_repo IS NULL))
    INTO invalid_rows;
  IF invalid_rows<>0 THEN RAISE EXCEPTION 'catch-up data invariants are violated'; END IF;
END $$;
ROLLBACK;
SQL
  fingerprint="$(schema_fingerprint)"
  [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || fail "could not compute schema fingerprint"
  if [[ -n "$expected_schema_fingerprint" ]]; then
    [[ "$fingerprint" == "$expected_schema_fingerprint" ]] || fail "schema fingerprint differs from the reviewed canary schema"
  fi
  emit_output database_version "$target_version"
  emit_output schema_fingerprint "$fingerprint"
}

apply_catchup() {
  verify_preflight
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT pg_try_advisory_xact_lock(hashtext('epode'), hashtext('additive-schema-expansion')) AS catchup_lock_acquired \gset
\if :catchup_lock_acquired
\else
  \echo 'code-intel catch-up advisory lock is busy'
  ROLLBACK;
  \quit 73
\endif
LOCK TABLE _sqlx_migrations IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE ledger_count BIGINT; ledger_min BIGINT; ledger_max BIGINT; failed_count BIGINT; version_34_checksum TEXT;
BEGIN
  SELECT COUNT(*),MIN(version),MAX(version),COUNT(*) FILTER(WHERE NOT success) INTO ledger_count,ledger_min,ledger_max,failed_count FROM _sqlx_migrations;
  IF ledger_count<>34 OR ledger_min<>1 OR ledger_max<>34 OR failed_count<>0 THEN RAISE EXCEPTION 'ledger changed after preflight'; END IF;
  SELECT encode(checksum,'hex') INTO version_34_checksum FROM _sqlx_migrations WHERE version=34 AND success;
  IF version_34_checksum<>'e43ce57441739aeec57c7a013c5472aceb37aa57640b5aae856dfd3cd80f5b75cc4dae84068b02054c6816ef97110f53' THEN RAISE EXCEPTION 'version 34 checksum changed after preflight'; END IF;
  IF to_regclass('public.report_code_hints') IS NOT NULL OR to_regclass('public.match_analytics') IS NOT NULL OR to_regclass('public.code_match_queue') IS NOT NULL OR to_regclass('public.code_match_verification_analytics') IS NOT NULL THEN RAISE EXCEPTION 'partial catch-up schema appeared after preflight'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start IS NOT NULL) THEN RAISE EXCEPTION 'another client transaction became active after preflight'; END IF;
END $$;

\i backend/migrations/0035_report_code_hints.sql
INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (35,'report code hints',TRUE,decode('23bd237f63e64e17ec35b81fa76a0cf3450a6cb0b625f593182b86350fb845f0073ed3e12392768f9a12f58118e4c3ca','hex'),-1);
\i backend/migrations/0036_code_match_verification_analytics.sql
INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (36,'code match verification analytics',TRUE,decode('88b39c2cc3d994b1b815c4c55fe8b703fbd2774ac3887c796724c0d30aa07b136b5c8446c149ab0723de1580e5f21301','hex'),-1);
\i backend/migrations/0037_code_match_verification_retries.sql
INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (37,'code match verification retries',TRUE,decode('33a6f1b3f3d8b37b1f1ee69d96dadef024682c84a0a2d2d80f7f5a3c8ceebfeab0c1796bb6bd4a0557ec102e755b5f8a','hex'),-1);
\i backend/migrations/0038_verified_code_hints.sql
INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (38,'verified code hints',TRUE,decode('22401a3050b77aeff86f6fbeaca0715ea9951faefe427168dfa5810c474561e31a312008f58e483e3b048d6c77662ddb','hex'),-1);

DO $$
DECLARE new_rows BIGINT;
BEGIN
  SELECT (SELECT COUNT(*) FROM report_code_hints)+(SELECT COUNT(*) FROM match_analytics)+(SELECT COUNT(*) FROM code_match_queue)+(SELECT COUNT(*) FROM code_match_verification_analytics) INTO new_rows;
  IF new_rows<>0 THEN RAISE EXCEPTION 'new catch-up tables unexpectedly contain % rows before commit',new_rows; END IF;
  IF (SELECT MAX(version) FROM _sqlx_migrations)<>38 THEN RAISE EXCEPTION 'ledger did not reach version 38'; END IF;
END $$;
COMMIT;
SQL
  verify_after
}

rollback_empty() {
  [[ "$rollback_confirmation" == "rollback-code-intel-35-38" ]] || fail "rollback-empty requires CONFIRM_EMPTY_ROLLBACK=rollback-code-intel-35-38"
  verify_after
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SELECT pg_try_advisory_xact_lock(hashtext('epode'), hashtext('additive-schema-expansion')) AS catchup_lock_acquired \gset
\if :catchup_lock_acquired
\else
  \echo 'code-intel catch-up advisory lock is busy'
  ROLLBACK;
  \quit 73
\endif
LOCK TABLE _sqlx_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE report_code_hints, match_analytics, code_match_queue, code_match_verification_analytics IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE new_rows BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND xact_start IS NOT NULL) THEN RAISE EXCEPTION 'another client transaction is active; rollback is forbidden'; END IF;
  IF (SELECT COUNT(*) FROM _sqlx_migrations WHERE version BETWEEN 35 AND 38 AND success)<>4 OR (SELECT MAX(version) FROM _sqlx_migrations)<>38 THEN RAISE EXCEPTION 'ledger is not the exact version-38 catch-up state'; END IF;
  SELECT (SELECT COUNT(*) FROM report_code_hints)+(SELECT COUNT(*) FROM match_analytics)+(SELECT COUNT(*) FROM code_match_queue)+(SELECT COUNT(*) FROM code_match_verification_analytics) INTO new_rows;
  IF new_rows<>0 THEN RAISE EXCEPTION 'rollback would destroy % catch-up rows',new_rows; END IF;
END $$;
DROP TABLE code_match_verification_analytics;
DROP TABLE match_analytics;
DROP TABLE code_match_queue;
DROP TABLE report_code_hints;
DELETE FROM _sqlx_migrations WHERE version BETWEEN 35 AND 38;
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM _sqlx_migrations)<>34 OR (SELECT MAX(version) FROM _sqlx_migrations)<>34 OR (SELECT COUNT(*) FROM _sqlx_migrations WHERE NOT success)<>0 THEN RAISE EXCEPTION 'rollback did not restore the version-34 ledger'; END IF;
  IF to_regclass('public.report_code_hints') IS NOT NULL OR to_regclass('public.match_analytics') IS NOT NULL OR to_regclass('public.code_match_queue') IS NOT NULL OR to_regclass('public.code_match_verification_analytics') IS NOT NULL THEN RAISE EXCEPTION 'rollback did not remove the catch-up schema'; END IF;
END $$;
COMMIT;
SQL
  verify_installed_checksums "$previous_version"
  local current_version failed_count ledger_count
  IFS='|' read -r current_version failed_count ledger_count <<< "$(ledger_state)"
  [[ "$current_version" == "$previous_version" && "$failed_count" == "0" && "$ledger_count" == "34" ]] || fail "rollback did not converge to exactly successful versions 1 through 34"
  emit_output database_version "$previous_version"
  emit_output schema_fingerprint "$(schema_fingerprint)"
}

case "$mode" in
  verify-before) verify_preflight ;;
  apply) apply_catchup ;;
  capture-after) verify_after ;;
  verify-after) verify_after ;;
  rollback-empty) rollback_empty ;;
esac
