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
use a new SemVer filename (for example, `agent-feedback-node-0.2.0.tgz`); never
replace bytes at an existing URL because package-manager lockfiles pin their
integrity. Keep every previously published hosted filename available.
Record each new hosted filename's SHA-256 in
`tests/hosted-artifact-integrity.test.mjs` before release. Adding a new entry is
expected; changing the checksum for an existing filename is not.

For a release, update the Node, Python, and Rust package versions together,
run the readiness command, and create one protected tag per registry target at
the reviewed commit:

- `sdk/node/vX.Y.Z`
- `sdk/python/vX.Y.Z`
- `sdk/rust/vX.Y.Z`
- `sdk/go/vX.Y.Z`

Each tag starts `sdk-release.yml`. It validates the tag against all package
versions and rebuilds the release candidate before publication. The publishing
job is protected by the GitHub `sdk-release` environment, so a configured
required reviewer must approve it after the tag is pushed.

Before the first release, configure the following trusted publishers, with the
repository `open-software-network/os-epode`, workflow file
`sdk-release.yml`, and environment `sdk-release`:

- npm: `@agent-feedback/node`, allowed action `npm publish`.
- PyPI: `agent-feedback`.
- crates.io: `agent-feedback`; first publication must be done manually before
  crates.io can configure a trusted publisher.

The Go module is published by its protected `sdk/go/vX.Y.Z` tag and is then
available through the Go module proxy; it has no separate registry credential.
The Go release job polls `proxy.golang.org` and fails if that exact version does
not become publicly installable within five minutes.
Protect the `sdk/*/v*` tag pattern and keep the release environment restricted
to SDK maintainers.
