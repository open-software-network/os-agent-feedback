# Local CI signoff

Epode runs pull-request CI on the developer or agent machine that owns the
change. GitHub does not rerun test or build CI. Instead, the local command
posts `signoff/*` commit statuses, and the repository ruleset blocks merge
until every required status exists on the current PR head.

Deployment, migration, promotion, and release workflows remain hosted. They
are delivery automation rather than PR CI and need GitHub environments and
repository secrets. Before acting on a protected-main revision, they verify
the local signoffs from the PR that produced it; they do not rerun CI.

The required local statuses are:

- `signoff/workflows` — actionlint plus shellcheck for deployment and signoff
  scripts
- `signoff/backend` — rustfmt, Clippy, unit tests, OpenAPI drift, and live
  PostgreSQL isolation and migration tests
- `signoff/e2e` — disposable customer-personalization, advertising, and MCP
  journeys
- `signoff/node` — Biome and the root Node test suite
- `signoff/sdk` — Node, Python, Go, and Rust SDK checks, linked-journey
  conformance, Python's MCP lower bound, and release artifact readiness
- `signoff/examples` — example installs, syntax checks, tests, bundle
  validation, reference-product journeys, and health smoke tests
- `signoff/web` — generated types, lint, typecheck, unit tests, production
  build, and the signed-in browser release check
- `signoff/docs` — Mintlify validation and accessibility checks

## One-time setup

Install and authenticate the GitHub CLI, then install Basecamp's signoff
extension:

```sh
gh auth login
gh extension install basecamp/gh-signoff
```

Local CI also expects the repository's supported Node and Rust toolchains,
pnpm, npm, Python, uv, Go, Docker Compose, PostgreSQL client tools,
`actionlint`, and `shellcheck`. On macOS, the last two are available with:

```sh
brew install actionlint shellcheck
```

Backend checks use Rust 1.95 and SDK checks use the SDK's 1.88 MSRV. Install
both through rustup so local CI cannot drift with the machine's default Rust:

```sh
rustup toolchain install 1.95 --profile minimal --component clippy,rustfmt
rustup toolchain install 1.88 --profile minimal --component clippy,rustfmt
```

The backend and e2e suites start the repository's local PostgreSQL service
when needed. Existing local environment files are preserved.

## Sign off on a PR commit

From a clean, pushed branch:

```sh
git push -u origin HEAD
make local-ci
```

`make local-ci` compares the branch with the PR base and runs the suites
needed for the changed paths. It posts every required context. Irrelevant
suites receive a successful not-applicable signoff so a docs-only change does
not have to build the backend.

The command refuses to begin unless the worktree is clean and the remote
branch tip exactly matches local `HEAD`. Before posting each status it checks
those invariants again. A new commit therefore makes the existing statuses
stale automatically and requires a new local run.

Individual suites can be run with:

```sh
make signoff-workflows
make signoff-backend
make signoff-e2e
make signoff-node
make signoff-sdk
make signoff-examples
make signoff-web
make signoff-docs
```

The backend and e2e scripts default to the Compose PostgreSQL database at
`localhost:54329`. Set `DATABASE_URL` to use a different local database.

## Enforcement

The `main-protection` repository ruleset must require the eight `signoff/*`
contexts above and must not require the removed hosted `CI` check. Required
statuses are attached to a commit SHA, so any push blocks the PR again until
local CI signs the new head.

Do not run `gh signoff install` in this repository. It writes classic branch
protection and can bypass the existing ruleset-based protection. Maintain the
contexts on `main-protection` instead.
