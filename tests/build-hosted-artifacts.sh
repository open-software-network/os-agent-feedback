#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifacts="$repo_root/backend/public"
python_bin="${PYTHON_BIN:-$(command -v python3.11 || command -v python3)}"
version="$(node -p "require('$repo_root/sdk/node/package.json').version")"

(
  cd "$repo_root/sdk/node"
  pnpm --filter @agent-feedback/node install --ignore-scripts
  pnpm pack --pack-destination "$artifacts"
)
node "$repo_root/tests/sync-example-sdk-integrity.mjs" --write

"$python_bin" -m pip wheel --no-deps "$repo_root/sdk/python" --wheel-dir "$artifacts"

COPYFILE_DISABLE=1 tar --format ustar -cf - \
  -C "$repo_root/sdk/go" go.mod agent.go agentfeedback.go README.md \
  | gzip -n > "$artifacts/agent-feedback-go-$version.tar.gz"
COPYFILE_DISABLE=1 tar --format ustar -cf - \
  -C "$repo_root/sdk/rust" Cargo.toml Cargo.lock src README.md \
  | gzip -n > "$artifacts/agent-feedback-rust-$version.tar.gz"
protocol_artifact="$artifacts/agent-feedback-protocol-v1.zip"
if [[ ! -f "$protocol_artifact" ]]; then
  echo "the immutable protocol v1 artifact is missing" >&2
  exit 1
fi
if unzip -Z1 "$protocol_artifact" | grep -q 'outcome\.schema\.json$'; then
  echo "stale outcome.schema.json remained in the protocol artifact" >&2
  exit 1
fi
for required in README.md conformance.json consent-decision.schema.json envelope.schema.json feedback-report.schema.json telemetry-batch.schema.json; do
  unzip -Z1 "$protocol_artifact" | grep -q "protocol/v1/$required$" || {
    echo "protocol artifact is missing $required" >&2
    exit 1
  }
  cmp --silent <(unzip -p "$protocol_artifact" "protocol/v1/$required") "$repo_root/protocol/v1/$required" || {
    echo "protocol/v1/$required changed; publish a new protocol version instead of overwriting v1" >&2
    exit 1
  }
done

echo "PASS hosted SDK artifacts rebuilt from current source"
