#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifacts="$repo_root/backend/public"
python_bin="${PYTHON_BIN:-$(command -v python3.11 || command -v python3)}"

(
  cd "$repo_root/sdk/node"
  npm install --ignore-scripts
  npm pack --pack-destination "$artifacts"
)

"$python_bin" -m pip wheel --no-deps "$repo_root/sdk/python" --wheel-dir "$artifacts"

tar -czf "$artifacts/agent-feedback-go-0.1.0.tar.gz" \
  -C "$repo_root/sdk/go" go.mod agent.go agentfeedback.go README.md
tar -czf "$artifacts/agent-feedback-rust-0.1.0.tar.gz" \
  -C "$repo_root/sdk/rust" Cargo.toml Cargo.lock src README.md
(
  cd "$repo_root"
  zip -qr "$artifacts/agent-feedback-protocol-v1.zip" protocol/v1
)

cp "$artifacts"/agent-feedback-* "$repo_root/public/"
cp "$artifacts"/agent_feedback-*.whl "$repo_root/public/"

echo "PASS hosted SDK artifacts rebuilt from current source"
