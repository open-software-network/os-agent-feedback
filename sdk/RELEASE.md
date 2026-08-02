# SDK registry release checklist

The packages under `sdk/` share one stable SemVer version. Build and smoke-test
the exact package artifacts before tagging:

```sh
bash scripts/sdk-release-readiness.sh
```

This creates disposable artifacts in `.artifacts/sdk-release/`; it never
changes the bootstrap files in `backend/public/`. Those hosted files remain
available until all registry releases are established and consumers have moved
to registry installation.

Hosted bootstrap artifacts are immutable releases too. A changed package must
use a new SemVer filename (for example, `agent-feedback-node-0.2.1.tgz`); never
replace bytes at an existing URL because package-manager lockfiles pin their
integrity. Keep every previously published hosted filename available.
Record each new hosted filename's SHA-256 in
`tests/hosted-artifact-integrity.test.mjs` before release. Adding a new entry is
expected; changing the checksum for an existing filename is not.
`tests/build-hosted-artifacts.sh` also generates the versioned public integrity
manifest from the staged bytes. Discovery advertises that manifest, deployment
smoke downloads every artifact and verifies its SHA-256 and archive type, and
the Setup agent prompt performs the same check before installation.

For a release, update the Node, Python, and Rust package versions together and
run the readiness command. Create the annotated, protected common release
marker first, then one annotated protected tag per registry target at that
same reviewed commit:

- `sdk/release/vX.Y.Z`
- `sdk/node/vX.Y.Z`
- `sdk/python/vX.Y.Z`
- `sdk/rust/vX.Y.Z`
- `sdk/go/vX.Y.Z`

Push the common marker first. Then push each of the four package tags in a
separate `git push` command. GitHub does not create tag-push workflow events
when more than three tags are pushed in one operation, so a single multi-tag
push can silently skip every package release (see
[GitHub's push-event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)):

```sh
git push origin sdk/release/vX.Y.Z
git push origin sdk/node/vX.Y.Z
git push origin sdk/python/vX.Y.Z
git push origin sdk/rust/vX.Y.Z
git push origin sdk/go/vX.Y.Z
```

Each package tag starts `sdk-release.yml`. It validates its annotated tag,
shared package versions, and the common release marker before rebuilding the
release candidate and publishing only that package. This avoids a deadlock in
which the first package tag waits for future package tags while still ensuring
every registry artifact comes from one reviewed source revision. The publishing
job is protected by the GitHub `sdk-release` environment, so a configured
required reviewer must approve it after the package tag is pushed.

Before the first release, configure the following trusted publishers, with the
repository `open-software-network/os-epode`, workflow file
`sdk-release.yml`, and environment `sdk-release`:

- npm: `@epode/node`, allowed action `npm publish`. npm configures
  trusted publishing from an existing package's settings, so bootstrap the
  package once with a short-lived granular token and the exact reviewed
  release-candidate tarball, then remove the token. See
  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- PyPI: create a pending trusted publisher for `agent-feedback`; it can create
  the project on the first workflow publication. See
  [PyPI pending publishers](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).
- crates.io: `agent-feedback`; first publication must be done manually before
  crates.io can configure a trusted publisher.

The Go module is published by its protected `sdk/go/vX.Y.Z` tag and is then
available through the Go module proxy; it has no separate registry credential.
The Go release job polls `proxy.golang.org` and fails if that exact version does
not become publicly installable within five minutes.
Protect both `sdk/release/v*` and `sdk/*/v*` tag patterns and keep the release
environment restricted to SDK maintainers.
