#!/usr/bin/env bash
set -euo pipefail

base_url="${BASE_URL:-https://agent-feedback-api-production.up.railway.app}"
api_key="${API_KEY:?Set API_KEY to a disposable Agent Feedback key}"
phase="${1:?Usage: production_acceptance.sh auto|ask_once|ask_always|off|auth-rejected}"

request() {
  local method="$1"
  local path="$2"
  local payload="$3"
  curl -sS -X "$method" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $api_key" \
    -d "$payload" \
    -w $'\n%{http_code}' \
    "$base_url$path"
}

status_of() { tail -n 1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

if [[ "$phase" == "auth-rejected" ]]; then
  rejected="$(request POST /api/v1/sessions '{"task":"Rejected credential test","agentName":"acceptance-agent"}')"
  test "$(status_of "$rejected")" = "401"
  echo "PASS auth-rejected: inactive credential returned 401"
  exit 0
fi

external_id="acceptance-$phase-$(date +%s%N)"
start_payload="$(jq -n --arg external_id "$external_id" --arg phase "$phase" '{externalId:$external_id,agentName:"production-acceptance-agent",task:("Exercise the " + $phase + " feedback policy") }')"
started="$(request POST /api/v1/sessions "$start_payload")"
if [[ "$phase" == "ask_once" || "$phase" == "ask_always" ]]; then
  test "$(status_of "$started")" = "410"
  jq -e '.error | test("v2 SDK")' <<<"$(body_of "$started")" >/dev/null
  echo "PASS $phase: legacy V1 refuses to claim consent semantics"
  exit 0
fi
test "$(status_of "$started")" = "201"
session_id="$(jq -er '.session.id' <<<"$(body_of "$started")")"

retried="$(request POST /api/v1/sessions "$start_payload")"
test "$(status_of "$retried")" = "201"
test "$(jq -er '.session.id' <<<"$(body_of "$retried")")" = "$session_id"

event_payload='{"type":"tool_call","name":"acceptance.policy","status":"succeeded","durationMs":1,"summary":"Recorded a bounded acceptance-test event."}'
event="$(request POST "/api/v1/sessions/$session_id/events" "$event_payload")"
test "$(status_of "$event")" = "201"

case "$phase" in
  auto)
    missing="$(request POST "/api/v1/sessions/$session_id/complete" '{}')"
    test "$(status_of "$missing")" = "400"
    completion='{"worked":true,"summary":"Automatic mode required and stored this acceptance review.","confidence":0.99,"wouldUseAgain":true,"friction":"none"}'
    completed="$(request POST "/api/v1/sessions/$session_id/complete" "$completion")"
    test "$(status_of "$completed")" = "200"
    completed_body="$(body_of "$completed")"
    jq -e '.feedbackStored == true' <<<"$completed_body" >/dev/null
    feedback_id="$(jq -er '.feedback.id' <<<"$completed_body")"
    completed_at="$(jq -er '.session.completedAt' <<<"$completed_body")"
    duplicate="$(request POST "/api/v1/sessions/$session_id/complete" "$completion")"
    test "$(status_of "$duplicate")" = "200"
    duplicate_body="$(body_of "$duplicate")"
    test "$(jq -er '.feedback.id' <<<"$duplicate_body")" = "$feedback_id"
    test "$(jq -er '.session.completedAt' <<<"$duplicate_body")" = "$completed_at"
    echo "PASS auto: required feedback, retry-safe start, idempotent completion"
    ;;
  off)
    completion='{"worked":true,"summary":"Off mode must discard this submitted review.","confidence":0.99,"wouldUseAgain":true,"friction":"none"}'
    completed="$(request POST "/api/v1/sessions/$session_id/complete" "$completion")"
    test "$(status_of "$completed")" = "200"
    jq -e '.feedbackStored == false and .feedback == null' <<<"$(body_of "$completed")" >/dev/null
    echo "PASS off: submitted feedback was not stored, retry-safe start"
    ;;
  *)
    echo "Unknown phase: $phase" >&2
    exit 2
    ;;
esac
