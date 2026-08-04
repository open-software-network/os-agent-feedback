#!/usr/bin/env bash
# Shared preflight for the local signoff scripts. Sourced, not executed.
#
# A signoff status is tied to a specific pushed commit, so every script refuses
# to run unless the worktree is clean and the pushed branch tip matches HEAD.
# That guarantee is what lets the repository ruleset treat signoff/* statuses
# as merge gates.

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
  if ! git rev-parse --abbrev-ref '@{push}' >/dev/null 2>&1; then
    echo "The current branch is not tracking a remote branch. Push it first:" >&2
    echo "  git push -u origin HEAD" >&2
    exit 1
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Commit or stash local changes before signing off. The signoff is tied to HEAD." >&2
    exit 1
  fi

  if [[ -n "$(git log '@{push}'..)" ]]; then
    echo "Push the current HEAD before signing off. The signoff status is posted to the pushed commit." >&2
    echo "  git push" >&2
    exit 1
  fi
}

signoff_preflight() {
  cd "$(git rev-parse --show-toplevel)" || exit 1
  signoff_require_gh
  signoff_require_pushed_head
}

# Local PostgreSQL for the backend isolation tests and the disposable customer
# journeys. The compose service publishes 54329 (not the CI default 5432).
signoff_database_url() {
  printf '%s' "${DATABASE_URL:-postgres://postgres:postgres@localhost:54329/agent_feedback}"
}
