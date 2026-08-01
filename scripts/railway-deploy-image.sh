#!/usr/bin/env bash
# Deploy one already-published GHCR SHA tag to one Railway service and prove
# that Railway resolved the same registry digest that was reviewed.
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: $0 ENVIRONMENT SERVICE IMAGE_REF EXPECTED_DIGEST" >&2
  exit 64
fi

environment="$1"
service="$2"
image_ref="$3"
expected_digest="$4"
railway_cli_version="${RAILWAY_CLI_VERSION:-5.30.1}"

for command in docker jq node railway script; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "::error::Deployment requires '$command' on PATH."
    exit 1
  }
done

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
  echo "::error::RAILWAY_TOKEN is not configured for the $environment environment."
  exit 1
fi
if [[ -z "${RAILWAY_PROJECT_ID:-}" ]]; then
  echo "::error::RAILWAY_PROJECT_ID is not configured for the $environment environment."
  exit 1
fi
if [[ ! "$image_ref" =~ ^ghcr\.io/open-software-network/os-epode-(api|web):[0-9a-f]{7}$ ]]; then
  echo "::error::Refusing mutable or unexpected image reference: $image_ref"
  exit 1
fi
if [[ ! "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::Invalid expected image digest: $expected_digest"
  exit 1
fi

installed_version="$(railway --version | awk '{print $2}')"
if [[ "$installed_version" != "$railway_cli_version" ]]; then
  echo "::error::Expected Railway CLI $railway_cli_version, found $installed_version."
  exit 1
fi

# Re-resolve the tag immediately before the Railway mutation. The plan job's
# digest is the reviewed identity; a moved tag must stop the deployment.
registry_digest="$(
  docker buildx imagetools inspect "$image_ref" \
    --format '{{ json .Manifest }}' | jq -r '.digest // empty'
)"
if [[ "$registry_digest" != "$expected_digest" ]]; then
  echo "::error::$image_ref moved: planned $expected_digest, registry now reports ${registry_digest:-no digest}."
  exit 1
fi

services="$(
  railway service list \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$environment" \
    --json
)"
service_count="$(jq --arg service "$service" '[.[] | select(.name == $service)] | length' <<<"$services")"
if [[ "$service_count" -ne 1 ]]; then
  echo "::error::Expected exactly one Railway service named $service in $environment; found $service_count."
  exit 1
fi

previous_id="$(
  jq -r --arg service "$service" \
    'first(.[] | select(.name == $service) | .deploymentId) // empty' <<<"$services"
)"
current_image="$(
  jq -r --arg service "$service" \
    'first(.[] | select(.name == $service) | .source.image) // empty' <<<"$services"
)"
mutation_started_at="$(node --eval 'process.stdout.write(new Date().toISOString())')"

if [[ "$current_image" == "$image_ref" ]]; then
  railway redeploy \
    --project "$RAILWAY_PROJECT_ID" \
    --environment "$environment" \
    --service "$service" \
    --from-source \
    --yes \
    --json >/dev/null
else
  # Railway CLI 5.30 reads non-TTY stdin as JSON configuration. Allocate a
  # PTY so the explicit service configuration flags are honored.
  script --quiet --return --command \
    "railway environment edit --project \"$RAILWAY_PROJECT_ID\" --environment \"$environment\" --service-config \"$service\" source.image \"$image_ref\" --message \"Deploy $image_ref\" --json" \
    /dev/null >/dev/null
fi

# The mutation commands above do not return a deployment ID. Discover the new
# deployment once by service, tag, prior ID, and mutation time, then freeze the
# ID. imageDigest is checked as soon as Railway exposes it and is mandatory on
# SUCCESS, preventing a moved tag or stale registry cache from passing.
deployment_id=""
for _ in $(seq 1 60); do
  deployments="$(
    railway deployment list \
      --project "$RAILWAY_PROJECT_ID" \
      --environment "$environment" \
      --service "$service" \
      --limit 100 \
      --json
  )"

  if [[ -z "$deployment_id" ]]; then
    deployment_id="$(
      jq -r \
        --arg previous_id "$previous_id" \
        --arg image "$image_ref" \
        --arg started_at "$mutation_started_at" \
        'first(.[] | select(
          .id != $previous_id
          and .meta.image == $image
          and .createdAt > $started_at
        ) | .id) // empty' <<<"$deployments"
    )"
    if [[ -z "$deployment_id" ]]; then
      sleep 10
      continue
    fi
    echo "Tracking $environment deployment $deployment_id for $service."
  fi

  deployment="$(
    jq -c --arg deployment_id "$deployment_id" \
      'first(.[] | select(.id == $deployment_id)) // empty' <<<"$deployments"
  )"
  if [[ -z "$deployment" ]]; then
    sleep 10
    continue
  fi

  status="$(jq -r '.status // empty' <<<"$deployment")"
  deployed_image="$(jq -r '.meta.image // empty' <<<"$deployment")"
  deployed_digest="$(jq -r '.meta.imageDigest // empty' <<<"$deployment")"

  if [[ "$deployed_image" != "$image_ref" ]]; then
    echo "::error::Railway deployment $deployment_id reports tag $deployed_image instead of $image_ref."
    exit 1
  fi
  if [[ -n "$deployed_digest" && "$deployed_digest" != "$expected_digest" ]]; then
    echo "::error::Railway deployment $deployment_id resolved $deployed_digest instead of $expected_digest."
    exit 1
  fi

  case "$status" in
    SUCCESS)
      if [[ "$deployed_digest" != "$expected_digest" ]]; then
        echo "::error::Railway deployment $deployment_id succeeded without the expected imageDigest $expected_digest."
        exit 1
      fi
      echo "Railway deployment $deployment_id succeeded with $deployed_image@$deployed_digest."
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        echo "deployment_id=$deployment_id" >>"$GITHUB_OUTPUT"
      fi
      exit 0
      ;;
    FAILED | CRASHED | REMOVED)
      echo "::error::Railway deployment $deployment_id finished with status $status."
      exit 1
      ;;
    *) sleep 10 ;;
  esac
done

echo "::error::Timed out waiting for $service in $environment."
exit 1
