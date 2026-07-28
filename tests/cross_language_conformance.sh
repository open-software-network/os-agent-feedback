#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
  cd "$repo_root/sdk/node"
  npm test
)

(
  cd "$repo_root/sdk/python"
  PYTHONPATH=src python3 -m unittest discover -s tests -v
)

(
  cd "$repo_root/sdk/go"
  go test ./...
)

(
  cd "$repo_root/sdk/rust"
  cargo fmt --all -- --check
  cargo clippy --all-targets -- -D warnings
  cargo test
)

python3 - <<'PY' "$repo_root/protocol/v1"
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
for path in root.glob("*.json"):
    json.loads(path.read_text())
print("PASS protocol: all schemas and conformance vectors are valid JSON")
PY

echo "PASS cross-language conformance: Node, Python, Go, Rust, and protocol"
