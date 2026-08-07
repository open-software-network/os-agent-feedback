#!/usr/bin/env bash
# Hold a newly deployed production pair behind a short synthetic observation
# window. Two consecutive availability or latency failures trip the deploy-time
# circuit breaker; the caller owns restoration of the previously captured pair.
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 API_ORIGIN WEB_ORIGIN" >&2
  exit 64
fi

api_origin="${1%/}"
web_origin="${2%/}"
observation_seconds="${EPODE_OBSERVATION_SECONDS:-300}"
interval_seconds="${EPODE_OBSERVATION_INTERVAL_SECONDS:-30}"
failure_threshold="${EPODE_OBSERVATION_FAILURE_THRESHOLD:-2}"
max_latency_seconds="${EPODE_OBSERVATION_MAX_LATENCY_SECONDS:-5}"

for origin in "$api_origin" "$web_origin"; do
  if [[ "${EPODE_OBSERVATION_ALLOW_HTTP_LOCALHOST:-}" == "1" && "$origin" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]; then
    continue
  fi
  if [[ ! "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "::error::Expected an origin-only HTTPS URL, found: $origin"
    exit 1
  fi
done

for value in "$observation_seconds" "$interval_seconds" "$failure_threshold"; do
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::Observation duration, interval, and failure threshold must be positive integers."
    exit 1
  fi
done
if ! awk -v value="$max_latency_seconds" 'BEGIN { exit !(value > 0) }'; then
  echo "::error::EPODE_OBSERVATION_MAX_LATENCY_SECONDS must be a positive number."
  exit 1
fi

for command in awk curl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "::error::Production observation requires '$command' on PATH."
    exit 1
  }
done

started_at="$(date +%s)"
deadline="$((started_at + observation_seconds))"
consecutive_failures=0
sample=0

probe() {
  local name="$1"
  local url="$2"
  local expected_redirect="${3:-}"
  local result status latency redirect_url

  result="$({
    curl --silent --show-error --max-time 20 \
      --output /dev/null \
      --write-out $'%{http_code}\t%{time_total}\t%{redirect_url}' \
      "$url"
  } 2>/dev/null || true)"
  IFS=$'\t' read -r status latency redirect_url <<<"$result"
  if [[ -z "${latency:-}" ]]; then
    echo "$name probe failed: ${status:-no HTTP response}." >&2
    return 1
  fi
  if [[ "$status" != "200" ]]; then
    if [[ -z "$expected_redirect" || "$status" != "307" || "$redirect_url" != "$expected_redirect" ]]; then
      echo "$name probe failed: HTTP ${status:-no response}, redirect ${redirect_url:-none}." >&2
      return 1
    fi
  fi
  if ! awk -v observed="$latency" -v maximum="$max_latency_seconds" 'BEGIN { exit !(observed <= maximum) }'; then
    echo "$name probe exceeded ${max_latency_seconds}s: ${latency}s." >&2
    return 1
  fi
  if [[ "$status" == "200" ]]; then
    echo "$name probe returned HTTP 200 in ${latency}s."
  else
    echo "$name probe returned the expected HTTP 307 sign-in redirect in ${latency}s."
  fi
}

while true; do
  sample="$((sample + 1))"
  sample_ok=true
  probe "API health" "$api_origin/api/health" || sample_ok=false
  probe "Web root" "$web_origin/" "$web_origin/auth/signin" || sample_ok=false

  if [[ "$sample_ok" == "true" ]]; then
    consecutive_failures=0
  else
    consecutive_failures="$((consecutive_failures + 1))"
    echo "::warning::Production observation sample $sample failed ($consecutive_failures/$failure_threshold consecutive)."
    if [[ "$consecutive_failures" -ge "$failure_threshold" ]]; then
      echo "::error::Production observation circuit breaker tripped after $consecutive_failures consecutive failed samples."
      exit 1
    fi
  fi

  now="$(date +%s)"
  if [[ "$now" -ge "$deadline" ]]; then
    break
  fi
  remaining="$((deadline - now))"
  sleep_for="$interval_seconds"
  if [[ "$remaining" -lt "$sleep_for" ]]; then
    sleep_for="$remaining"
  fi
  sleep "$sleep_for"
done

echo "Production observation passed for ${observation_seconds}s across $sample samples."
