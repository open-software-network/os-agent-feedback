#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-http://localhost:8080}"
api_key="${API_KEY:?Set API_KEY to a disposable af_live_ key created through the OS Accounts dashboard}"

mcp() {
  local payload="$1"
  curl -fsS -H 'content-type: application/json' -H "authorization: Bearer $api_key" -d "$payload" "$base_url/mcp"
}

initialize="$(mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"live-e2e","version":"1.0.0"}}}')"
jq -e '.result.serverInfo.name == "agent-feedback"' <<<"$initialize" >/dev/null

tools="$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')"
jq -e '[.result.tools[].name] == ["agent_start_session","agent_record_event","agent_complete_session"]' <<<"$tools" >/dev/null

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
