#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifacts="$repo_root/backend/public"
python_bin="${PYTHON_BIN:-$(command -v python3.11 || command -v python3)}"

(
  cd "$repo_root/sdk/node"
  pnpm --filter @agent-feedback/node install --ignore-scripts
  pnpm pack --pack-destination "$artifacts"
)

"$python_bin" -m pip wheel --no-deps "$repo_root/sdk/python" --wheel-dir "$artifacts"

COPYFILE_DISABLE=1 tar --format ustar -cf - \
  -C "$repo_root/sdk/go" go.mod agent.go agentfeedback.go README.md \
  | gzip -n > "$artifacts/agent-feedback-go-0.1.0.tar.gz"
COPYFILE_DISABLE=1 tar --format ustar -cf - \
  -C "$repo_root/sdk/rust" Cargo.toml Cargo.lock src README.md \
  | gzip -n > "$artifacts/agent-feedback-rust-0.1.0.tar.gz"
rm -f "$artifacts/agent-feedback-protocol-v1.zip"
(
  cd "$repo_root"
  zip -qr "$artifacts/agent-feedback-protocol-v1.zip" protocol/v1
)

if unzip -Z1 "$artifacts/agent-feedback-protocol-v1.zip" | grep -q 'outcome\.schema\.json$'; then
  echo "stale outcome.schema.json remained in the protocol artifact" >&2
  exit 1
fi
for required in README.md conformance.json envelope.schema.json feedback-report.schema.json telemetry-batch.schema.json; do
  unzip -Z1 "$artifacts/agent-feedback-protocol-v1.zip" | grep -q "protocol/v1/$required$" || {
    echo "protocol artifact is missing $required" >&2
    exit 1
  }
done

echo "PASS hosted SDK artifacts rebuilt from current source"
