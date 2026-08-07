#!/usr/bin/env bash
# Shared preflight for the local signoff scripts. Sourced, not executed.
#
# A signoff status is tied to a specific pushed commit, so every script refuses
# to run unless the worktree is clean and the remote branch tip matches HEAD.
# It verifies that invariant again after the checks, closing the gap where a
# concurrent commit could otherwise receive a status for tests run on an older
# tree.

signoff_require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "${command_name} is required. ${install_hint}" >&2
    exit 1
  fi
}

signoff_require_rust_toolchain() {
  local version="$1"

  signoff_require_command rustup "Install it from https://rustup.rs/."
  if ! rustup run "$version" rustc --version >/dev/null 2>&1; then
    echo "Rust ${version} is required. Install it with:" >&2
    echo "  rustup toolchain install ${version} --profile minimal --component clippy,rustfmt" >&2
    exit 1
  fi
}

signoff_require_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "GitHub CLI is required. Install it from https://cli.github.com/." >&2
    exit 1
  fi

  if ! gh auth status -h github.com >/dev/null 2>&1; then
    echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
    exit 1
  fi

  if ! gh extension list | grep -Eq '(^|[[:space:]])basecamp/gh-signoff([[:space:]]|$)'; then
    echo "gh-signoff is required. Run: gh extension install basecamp/gh-signoff" >&2
    exit 1
  fi
}

signoff_require_pushed_head() {
  local push_ref
  local push_remote
  local push_branch
  local remote_sha

  if ! git rev-parse --abbrev-ref '@{push}' >/dev/null 2>&1; then
    echo "The current branch is not tracking a remote branch. Push it first:" >&2
    echo "  git push -u origin HEAD" >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Commit or stash local changes before signing off. The signoff is tied to HEAD." >&2
    exit 1
  fi

  push_ref="$(git rev-parse --abbrev-ref '@{push}')"
  push_remote="${push_ref%%/*}"
  push_branch="${push_ref#*/}"
  remote_sha="$(git ls-remote --exit-code "$push_remote" "refs/heads/$push_branch" | awk 'NR == 1 { print $1 }')"

  if [[ -z "$remote_sha" || "$remote_sha" != "$(git rev-parse HEAD)" ]]; then
    echo "Push the current HEAD before signing off. The remote branch tip must exactly match HEAD." >&2
    echo "  git push" >&2
    exit 1
  fi
}

signoff_preflight() {
  cd "$(git rev-parse --show-toplevel)" || exit 1
  signoff_require_gh
  signoff_require_pushed_head
  SIGNOFF_COMMIT_SHA="$(git rev-parse HEAD)"
  export SIGNOFF_COMMIT_SHA
}

signoff_post() {
  local context="$1"

  if [[ "$(git rev-parse HEAD)" != "${SIGNOFF_COMMIT_SHA:-}" ]]; then
    echo "HEAD changed while signoff/${context} was running; refusing to sign the untested commit." >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "The worktree changed while signoff/${context} was running; refusing to sign off." >&2
    exit 1
  fi

  signoff_require_pushed_head
  gh signoff "$context"
}

# Root Node tests import the two agent-experience reference products, which are
# intentionally outside the pnpm workspace and keep their own lockfiles.
signoff_install_experience_examples() {
  pnpm --dir sdk/node build
  npm ci \
    --prefix examples/agent-experience-commerce \
    --ignore-scripts \
    --no-audit \
    --no-fund
  npm ci \
    --prefix examples/petsmart-demo \
    --ignore-scripts \
    --no-audit \
    --no-fund
}

# Local PostgreSQL for the backend isolation tests and the disposable customer
# journeys. The compose service publishes 54329 (not the CI default 5432).
signoff_database_url() {
  printf '%s' "${DATABASE_URL:-postgres://postgres:postgres@localhost:54329/agent_feedback}"
}
