#!/usr/bin/env bash
set -euo pipefail
mkdir -p vendor/agent-feedback-rust
curl -fsSL "${EP0DE_ORIGIN:-https://app.epode.ai}/static/agent-feedback-rust-0.1.0.tar.gz" | tar -xz -C vendor/agent-feedback-rust
