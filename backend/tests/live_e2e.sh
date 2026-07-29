#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-http://localhost:8080}"
api_key="${API_KEY:?Set API_KEY to a disposable af_live_ key created through the OS Accounts dashboard}"

mcp() {
  local payload="$1"
  local modern method name
  modern="$(jq -c '.params = (.params // {}) | .params._meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {"name":"live-e2e","version":"2.0.0"},
    "io.modelcontextprotocol/clientCapabilities": {}
  }' <<<"$payload")"
  method="$(jq -er '.method' <<<"$modern")"
  name="$(jq -r '.params.name // empty' <<<"$modern")"
  if test -n "$name"; then
    curl -fsS -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' -H "mcp-method: $method" -H "mcp-name: $name" -H "authorization: Bearer $api_key" -d "$modern" "$base_url/mcp"
  else
    curl -fsS -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' -H "mcp-method: $method" -H "authorization: Bearer $api_key" -d "$modern" "$base_url/mcp"
  fi
}

discovery="$(mcp '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}')"
jq -e '.result.resultType == "complete" and (.result.supportedVersions | index("2026-07-28")) != null and .result._meta["io.modelcontextprotocol/serverInfo"].name == "agent-feedback"' <<<"$discovery" >/dev/null

tools="$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"
jq -e '.result.resultType == "complete" and .result.cacheScope == "private" and [.result.tools[].name] == ["agent_start_session","agent_record_event","agent_complete_session"]' <<<"$tools" >/dev/null

start_payload="$(jq -n '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"agent_start_session",arguments:{task:"Test MCP session and autonomous feedback",agentName:"rust-live-e2e",externalId:("mcp-" + (now|tostring))}}}')"
started="$(mcp "$start_payload")"
session_id="$(jq -er '.result.structuredContent.session.id' <<<"$started")"

event_payload="$(jq -n --arg session "$session_id" '{jsonrpc:"2.0",id:4,method:"tools/call",params:{name:"agent_record_event",arguments:{sessionId:$session,type:"tool_call",name:"example.fetch",status:"succeeded",durationMs:37,summary:"Reached the public test endpoint."}}}')"
event_result="$(mcp "$event_payload")"
jq -e '.result.structuredContent.accepted == true' <<<"$event_result" >/dev/null

complete_payload="$(jq -n --arg session "$session_id" '{jsonrpc:"2.0",id:5,method:"tools/call",params:{name:"agent_complete_session",arguments:{sessionId:$session,worked:true,summary:"The Rust MCP flow recorded a trace and stored autonomous feedback.",confidence:0.99,wouldUseAgain:true,friction:"none"}}}')"
completed="$(mcp "$complete_payload")"
jq -e '.result.structuredContent.completed == true and .result.structuredContent.feedbackStored == true' <<<"$completed" >/dev/null

blocked_status="$(curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -H "authorization: Bearer $api_key" -d '{"name":"unsafe","prompt":"private prompt"}' "$base_url/api/v1/sessions/$session_id/events")"
test "$blocked_status" = "400"

echo "live agent e2e passed: MCP, session, trace, autonomous feedback, privacy rejection"
