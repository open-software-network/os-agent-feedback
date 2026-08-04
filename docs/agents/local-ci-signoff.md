# Local CI signoff

Epode uses local signoff for PR checks. Hosted GitHub Actions minutes are
slow and rented; developer laptops are fast and already paid for. On pull
requests, every test and build job is replaced by a local run that posts a
green `signoff/*` commit status when it passes. Push to `main` still runs the
full hosted suite, so merged code is always verified in the cloud.

One hosted job stays on PRs: **Workflow lint** (actionlint + shellcheck). It
is cheap and guards the workflow files and the signoff scripts themselves.

Each hosted PR job maps to a required commit status:

- `Backend` → `signoff/backend` (rustfmt, Clippy, unit tests, OpenAPI drift,
  and the live PostgreSQL isolation and migration tests)
- `Customer enrichment journey` → `signoff/e2e` (the disposable customer
  personalization, advertising, and MCP journeys)
- `Node and Biome` → `signoff/node`
- `Node SDK` + `SDK package artifacts` → `signoff/sdk`
- `Product examples` → `signoff/examples`
- `Web` → `signoff/web` (types drift, lint, typecheck, unit tests, production
  build, and the dashboard release browser check)
- `Documentation` → `signoff/docs`

## One-time setup

Install GitHub CLI and the Basecamp signoff extension:

```sh
gh auth login
gh extension install basecamp/gh-signoff
```

The backend and e2e suites also need the local PostgreSQL container; the
signoff scripts start it with `make dev-db` when they run. The SDK suite needs
node, pnpm, npm, python, go, and cargo on `PATH`.

## Sign off on a PR commit

From a clean pushed branch:

```sh
git push -u origin HEAD
make local-ci
```

`make local-ci` compares the branch with the PR base, runs the suites needed
for the changed paths, and posts every required status. If a suite is not
relevant to the changed paths, the command posts its status as not applicable
without running it, so docs-only PRs stay mergeable when the repository
ruleset requires every signoff context.

The lower-level commands are available when you want to run one status
explicitly:

```sh
make signoff-backend
make signoff-e2e
make signoff-node
make signoff-sdk
make signoff-examples
make signoff-web
make signoff-docs
```

Each runs the same steps the hosted job used to run. The backend and e2e
scripts export `DATABASE_URL` pointing at the local compose PostgreSQL
(`localhost:54329`); set `DATABASE_URL` yourself to target something else.

If checks pass, the command posts the matching `signoff/*` status to the
current pushed commit. If the branch changes later, run `make local-ci` again
for the new HEAD.

## Force hosted CI on a PR

Add labels to a PR when a cloud-hosted verification run is useful:

- `run-backend-ci`
- `run-e2e-ci`
- `run-node-ci`
- `run-sdk-ci` (enables both SDK jobs)
- `run-examples-ci`
- `run-web-ci`
- `run-docs-ci`

You can also run the workflow manually from the Actions tab, and every job
runs on push to `main` regardless of labels.

## Enforce the signoff

To require local signoff before merge, add these required status checks to
the existing `main-protection` repository ruleset, alongside the existing
`CI` check:

- `signoff/backend`
- `signoff/e2e`
- `signoff/node`
- `signoff/sdk`
- `signoff/examples`
- `signoff/web`
- `signoff/docs`

Do not run `gh signoff install` in this repository. That command writes
classic branch protection and can bypass the repo's existing ruleset-based
protection.
