#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ledger="${2:-$repo_root/scripts/hosted-artifact-ledger.json}"

if [[ -z "$image_ref" || ! -f "$ledger" ]]; then
  echo "usage: $0 <api-image-ref[@digest]> [ledger.json]" >&2
  exit 2
fi
for command in docker jq shasum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "$command is required to verify immutable hosted artifacts" >&2
    exit 2
  }
done

if ! jq -e '
  type == "object"
  and length > 0
  and all(to_entries[];
    (.key | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$"))
    and (.value | type == "string" and test("^[0-9a-f]{64}$"))
  )
' "$ledger" >/dev/null; then
  echo "immutable hosted artifact ledger must be a non-empty filename-to-SHA-256 object" >&2
  exit 1
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/epode-image-ledger.XXXXXX")"
container_id=""
cleanup() {
  if [[ -n "$container_id" ]]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT

container_id="$(docker create "$image_ref")"
mkdir -p "$scratch/public"
docker cp "$container_id:/app/public/." "$scratch/public"

while IFS=$'\t' read -r filename expected_sha256; do
  if [[ ! "$filename" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ || ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "invalid immutable artifact ledger entry: $filename" >&2
    exit 1
  fi
  artifact="$scratch/public/$filename"
  if [[ ! -f "$artifact" ]]; then
    echo "$image_ref would remove immutable hosted artifact $filename" >&2
    exit 1
  fi
  actual_sha256="$(shasum -a 256 "$artifact" | awk '{print $1}')"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "$image_ref contains unexpected bytes for immutable hosted artifact $filename" >&2
    exit 1
  fi
done < <(jq -r 'to_entries | sort_by(.key)[] | [.key, .value] | @tsv' "$ledger")

echo "Verified cumulative immutable hosted artifacts in $image_ref."
