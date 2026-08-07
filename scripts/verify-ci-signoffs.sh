#!/usr/bin/env bash
# Verify that a protected-main commit was either signed directly or produced
# by a merged PR whose exact head commit has every required local CI signoff.
set -euo pipefail

target_sha="${1:-}"
repository="${GITHUB_REPOSITORY:-}"
default_branch="${DEFAULT_BRANCH:-main}"

if [[ ! "$target_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected an exact 40-character commit SHA." >&2
  exit 1
fi
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "GITHUB_REPOSITORY must be owner/name." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required to verify CI signoffs." >&2
  exit 1
fi

required_contexts=(
  signoff/workflows
  signoff/backend
  signoff/e2e
  signoff/node
  signoff/sdk
  signoff/examples
  signoff/web
  signoff/docs
)

verify_commit_statuses() {
  local sha="$1"
  local statuses
  local context
  local state
  local missing=()

  statuses="$(
    gh api \
      -H 'Accept: application/vnd.github+json' \
      "/repos/${repository}/commits/${sha}/status?per_page=100"
  )"

  for context in "${required_contexts[@]}"; do
    state="$(
      jq -r --arg context "$context" \
        '[.statuses[] | select(.context == $context)][0].state // "missing"' \
        <<<"$statuses"
    )"
    if [[ "$state" != "success" ]]; then
      missing+=("${context}=${state}")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    printf 'Missing successful local CI signoffs on %s: %s\n' \
      "$sha" "${missing[*]}" >&2
    return 1
  fi
}

if verify_commit_statuses "$target_sha" 2>/dev/null; then
  echo "Verified all local CI signoffs directly on $target_sha."
  exit 0
fi

pull_request="$(
  DEFAULT_BRANCH="$default_branch" TARGET_SHA="$target_sha" gh api \
    -H 'Accept: application/vnd.github+json' \
    "/repos/${repository}/commits/${target_sha}/pulls?per_page=100" \
    --jq \
      'map(select(.merged_at != null and .base.ref == env.DEFAULT_BRANCH and .merge_commit_sha == env.TARGET_SHA)) | max_by(.merged_at) | [.number, .head.sha] | @tsv' \
    2>/dev/null || true
)"

if [[ -z "$pull_request" || "$pull_request" == $'\t' ]]; then
  echo "Commit $target_sha has no direct signoff and is not the merge result of a signed PR into $default_branch." >&2
  exit 1
fi

IFS=$'\t' read -r pull_number pull_head_sha <<<"$pull_request"
if [[ ! "$pull_number" =~ ^[0-9]+$ || ! "$pull_head_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "GitHub returned invalid merged-PR signoff provenance for $target_sha." >&2
  exit 1
fi

if ! verify_commit_statuses "$pull_head_sha"; then
  echo "Merged PR #$pull_number did not sign off its exact head commit." >&2
  exit 1
fi

echo "Verified local CI signoffs from merged PR #$pull_number head $pull_head_sha for $target_sha."
