#!/usr/bin/env bash
# Run the hosted CI "Product examples" job locally and post signoff/examples.
set -euo pipefail

# shellcheck source=scripts/signoff-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/signoff-common.sh"
signoff_preflight

make node-install
signoff_install_experience_examples

npm ci --prefix examples/customer-context-scenarios --omit=dev --ignore-scripts
npm ci --prefix examples/node-express --omit=dev --ignore-scripts
npm ci --prefix examples/node-mcp --omit=dev --ignore-scripts
npm install \
  --prefix examples/static-docs-edge \
  --ignore-scripts \
  --no-save \
  --package-lock=false \
  wrangler@4.118.0 \
  "$(pwd)/backend/public/agent-feedback-node-0.4.0.tgz"

node --check examples/customer-context-scenarios/mcp-server.js
node --check examples/node-express/src/index.js
node --check examples/node-mcp/src/index.js

npm test --prefix examples/customer-context-scenarios
npm run --prefix examples/static-docs-edge check
npm test --prefix examples/agent-experience-commerce
pnpm --dir examples/petsmart-demo test

export AGENT_FEEDBACK_KEY="af_live_11111111111111111111111111111111_22222222222222222222222222222222_abcdefghijklmnopqrstuvwxyz"
export AGENT_FEEDBACK_URL="http://127.0.0.1:9"

PORT=3100 node examples/node-express/src/index.js > /tmp/epode-example-http.log 2>&1 &
http_pid=$!
PORT=3102 node examples/node-mcp/src/index.js > /tmp/epode-example-mcp.log 2>&1 &
mcp_pid=$!
cleanup() { kill "$http_pid" "$mcp_pid" 2>/dev/null || true; }
trap cleanup EXIT

for port in 3100 3102; do
  ready=false
  for _ in $(seq 1 30); do
    if curl --fail --silent "http://127.0.0.1:${port}/health" > /dev/null; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    cat /tmp/epode-example-http.log /tmp/epode-example-mcp.log
    exit 1
  fi
done

signoff_post examples
