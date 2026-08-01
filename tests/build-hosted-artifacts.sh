#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifacts="$repo_root/backend/public"
python_bin="${PYTHON_BIN:-$(command -v python3.11 || command -v python3)}"
version="$(node -p "require('$repo_root/sdk/node/package.json').version")"
python_version="$($python_bin -c 'import re, sys; text = open(sys.argv[1]).read(); match = re.search(r"^version = \"([^\"]+)\"$", text, re.M); print(match.group(1) if match else "")' "$repo_root/sdk/python/pyproject.toml")"
rust_version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$repo_root/sdk/rust/Cargo.toml" | head -1)"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$version" != "$python_version" || "$version" != "$rust_version" ]]; then
  echo "SDK package versions must match before building hosted artifacts: node=$version python=$python_version rust=$rust_version" >&2
  exit 1
fi
stage="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-hosted.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

write_source_archive() {
  local source_dir="$1"
  local output="$2"
  shift 2
  local stage
  stage="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-source.XXXXXX")"
  for file in "$@"; do
    mkdir -p "$stage/$(dirname "$file")"
    install -m 0644 "$source_dir/$file" "$stage/$file"
    TZ=UTC touch -t 202001010000 "$stage/$file"
  done
  COPYFILE_DISABLE=1 tar \
    --format ustar \
    --uid 0 --gid 0 --uname root --gname root \
    -cf - -C "$stage" "$@" \
    | gzip -n >"$output"
  rm -rf "$stage"
}

write_and_verify_source_archive() {
  local source_dir="$1"
  local output="$2"
  shift 2
  local rebuilt
  rebuilt="$(mktemp "${TMPDIR:-/tmp}/agent-feedback-archive.XXXXXX")"
  write_source_archive "$source_dir" "$output" "$@"
  write_source_archive "$source_dir" "$rebuilt" "$@"
  cmp --silent "$output" "$rebuilt" || {
    echo "source archive was not reproducible: $output" >&2
    rm -f "$rebuilt"
    exit 1
  }
  rm -f "$rebuilt"
}

write_protocol_archive() {
  local output="$1"
  "$python_bin" - "$repo_root" "$output" <<'PY'
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
files = (
    "README.md",
    "conformance.json",
    "consent-decision.schema.json",
    "envelope.schema.json",
    "feedback-report.schema.json",
    "telemetry-batch.schema.json",
)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
    for filename in files:
        info = zipfile.ZipInfo(f"protocol/v1/{filename}", date_time=(2020, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.compress_type = zipfile.ZIP_STORED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (root / "protocol" / "v1" / filename).read_bytes())
PY
}

write_and_verify_protocol_archive() {
  local output="$1"
  local rebuilt
  rebuilt="$(mktemp "${TMPDIR:-/tmp}/agent-feedback-protocol-archive.XXXXXX")"
  rm -f "$rebuilt"
  write_protocol_archive "$output"
  write_protocol_archive "$rebuilt"
  cmp --silent "$output" "$rebuilt" || {
    echo "protocol archive was not reproducible: $output" >&2
    rm -f "$rebuilt"
    exit 1
  }
  rm -f "$rebuilt"
}

if [[ "${1:-}" == "--protocol-bundle" ]]; then
  if [[ "$#" -ne 2 ]]; then
    echo "usage: $0 --protocol-bundle OUTPUT.zip" >&2
    exit 64
  fi
  write_and_verify_protocol_archive "$2"
  exit 0
elif [[ "$#" -ne 0 ]]; then
  echo "usage: $0 [--protocol-bundle OUTPUT.zip]" >&2
  exit 64
fi

(
  cd "$repo_root/sdk/node"
  pnpm --filter @agent-feedback/node install --ignore-scripts
  pnpm pack --pack-destination "$stage"
)

"$python_bin" -m pip wheel --no-deps "$repo_root/sdk/python" --wheel-dir "$stage"

write_and_verify_source_archive \
  "$repo_root/sdk/go" \
  "$stage/agent-feedback-go-$version.tar.gz" \
  go.mod agent.go agentfeedback.go README.md
write_and_verify_source_archive \
  "$repo_root/sdk/rust" \
  "$stage/agent-feedback-rust-$version.tar.gz" \
  Cargo.toml Cargo.lock README.md src/lib.rs
legacy_protocol_artifact="$artifacts/agent-feedback-protocol-v1.zip"
if [[ ! -f "$legacy_protocol_artifact" ]]; then
  echo "the immutable original protocol v1 artifact is missing" >&2
  exit 1
fi
expected_legacy_protocol_sha256="84c74beccabdbf771070cad001223df9335aa19894f9305b30afd224266188a6"
actual_legacy_protocol_sha256="$(shasum -a 256 "$legacy_protocol_artifact" | awk '{print $1}')"
if [[ "$actual_legacy_protocol_sha256" != "$expected_legacy_protocol_sha256" ]]; then
  echo "the immutable original protocol v1 artifact changed" >&2
  exit 1
fi
protocol_filename="agent-feedback-protocol-v1-$version.zip"
protocol_artifact="$stage/$protocol_filename"
write_and_verify_protocol_archive "$protocol_artifact"
actual_protocol_sha256="$(shasum -a 256 "$protocol_artifact" | awk '{print $1}')"
protocol_listing="$(unzip -Z1 "$protocol_artifact")"
if grep -Eq 'outcome\.schema\.json$' <<<"$protocol_listing"; then
  echo "stale outcome.schema.json remained in the protocol artifact" >&2
  exit 1
fi
for required in README.md conformance.json consent-decision.schema.json envelope.schema.json feedback-report.schema.json telemetry-batch.schema.json; do
  grep -Fxq "protocol/v1/$required" <<<"$protocol_listing" || {
    echo "protocol artifact is missing $required" >&2
    exit 1
  }
done
for protocol_file in README.md conformance.json consent-decision.schema.json envelope.schema.json feedback-report.schema.json telemetry-batch.schema.json; do
  cmp --silent <(unzip -p "$protocol_artifact" "protocol/v1/$protocol_file") "$repo_root/protocol/v1/$protocol_file" || {
    echo "protocol/v1/$protocol_file changed; publish a new protocol version instead of overwriting v1" >&2
    exit 1
  }
done

node_sha256="$(shasum -a 256 "$stage/agent-feedback-node-$version.tgz" | awk '{print $1}')"
python_sha256="$(shasum -a 256 "$stage/agent_feedback-$version-py3-none-any.whl" | awk '{print $1}')"
go_sha256="$(shasum -a 256 "$stage/agent-feedback-go-$version.tar.gz" | awk '{print $1}')"
rust_sha256="$(shasum -a 256 "$stage/agent-feedback-rust-$version.tar.gz" | awk '{print $1}')"
manifest_filename="agent-feedback-integrations-$version.json"
jq -n \
  --arg release "$version" \
  --arg node_filename "agent-feedback-node-$version.tgz" \
  --arg node_sha256 "$node_sha256" \
  --arg python_filename "agent_feedback-$version-py3-none-any.whl" \
  --arg python_sha256 "$python_sha256" \
  --arg go_filename "agent-feedback-go-$version.tar.gz" \
  --arg go_sha256 "$go_sha256" \
  --arg rust_filename "agent-feedback-rust-$version.tar.gz" \
  --arg rust_sha256 "$rust_sha256" \
  --arg protocol_filename "$protocol_filename" \
  --arg protocol_sha256 "$actual_protocol_sha256" \
  '{
    schemaVersion: 1,
    release: $release,
    artifacts: {
      node: {filename: $node_filename, sha256: $node_sha256, mediaType: "application/gzip"},
      python: {filename: $python_filename, sha256: $python_sha256, mediaType: "application/zip"},
      go: {filename: $go_filename, sha256: $go_sha256, mediaType: "application/gzip"},
      rust: {filename: $rust_filename, sha256: $rust_sha256, mediaType: "application/gzip"},
      protocol: {
        filename: $protocol_filename,
        sha256: $protocol_sha256,
        mediaType: "application/zip",
        protocolVersion: 1,
        bundleRelease: $release
      }
    }
  }' >"$stage/$manifest_filename"

for filename in \
  "agent-feedback-node-$version.tgz" \
  "agent_feedback-$version-py3-none-any.whl" \
  "agent-feedback-go-$version.tar.gz" \
  "agent-feedback-rust-$version.tar.gz" \
  "$protocol_filename" \
  "$manifest_filename"; do
  candidate="$stage/$filename"
  destination="$artifacts/$filename"
  if [[ ! -f "$candidate" ]]; then
    echo "hosted SDK build did not produce $filename" >&2
    exit 1
  fi
  if [[ -e "$destination" ]]; then
    cmp --silent "$candidate" "$destination" || {
      echo "immutable hosted artifact already exists with different bytes: $destination" >&2
      exit 1
    }
  else
    mv "$candidate" "$destination"
  fi
done

node "$repo_root/tests/sync-example-sdk-integrity.mjs" --write

echo "PASS hosted SDK artifacts rebuilt and immutable protocol v1 verified"
