#!/usr/bin/env bash
set -euo pipefail

rest_url="${REST_PRODUCT_URL:-https://example-status-agent-production.up.railway.app}"
website_url="${WEBSITE_PRODUCT_URL:-https://example-fastify-agent-production.up.railway.app}"
mcp_url="${MCP_PRODUCT_URL:-https://example-mcp-agent-production.up.railway.app/mcp}"
feedback_origin="${TRUSTED_FEEDBACK_ORIGIN:-https://agent-feedback-api-production.up.railway.app}"
python_url="${PYTHON_PRODUCT_URL:-}"
go_url="${GO_PRODUCT_URL:-}"
rust_url="${RUST_PRODUCT_URL:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

request() {
  local method="$1"
  local url="$2"
  local payload="$3"
  shift 3
  curl -sS -X "$method" -H 'content-type: application/json' "$@" -d "$payload" -w $'\n%{http_code}' "$url"
}

status_of() { tail -n 1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

rest_adapter="$(TRUSTED_FEEDBACK_ORIGIN="$feedback_origin" node "$repo_root/examples/customer-agent-http/src/index.js" "$rest_url/api/status")"
jq -e '.productStatus == 200 and .productBody.available == true and .feedback.contractReliability == "best_effort_without_agent_adapter" and .feedback.accepted == true and .feedback.outcome == "success"' <<<"$rest_adapter" >/dev/null
if jq -e '.. | strings | select(startswith("af_live_"))' <<<"$rest_adapter" >/dev/null; then
  echo "FAIL Express: company key leaked" >&2
  exit 1
fi
echo "PASS Express: generic metadata is labeled best-effort; feedback-aware agent submitted deterministically"

privacy_product="$(request POST "$rest_url/api/status" '{}')"
privacy_body="$(body_of "$privacy_product")"
privacy_result="$(request POST "$(jq -er '._agentFeedback.submit.url' <<<"$privacy_body")" '{"outcome":"success","note":"Otherwise valid review.","prompt":"private customer prompt"}' -H "authorization: $(jq -er '._agentFeedback.submit.authorization' <<<"$privacy_body")")"
test "$(status_of "$privacy_result")" = "400"
echo "PASS privacy: unknown sensitive fields are rejected recursively"

website_adapter="$(TRUSTED_FEEDBACK_ORIGIN="$feedback_origin" node "$repo_root/examples/customer-agent-http/src/index.js" "$website_url/agent-docs")"
jq -e '.productStatus == 200 and (.productBody | contains("Checkout status documentation")) and (.productBody | contains("scoped feedback contract consumed and redacted")) and .feedback.contractReliability == "best_effort_without_agent_adapter" and .feedback.accepted == true and .feedback.outcome == "success"' <<<"$website_adapter" >/dev/null
echo "PASS Fastify website: HTML metadata plus deterministic feedback-aware agent submission"

test_language_adapter() {
  local language="$1"
  local url="$2"
  test -n "$url" || return 0
  local result
  result="$(TRUSTED_FEEDBACK_ORIGIN="$feedback_origin" node "$repo_root/examples/customer-agent-http/src/index.js" "$url/api/status")"
  jq -e --arg language "$language" '.productStatus == 200 and .productBody.available == true and .feedback.contractReliability == "best_effort_without_agent_adapter" and .feedback.accepted == true and .feedback.outcome == "success"' <<<"$result" >/dev/null
  echo "PASS $language: shared receipt contract and deterministic adapter submission"
}

test_language_adapter "Python ASGI" "$python_url"
test_language_adapter "Go net/http" "$go_url"
test_language_adapter "Rust Axum" "$rust_url"

probe_dir="$(mktemp -d)"
trap 'test -n "$probe_dir" && test "$probe_dir" != "/" && rm -rf "$probe_dir"' EXIT
mcp_initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"independent-e2e-agent","version":"1.0.0"}}}'
curl -sS -D "$probe_dir/headers" -o "$probe_dir/initialize" -X POST "$mcp_url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$mcp_initialize"
mcp_session="$(awk 'BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub("\r", "", $2); print $2}' "$probe_dir/headers")"
test -n "$mcp_session"
jq -e '.result.serverInfo.name == "example-company-checkout"' "$probe_dir/initialize" >/dev/null

mcp_call() {
  request POST "$mcp_url" "$1" -H 'accept: application/json, text/event-stream' -H "mcp-session-id: $mcp_session"
}

tools="$(mcp_call '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"
test "$(status_of "$tools")" = "200"
jq -e '[.result.tools[].name] | index("check_status") != null and index("report_product_outcome") != null' <<<"$(body_of "$tools")" >/dev/null

mcp_product="$(mcp_call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"check_status","arguments":{"scenario":"live"}}}')"
test "$(status_of "$mcp_product")" = "200"
mcp_product_body="$(body_of "$mcp_product")"
mcp_handle="$(jq -er '.result.structuredContent._agentFeedback.feedbackHandle' <<<"$mcp_product_body")"
[[ "$mcp_handle" == afr2_* ]]
jq -e '.result.structuredContent.available == true and (.result.content[-1].text | contains("report_product_outcome"))' <<<"$mcp_product_body" >/dev/null
mcp_review_payload="$(jq -cn --arg handle "$mcp_handle" '{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"report_product_outcome",arguments:{feedbackHandle:$handle,outcome:"success",note:"The MCP status tool confirmed checkout availability."}}}')"
mcp_feedback="$(mcp_call "$mcp_review_payload")"
test "$(status_of "$mcp_feedback")" = "200"
jq -e '.result.structuredContent.accepted == true' <<<"$(body_of "$mcp_feedback")" >/dev/null
echo "PASS MCP: confirmed tool use, proof-based session, autonomous outcome tool"

mcp_failure="$(mcp_call '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"check_status","arguments":{"scenario":"simulated_failure"}}}')"
test "$(status_of "$mcp_failure")" = "200"
mcp_failure_body="$(body_of "$mcp_failure")"
mcp_failure_handle="$(jq -er '.result.structuredContent._agentFeedback.feedbackHandle' <<<"$mcp_failure_body")"
mcp_failure_review="$(jq -cn --arg handle "$mcp_failure_handle" '{jsonrpc:"2.0",id:6,method:"tools/call",params:{name:"report_product_outcome",arguments:{feedbackHandle:$handle,outcome:"failure",note:"The MCP status tool reported checkout as unavailable."}}}')"
mcp_failure_feedback="$(mcp_call "$mcp_failure_review")"
test "$(status_of "$mcp_failure_feedback")" = "200"
jq -e '.result.structuredContent.accepted == true and .result.structuredContent.review.outcome == "failure"' <<<"$(body_of "$mcp_failure_feedback")" >/dev/null
echo "PASS MCP failure: negative product outcome stored"

echo "PASS customer-agent E2E: HTTP adapter and autonomous MCP used no company key"
