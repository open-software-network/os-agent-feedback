#!/usr/bin/env bash
# Build each SDK in its registry-native format, then install that exact output
# in a disposable consumer project. This is deliberately separate from the
# hosted bootstrap artifacts under backend/public: those remain stable until a
# registry release replaces the bootstrap distribution path.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${SDK_ARTIFACT_DIR:-$repo_root/.artifacts/sdk-release}"
case "$artifact_dir" in
  /*) ;;
  *) artifact_dir="$repo_root/$artifact_dir" ;;
esac
artifact_parent="$(dirname "$artifact_dir")"
mkdir -p "$artifact_parent"
artifact_dir="$(cd "$artifact_parent" && pwd -P)/$(basename "$artifact_dir")"
case "$artifact_dir" in
  "$repo_root/.artifacts/"*) ;;
  *)
    echo "SDK_ARTIFACT_DIR must be a dedicated child of $repo_root/.artifacts" >&2
    exit 64
    ;;
esac
source_date_epoch="${SOURCE_DATE_EPOCH:-$(git -C "$repo_root" log -1 --format=%ct)}"
if [[ -n "${PYTHON_BIN:-}" ]]; then
  python_bin="$PYTHON_BIN"
else
  python_bin=""
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import ensurepip, pyexpat' >/dev/null 2>&1; then
      python_bin="$(command -v "$candidate")"
      break
    fi
  done
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "sdk release readiness requires '$1' on PATH" >&2
    exit 1
  }
}

for command in node pnpm npm "$python_bin" go cargo git tar gzip; do
  require_command "$command"
done

node_version="$(node -p "require('$repo_root/sdk/node/package.json').version")"
python_version="$($python_bin -c 'import re, sys; text = open(sys.argv[1]).read(); match = re.search(r"^version = \"([^\"]+)\"$", text, re.M); print(match.group(1) if match else "")' "$repo_root/sdk/python/pyproject.toml")"
rust_version="$(sed -n 's/^version = "\([^"]*\)"$/\1/p' "$repo_root/sdk/rust/Cargo.toml" | head -1)"
semver_pattern='^[0-9]+\.[0-9]+\.[0-9]+$'

if [[ ! "$node_version" =~ $semver_pattern || "$node_version" != "$python_version" || "$node_version" != "$rust_version" ]]; then
  echo "SDK package versions must match and use stable SemVer: node=$node_version python=$python_version rust=$rust_version" >&2
  exit 1
fi
version="$node_version"

rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"/{node,python,go,rust}
export SOURCE_DATE_EPOCH="$source_date_epoch"

echo "Building SDK release candidates for v$version (SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH)."

# Node: pack runs the package's prepack test, then a fresh npm project imports
# the packed tarball instead of the workspace source directory.
pnpm --dir "$repo_root/sdk/node" pack --pack-destination "$artifact_dir/node" >/dev/null
node_tarball="$(find "$artifact_dir/node" -maxdepth 1 -name '*.tgz' -type f -print -quit)"
[[ -n "$node_tarball" ]] || { echo "Node pack did not produce a .tgz" >&2; exit 1; }
npm publish --dry-run --access public "$node_tarball" >/dev/null
node_consumer="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-node.XXXXXX")"
cleanup_paths=("$node_consumer")
cleanup() { rm -rf "${cleanup_paths[@]}"; }
trap cleanup EXIT
(
  cd "$node_consumer"
  npm init --yes >/dev/null
)
npm --prefix "$node_consumer" install --ignore-scripts --no-package-lock "$node_tarball" >/dev/null
(
  cd "$node_consumer"
  node --input-type=module -e '
    import { AgentFeedbackRuntime } from "@agent-feedback/node";
    import { createStaticDocsProxy } from "@agent-feedback/node/edge";
    if (typeof AgentFeedbackRuntime !== "function" || typeof createStaticDocsProxy !== "function") {
      process.exit(1);
    }
  '
)

# Python: build both a wheel and source distribution with pinned hatchling,
# validate their metadata, then import only from an installed wheel.
python_tools="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-python-tools.XXXXXX")"
cleanup_paths+=("$python_tools")
"$python_bin" -m venv "$python_tools/venv"
"$python_tools/venv/bin/python" -m pip install --disable-pip-version-check --no-cache-dir 'build==1.3.0' 'twine==6.2.0' >/dev/null
PYTHONPATH="$repo_root/sdk/python/src" "$python_tools/venv/bin/python" -m unittest discover -s "$repo_root/sdk/python/tests" >/dev/null
"$python_tools/venv/bin/python" -m build --outdir "$artifact_dir/python" "$repo_root/sdk/python" >/dev/null
"$python_tools/venv/bin/twine" check "$artifact_dir/python"/* >/dev/null
python_wheel="$(find "$artifact_dir/python" -maxdepth 1 -name '*.whl' -type f -print -quit)"
[[ -n "$python_wheel" ]] || { echo "Python build did not produce a wheel" >&2; exit 1; }
python_consumer="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-python.XXXXXX")"
cleanup_paths+=("$python_consumer")
"$python_bin" -m venv "$python_consumer/venv"
"$python_consumer/venv/bin/python" -m pip install --disable-pip-version-check --no-index --no-deps "$python_wheel" >/dev/null
"$python_consumer/venv/bin/python" -c 'from agent_feedback import AgentFeedback, AgentFeedbackASGI, AgentFeedbackWSGI; assert AgentFeedback and AgentFeedbackASGI and AgentFeedbackWSGI'

# Go modules are distributed by semantic VCS tags, not uploaded registry blobs.
# A deterministic source archive is still produced for release inspection, and
# the extracted module is compiled by an otherwise-empty consumer module.
go_tarball="$artifact_dir/go/agent-feedback-go-$version.tar.gz"
go_stage="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-go-stage.XXXXXX")"
cleanup_paths+=("$go_stage")
mkdir -p "$go_stage/agent-feedback-go-$version"
cp \
  "$repo_root/sdk/go/go.mod" \
  "$repo_root/sdk/go/agent.go" \
  "$repo_root/sdk/go/agentfeedback.go" \
  "$repo_root/sdk/go/README.md" \
  "$go_stage/agent-feedback-go-$version/"
chmod 0644 "$go_stage/agent-feedback-go-$version/"*
TZ=UTC touch -t 202001010000 "$go_stage/agent-feedback-go-$version/"*
if tar --version 2>&1 | grep -q "GNU tar"; then
  tar_owner_args=(--owner=0 --group=0)
else
  tar_owner_args=(--uid 0 --gid 0 --uname root --gname root)
fi
COPYFILE_DISABLE=1 tar \
  --format ustar \
  "${tar_owner_args[@]}" \
  -cf - -C "$go_stage/agent-feedback-go-$version" \
  go.mod agent.go agentfeedback.go README.md \
  | gzip -n > "$go_tarball"
go_extract="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-go-package.XXXXXX")"
cleanup_paths+=("$go_extract")
tar -xzf "$go_tarball" -C "$go_extract"
grep -Fq "agent-feedback-go/$version" "$go_extract/agentfeedback.go" || {
  echo "Go release candidate user-agent does not match v$version" >&2
  exit 1
}
grep -Fq "agent-feedback-go-agent/$version" "$go_extract/agent.go" || {
  echo "Go agent release candidate user-agent does not match v$version" >&2
  exit 1
}
go_consumer="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-go.XXXXXX")"
cleanup_paths+=("$go_consumer")
(
  cd "$go_consumer"
  go mod init example.com/agent-feedback-smoke >/dev/null
  go mod edit -require="github.com/open-software-network/os-epode/sdk/go@v$version"
  go mod edit -replace="github.com/open-software-network/os-epode/sdk/go=$go_extract"
  printf '%s\n' 'package main' 'import agentfeedback "github.com/open-software-network/os-epode/sdk/go"' 'func main() { _ = agentfeedback.Options{} }' > main.go
  go mod tidy
  go build ./...
)

# Cargo package performs the crates.io-equivalent dry run: it creates a .crate,
# extracts it, and compiles the extracted crate. Then compile it again as a
# path dependency of a fresh app to verify the consumer-facing package shape.
(
  cd "$repo_root/sdk/rust"
  cargo package --allow-dirty --locked >/dev/null
)
rust_crate_source="$repo_root/sdk/rust/target/package/agent-feedback-$version.crate"
[[ -f "$rust_crate_source" ]] || { echo "Cargo package did not produce $rust_crate_source" >&2; exit 1; }
rust_crate="$artifact_dir/rust/agent-feedback-$version.crate"
cp "$rust_crate_source" "$rust_crate"
rust_extract="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-rust-package.XXXXXX")"
cleanup_paths+=("$rust_extract")
tar -xzf "$rust_crate" -C "$rust_extract"
rust_consumer="$(mktemp -d "${TMPDIR:-/tmp}/agent-feedback-rust.XXXXXX")"
cleanup_paths+=("$rust_consumer")
mkdir -p "$rust_consumer/src"
printf '%s\n' '[package]' 'name = "agent-feedback-smoke"' 'version = "0.0.0"' 'edition = "2024"' '' '[dependencies]' "agent-feedback = { path = \"$rust_extract/agent-feedback-$version\" }" > "$rust_consumer/Cargo.toml"
printf '%s\n' 'fn main() { let _ = agent_feedback::Options::new("test"); }' > "$rust_consumer/src/main.rs"
(
  cd "$rust_consumer"
  cargo generate-lockfile >/dev/null
  cargo build --locked >/dev/null
)

(
  cd "$artifact_dir"
  find node python go rust -type f -print0 | sort -z | xargs -0 shasum -a 256 > CHECKSUMS.sha256
)

echo "PASS SDK packages built and installed from artifacts: $artifact_dir"
