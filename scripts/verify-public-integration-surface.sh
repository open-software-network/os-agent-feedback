#!/usr/bin/env bash
# Verify the public product surface without following redirects or trusting a
# merely non-empty SDK response. Both canary and production call this exact
# contract before a deployment pair can be attested or tagged.
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 WEB_ORIGIN ACCOUNTS_ORIGIN" >&2
  exit 64
fi

web_origin="${1%/}"
accounts_origin="${2%/}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
legacy_ledger="$script_dir/hosted-artifact-ledger.json"
curl_retry_count="${EPODE_VERIFY_RETRIES:-12}"
curl_retry_delay="${EPODE_VERIFY_RETRY_DELAY:-5}"

for origin in "$web_origin" "$accounts_origin"; do
  if [[ "${EPODE_VERIFY_ALLOW_HTTP_LOCALHOST:-}" == "1" && "$origin" =~ ^http://127\.0\.0\.1:[0-9]+$ ]]; then
    continue
  fi
  if [[ ! "$origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "::error::Expected an origin-only HTTPS URL, found: $origin"
    exit 1
  fi
done

for command in awk curl grep jq mktemp shasum tar unzip; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "::error::Public integration verification requires '$command' on PATH."
    exit 1
  }
done

headers="$(mktemp)"
discovery="$(mktemp)"
manifest="$(mktemp)"
payload="$(mktemp)"
trap 'rm -f "$headers" "$discovery" "$manifest" "$payload"' EXIT

status="$(
  curl --silent --show-error --max-time 20 \
    --retry "$curl_retry_count" --retry-all-errors --retry-delay "$curl_retry_delay" \
    --fail-with-body --output /dev/null --write-out '%{http_code}' \
    "$web_origin/api/health" || true
)"
if [[ "$status" != "200" ]]; then
  echo "::error::$web_origin/api/health returned HTTP $status instead of 200."
  exit 1
fi

status="$(
  curl --silent --show-error --max-time 20 \
    --retry "$curl_retry_count" --retry-all-errors --retry-delay "$curl_retry_delay" \
    --dump-header "$headers" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$web_origin/auth/start"
)"
if [[ "$status" != "303" ]]; then
  echo "::error::$web_origin/auth/start returned HTTP $status instead of 303."
  exit 1
fi
location="$(awk 'BEGIN { IGNORECASE=1 } /^location:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }' "$headers")"
if [[ "$location" != "$accounts_origin"/* ]]; then
  echo "::error::Authentication start did not redirect to the configured accounts origin."
  exit 1
fi
for cookie in af_oa_pkce af_oa_state; do
  cookie_line="$(grep -Ei "^set-cookie: ${cookie}=[^;]+;" "$headers" | head -n 1 || true)"
  if [[ -z "$cookie_line" ]] \
    || ! grep -Eiq '(^|;)[[:space:]]*HttpOnly([;[:space:]]|$)' <<<"$cookie_line" \
    || ! grep -Eiq '(^|;)[[:space:]]*SameSite=Lax([;[:space:]]|$)' <<<"$cookie_line" \
    || ! grep -Eiq '(^|;)[[:space:]]*Secure([;[:space:]]|$)' <<<"$cookie_line"; then
    echo "::error::Authentication start did not set a secure $cookie cookie."
    exit 1
  fi
done

status="$(
  curl --silent --show-error --max-time 20 \
    --retry "$curl_retry_count" --retry-all-errors --retry-delay "$curl_retry_delay" \
    --fail-with-body \
    --output "$discovery" \
    --write-out '%{http_code}' \
    "$web_origin/.well-known/agent-feedback-v1.json"
)"
if [[ "$status" != "200" ]]; then
  echo "::error::Integration discovery returned HTTP $status instead of 200."
  exit 1
fi
jq -e '
  (.integrations
    | type == "object"
    and keys == ["go", "node", "protocol", "python", "rust"]
    and ([.[]] | length) == ([.[]] | unique | length)
    and all(.[]; type == "string"))
  and ((has("integrityManifest") | not)
    or (.integrityManifest | type == "string" and length > 0))
' "$discovery" >/dev/null || {
  echo "::error::Integration discovery is malformed, duplicated, or has unexpected keys."
  exit 1
}
manifest_url="$(jq -r 'if has("integrityManifest") then .integrityManifest else empty end' "$discovery")"
has_manifest=false
if [[ -n "$manifest_url" ]]; then
  manifest_filename="${manifest_url##*/}"
  if [[ "$manifest_url" != "$web_origin/static/"* || ! "$manifest_filename" =~ ^agent-feedback-integrations-([0-9]+\.[0-9]+\.[0-9]+)\.json$ ]]; then
    echo "::error::Discovery advertised an invalid or cross-origin integration integrity manifest."
    exit 1
  fi
  manifest_release="${BASH_REMATCH[1]}"
  status="$(
    curl --silent --show-error --max-time 20 \
      --retry "$curl_retry_count" --retry-all-errors --retry-delay "$curl_retry_delay" \
      --fail-with-body --output "$manifest" --write-out '%{http_code}' \
      "$manifest_url" || true
  )"
  if [[ "$status" != "200" ]]; then
    echo "::error::Integration integrity manifest returned HTTP $status instead of 200."
    exit 1
  fi
  jq -e --arg release "$manifest_release" '
    keys == ["artifacts", "release", "schemaVersion"]
    and .schemaVersion == 1
    and .release == $release
    and (.artifacts | keys == ["go", "node", "protocol", "python", "rust"])
    and all(.artifacts | to_entries[];
      (.value | type == "object")
      and (.value.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and if .key == "protocol" then
        (.value | keys == ["bundleRelease", "filename", "mediaType", "protocolVersion", "sha256"])
      else
        (.value | keys == ["filename", "mediaType", "sha256"])
      end
    )
    and (.artifacts.node.filename == "agent-feedback-node-\($release).tgz")
    and (.artifacts.node.mediaType == "application/gzip")
    and (.artifacts.python.filename == "agent_feedback-\($release)-py3-none-any.whl")
    and (.artifacts.python.mediaType == "application/zip")
    and (.artifacts.go.filename == "agent-feedback-go-\($release).tar.gz")
    and (.artifacts.go.mediaType == "application/gzip")
    and (.artifacts.rust.filename == "agent-feedback-rust-\($release).tar.gz")
    and (.artifacts.rust.mediaType == "application/gzip")
    and .artifacts.protocol.filename == "agent-feedback-protocol-v1-\($release).zip"
    and .artifacts.protocol.mediaType == "application/zip"
    and .artifacts.protocol.protocolVersion == 1
    and .artifacts.protocol.bundleRelease == $release
  ' "$manifest" >/dev/null || {
    echo "::error::Integration integrity manifest is malformed, incomplete, or version-mixed."
    exit 1
  }
  has_manifest=true
elif [[ ! -f "$legacy_ledger" ]]; then
  echo "::error::Pre-manifest rollback verification requires the immutable hosted artifact ledger."
  exit 1
fi

legacy_release=""
while IFS=$'\t' read -r integration integration_url; do
  if [[ "$integration_url" != "$web_origin/static/"* ]]; then
    echo "::error::Discovery advertised $integration outside its public static origin: $integration_url"
    exit 1
  fi
  status="$(
    curl --silent --show-error --max-time 30 \
      --retry "$curl_retry_count" --retry-all-errors --retry-delay "$curl_retry_delay" \
      --fail-with-body \
      --output "$payload" \
      --write-out '%{http_code}' \
      "$integration_url" || true
  )"
  if [[ "$status" != "200" || ! -s "$payload" ]]; then
    echo "::error::$integration artifact returned HTTP $status or an empty body: $integration_url"
    exit 1
  fi
  actual_filename="${integration_url##*/}"
  artifact_release=""
  case "$integration" in
    node) [[ "$actual_filename" =~ ^agent-feedback-node-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$ ]] && artifact_release="${BASH_REMATCH[1]}" ;;
    python) [[ "$actual_filename" =~ ^agent_feedback-([0-9]+\.[0-9]+\.[0-9]+)-py3-none-any\.whl$ ]] && artifact_release="${BASH_REMATCH[1]}" ;;
    go) [[ "$actual_filename" =~ ^agent-feedback-go-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$ ]] && artifact_release="${BASH_REMATCH[1]}" ;;
    rust) [[ "$actual_filename" =~ ^agent-feedback-rust-([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz$ ]] && artifact_release="${BASH_REMATCH[1]}" ;;
    protocol)
      if [[ "$has_manifest" == "true" ]]; then
        [[ "$actual_filename" =~ ^agent-feedback-protocol-v1-([0-9]+\.[0-9]+\.[0-9]+)\.zip$ ]] && artifact_release="${BASH_REMATCH[1]}"
      else
        [[ "$actual_filename" =~ ^agent-feedback-protocol-v[0-9]+\.zip$ ]]
      fi
      ;;
    *) false ;;
  esac || {
    echo "::error::$integration advertised an unexpected hosted artifact filename: $actual_filename"
    exit 1
  }
  if [[ "$has_manifest" == "true" ]]; then
    expected_filename="$(jq -r --arg integration "$integration" '.artifacts[$integration].filename' "$manifest")"
    expected_sha256="$(jq -r --arg integration "$integration" '.artifacts[$integration].sha256' "$manifest")"
  else
    expected_filename="$actual_filename"
    expected_sha256="$(jq -r --arg filename "$actual_filename" '.[$filename] // empty' "$legacy_ledger")"
    if [[ -z "$expected_sha256" ]]; then
      echo "::error::Legacy rollback artifact is not present in the immutable ledger: $actual_filename"
      exit 1
    fi
    if [[ -n "$artifact_release" ]]; then
      if [[ -z "$legacy_release" ]]; then
        legacy_release="$artifact_release"
      elif [[ "$legacy_release" != "$artifact_release" ]]; then
        echo "::error::Pre-manifest rollback discovery mixes SDK releases $legacy_release and $artifact_release."
        exit 1
      fi
    fi
  fi
  actual_sha256="$(shasum -a 256 "$payload" | awk '{print $1}')"
  if [[ "$actual_filename" != "$expected_filename" || "$actual_sha256" != "$expected_sha256" ]]; then
    echo "::error::$integration artifact does not match the reviewed filename and SHA-256 manifest."
    exit 1
  fi
  case "$integration" in
    node | go | rust) tar -tzf "$payload" >/dev/null ;;
    python) unzip -tqq "$payload" >/dev/null ;;
    protocol) unzip -tqq "$payload" >/dev/null ;;
    *) echo "::error::Unsupported integration key $integration"; exit 1 ;;
  esac
done < <(jq -r '.integrations | to_entries[] | [.key, .value] | @tsv' "$discovery")

echo "Verified public health, OAuth start, discovery, and five typed integration artifacts."
