# Deployment and rollback runbook

Epode deploys API and web containers from commit-addressed GHCR tags. A tag is
accepted only when its OCI revision label matches the requested commit, its
registry digest is valid, and Railway reports both the same tag in
`meta.image` and the same digest in `meta.imageDigest` for the successful
deployment.

## Required external configuration

GitHub and Railway configuration is intentionally not created by repository
automation when it controls credentials, human approval, DNS ownership, or
database recovery:

- Create GitHub environments named `v2-canary`, `production`, and
  `sdk-release`. Require production and SDK-release reviewers. Restrict who
  can approve and deploy, and protect `sdk/*/v*` tags.
- Add an environment-scoped `RAILWAY_TOKEN` secret and `RAILWAY_PROJECT_ID`
  variable to `v2-canary` and `production`. The Railway token must be limited
  to the Epode project.
- Add `RAILWAY_CANARY_TOKEN` to the protected `production` environment. It must
  be scoped to read `v2-canary`, not to mutate production; promotion and the
  additive-migration workflow use it only to verify canary attestations.
- The `Postgres` service in both environments must expose
  `DATABASE_PUBLIC_URL` to the GitHub-hosted migration runner. If the database
  service has another name, set `RAILWAY_DATABASE_SERVICE`. Keep Railway's
  network controls and credential rotation in place; the workflow masks the
  resolved URL and never writes it to an artifact or summary.
- In `v2-canary`, set `V2_CANARY_API_DOMAIN` and `V2_CANARY_WEB_DOMAIN` to
  hostnames already attached to their services, without `https://` or a path.
  `agent-feedback-api-v2-canary.up.railway.app` is the existing public API
  hostname. Assign the web hostname in Railway before the first web canary.
- If the Railway services are not named `epode-api` and `epode-web`, set
  `RAILWAY_API_SERVICE` and `RAILWAY_WEB_SERVICE` in each GitHub environment.
- Configure Railway's GHCR pull credential on both services. This credential
  remains in Railway and is never exposed to the workflow.
- Attach the stable canary domains in Railway and complete any external DNS or
  certificate validation. The workflow validates exact ownership. It does not
  replace or delete domains because those operations can change public routing.
- Pre-provision the canary API's `DATABASE_URL`, `OS_ACCOUNTS_URL`,
  `OS_ACCOUNTS_API_URL`, and `OS_ACCOUNTS_CLIENT_ID`. They may be Railway
  references or sealed values. The workflow verifies that the keys exist but
  never prints their values.
- Allow `https://<V2_CANARY_WEB_DOMAIN>` in the OS Accounts App and OAuth
  client's origin policy, and allow
  `https://<V2_CANARY_WEB_DOMAIN>/auth/callback` as a redirect URI. The browser
  begins authentication through the web BFF, so the PKCE cookies and callback
  must remain on that same public origin.
- Configure the npm, PyPI, and crates.io trusted publishers described in
  `sdk/RELEASE.md`. The `sdk-release` environment approval is the review gate
  for the exact uploaded release candidate.
- For SDK releases, create the annotated `sdk/release/vX.Y.Z` marker first,
  then push each annotated package tag in its own `git push` command. Never
  push all four package tags together: GitHub suppresses tag-push workflow
  events when a single push contains more than three tags.
  then create each annotated `sdk/{node,python,rust,go}/vX.Y.Z` package tag at
  that exact commit. Each package workflow validates the common marker before
  publishing, so packages can retry independently without accepting a mixed
  source revision.

The canary workflow safely provisions only public routing values:
`PUBLIC_BASE_URL`, `WEB_APP_URL`, and `API_URL`. It stages them without an
extra deployment, re-reads them for equality, then deploys the API and checks
its health before deploying the web service. After the web health and OAuth
start checks pass, it records the exact API/web refs and digests as the latest
verified canary pair without triggering another deployment.

`PUBLIC_BASE_URL` and `WEB_APP_URL` intentionally use the web domain. That
keeps browser authentication cookies, the OAuth callback, same-origin feedback
and API proxy routes, and generated public links on one origin. `API_URL` on
the web service points to the API domain only for server-to-server BFF
forwarding.

## Canary deployment

Run `Deploy v2 canary` with the same candidate commit SHA for API and web. Both
images are built for every protected-main commit so a release always represents
one source revision, including when only one application directory changed. The
workflow resolves both 7-character tags and digests before entering the
`v2-canary` environment. It then deploys API followed by web and verifies each
Railway digest and public health endpoint. It also verifies that `/auth/start`
redirects to the configured accounts origin, secure PKCE/state cookies, exact
integration discovery, and typed downloadable artifacts before recording the
pair as promotion-eligible. Floating `staging`, `latest`, and `production` tags
are never accepted as deployment inputs.

## Production promotion

Run `Promote or rollback production` with `operation=promote` and the exact API
and web SHAs reviewed in canary. The workflow resolves the complete pair before
the production approval. After approval, it fails closed unless those exact
refs and digests are both the last successfully attested canary pair and the
images currently active in `v2-canary`. It then captures the currently serving
production pair as a verified recovery point and deploys API followed by web.
Production GHCR tags move only after both Railway deployments report the
planned digests and the production health and OAuth-start smoke checks pass.

If either deployment, public smoke, or production-tag move fails, the workflow
attempts both service restorations independently. Tag movement also restores
both prior production tags before failing. A manual cancellation or external
Railway mutation can still interrupt this recovery path; inspect both service
deployment IDs, digests, and tags before retrying.

## Additive database expansion

Ordinary production promotion deliberately rejects an API image whose embedded
SQL migration ledger differs from the active API image. Do not remove or bypass
that check. Once SQLx records a newer migration, an older binary that does not
know that migration is not an automatic restart or rollback candidate.

Schema expansion therefore uses the separate, manually dispatched `Verify or
apply additive database expansion` workflow. It has five operations:

- `verify-canary` and `verify-production` read the SQLx ledger, verify every
  known SQLx SHA-384 checksum, and compute a canonical public-schema
  fingerprint. They do not set Railway variables, redeploy a service, or alter
  the database. Choose whether the database must be in the `before` or `after`
  state. Production `after` verification requires the reviewed canary schema
  fingerprint.
- `apply-canary` accepts exactly one new migration, applies it under the Epode
  advisory lock, restarts the currently active immutable API bridge image, and
  proves that the same image and digest boot successfully against the expanded
  schema. Only then does it record the exact commit, migration path, SHA-256,
  schema fingerprint, bridge image/digest, restarted deployment ID, and
  workflow run as verified canary migration evidence.
- `stage-production-bridge` enters the protected `production` GitHub
  environment and requires `confirm_production=true`. It accepts only a green
  protected-main migration-marker commit whose sole first-parent change is the
  reviewed migration. It verifies that the exact immutable API/web pair and
  migration passed expanded canary, captures the complete restorable
  production pair, then deploys API followed by web while production remains
  on the previous schema. Public health, authentication start, and downloadable
  integration artifacts must pass before production tags move and the exact
  refs, digests, deployment IDs, canary migration run, and schema fingerprint
  are attested. A deployment, smoke, or tag failure restores both prior
  services and tags; this operation never connects to or mutates the database.
- `apply-production` enters the protected `production` GitHub environment. It
  requires a recent opaque backup reference, its RFC3339 verification time, a
  restore-test reference, and `confirm_production=true`. It fails before the
  database changes unless the exact migration has verified canary evidence and
  production is still running the exact API/web migration-marker pair recorded
  by `stage-production-bridge`. It then applies under the same advisory lock,
  requires the production schema fingerprint to equal canary, checks public API
  health, restarts the exact API bridge against the expanded schema, and
  records the recovery, exact application-pair, and schema evidence.

The migration file and the workflow input checksum are two distinct review
facts. `migration_sha256` is the independently reviewed SHA-256 of the exact
file at `target_sha`; SQLx's installed SHA-384 is separately compared with the
database ledger. `target_sha` must be a full protected-main commit with a green
exact-commit CI run.

The dedicated path accepts schema-only additive DDL. It rejects `DROP`,
`TRUNCATE`, replacement/renaming, destructive `ALTER`, and all `INSERT`,
`UPDATE`, `DELETE`, or `MERGE` statements. Data population belongs in a
separately tested, bounded, idempotent backfill after the application is dual
writing. This keeps the expansion transaction short and prevents a migration
from rewriting or locking a live evidence table for the duration of a
historical backfill. Apply mode also sets a five-second PostgreSQL lock timeout
and a five-minute statement timeout; exceeding either fails and rolls back the
migration rather than extending an unbounded production lock.

Use three deliberately separate commits. First deploy an ordinary bridge commit
whose embedded ledger is still version N and which can boot either database N
or the explicitly configured N+1. Next merge a migration-marker commit whose
only change is the reviewed N+1 migration. Its exact API/web pair is deployed to
canary, `apply-canary` expands canary and forces the API bridge to restart, then
`stage-production-bridge` deploys that same exact pair to production while its
database is still N. Only after the production pair is attested should
`apply-production` expand production and restart the exact API bridge. Finally,
merge a normal feature commit whose ledger remains N+1 and promote it through
the unchanged ordinary canary and production workflows. Never combine feature
code with the migration-marker commit or weaken the ordinary promotion ledger
equality gate.

Use opaque provider IDs in backup fields. Never paste a database URL, signed
backup URL, access token, or other credential into a workflow input or summary.

## Rollback

Run the same workflow with `operation=rollback`, the prior API and web SHA
tags, `confirm_rollback=true`, and a non-empty `rollback_reason`. Rollback is an
explicit paired API-then-web deployment with the same tag, digest, approval,
and failure-recovery checks as promotion. Do not use a floating production tag
as the rollback target.

An image rollback does **not** roll back database migrations. The API runs
`sqlx` migrations during startup, and deployed migrations may have changed
schema or data before a later image is selected. Production migrations must be
backward-compatible with the prior API. If a migration itself must be reversed,
stop the image rollback, assess data loss, and execute a separately reviewed
database recovery or forward-fix procedure before changing application images.
