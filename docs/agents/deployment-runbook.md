# Deployment and rollback runbook

Epode deploys API and web containers from commit-addressed GHCR tags. A tag is
accepted only when its OCI revision label matches the requested commit, its
registry digest is valid, and Railway reports both the same tag in
`meta.image` and the same digest in `meta.imageDigest` for the successful
deployment.

## Observability

Traces, metrics, and logs from `epode-api` and `epode-web` flow over OTLP to
a self-hosted Grafana stack on Railway (collector, Tempo, Prometheus, Loki,
Grafana). The stack's per-service configs, pinned images, and provisioning
live in [`observability/`](../../observability/README.md), including the
service/volume table and the two application environment variables
(`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`) that switch export on.

Export is opt-in per environment: set the variables on `v2-canary` first,
confirm traces arrive in Grafana, then set them on `production` as part of a
promotion. Leaving them unset keeps the previous stdout-only behavior, so the
stack can be deployed independently of any application release.

## Required external configuration

GitHub and Railway configuration is intentionally not created by repository
automation when it controls credentials, human approval, DNS ownership, or
database recovery:

- Create GitHub environments named `v2-canary`, `production`, and
  `sdk-release`. Require production and SDK-release reviewers. Restrict who
  can approve and deploy, and protect `sdk/*/v*` tags.
- Protect `main` with a repository or organization ruleset that requires the
  aggregate `CI` status check, blocks force pushes and deletion, and requires
  changes to arrive through a pull request. The release workflows independently
  verify exact-commit CI, but branch rules prevent an unreviewed main commit
  from becoming a release candidate in the first place.
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
- On the Grafana service, set the secret `EPODE_ALERT_SLACK_WEBHOOK_URL`, then
  send a test through the provisioned **Epode production Slack** contact point
  and verify that the on-call recipient receives it. Alert rules and thresholds
  are versioned in `observability/grafana/provisioning/alerting/`.
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
planned digests, the production health and OAuth-start smoke checks pass, and a
five-minute observation window sees no two consecutive availability or latency
failures from the public API and web origins. The default observation samples
every 30 seconds and treats a response slower than five seconds as failed.
Protected production variables may override the duration, interval, failure
threshold, and latency ceiling with `PRODUCTION_OBSERVATION_SECONDS`,
`PRODUCTION_OBSERVATION_INTERVAL_SECONDS`,
`PRODUCTION_OBSERVATION_FAILURE_THRESHOLD`, and
`PRODUCTION_OBSERVATION_MAX_LATENCY_SECONDS`.

If either deployment, public smoke, observation window, or production-tag move
fails, the workflow attempts both service restorations independently. Tag
movement also restores both prior production tags before failing. A manual
cancellation or external Railway mutation can still interrupt this recovery
path; inspect both service deployment IDs, digests, and tags before retrying.

## Alert response

Grafana evaluates the versioned production rules every minute and sends firing
and resolved notifications to the provisioned Slack contact point. On a firing
notification:

1. Acknowledge it in the operations channel and note the first firing time,
   service label, and most recent production workflow run.
2. Check whether `Promote or rollback production` is still running. During its
   observation window, two consecutive public probe failures automatically
   restore the captured API/web pair before production tags move; let that
   compensation finish unless a service restoration itself reports failure.
3. Compare the active Railway deployment IDs, immutable SHA refs, and digests
   for both services with the last successful workflow summary. Never infer a
   complete release from only one service or from a floating tag.
4. If a completed release introduced the regression, run `Promote or rollback
   production` with `operation=rollback`, the prior API and web SHAs,
   `confirm_rollback=true`, and a concise reason. Watch the health smoke and
   observation window through completion.
5. If telemetry is missing but the public product is healthy, repair the OTLP
   path or observability service instead of rolling back unrelated application
   code. Confirm both missing-telemetry rules return to normal and that Slack
   receives the resolved notification.

An image rollback never reverses SQL migrations. Follow the database recovery
rules below whenever the alert correlates with a schema change.

## Additive database expansion

Production application processes never mutate the database. They verify every
migration in their embedded SQLx ledger and tolerate only a newer additive
suffix explicitly authorized by `EPODE_ADDITIVE_MIGRATION_MAX_VERSION`. This
keeps the immediately previous image restartable after expansion without
allowing an unreviewed schema version.

Ordinary promotion and rollback may cross one migration boundary. The changed
migration must be an immutable add/remove delta and must match the exact path,
SHA-256, and version recorded by a verified production expansion. More than one
boundary or any edit to an existing migration fails before production changes.

Schema expansion uses the manually dispatched `Verify or apply additive
database expansion` workflow. It has four operations:

- `verify-canary` and `verify-production` read the SQLx ledger, verify every
  known SQLx SHA-384 checksum, and compute a canonical public-schema
  fingerprint. They do not set Railway variables, redeploy a service, or alter
  the database. Choose whether the database must be in the `before` or `after`
  state. Production `after` verification automatically loads the reviewed
  canary schema fingerprint.
- `apply-canary` accepts exactly one new migration, applies it under the Epode
  advisory lock, restarts the currently active immutable API image, and proves
  that the same image and digest boot against the expanded schema. Only then
  does it record the commit, derived migration facts, schema fingerprint,
  restarted image, deployment ID, and workflow run as verified evidence.
- `apply-production` enters the protected `production` GitHub environment. It
  requires a recent opaque backup reference, its RFC3339 verification time, a
  restore-test reference, and `confirm_production=true`. It fails before the
  database changes unless the exact migration has verified canary evidence. It
  authorizes the additive suffix for the currently running API, applies under
  the same advisory lock, requires the production schema fingerprint to equal
  canary, restarts that exact image, checks public health, and records recovery
  and schema evidence.

The operator supplies only the operation, `target_sha`, and production recovery
acknowledgements. The workflow derives the added migration path, version,
previous version, and SHA-256 from the commit. `target_sha` must add exactly one
migration, be on protected main, and have a green exact-commit CI run. SQLx's
installed SHA-384 is independently compared with the database ledger.

The dedicated path accepts schema-only additive DDL. It rejects `DROP`,
`TRUNCATE`, replacement/renaming, destructive `ALTER`, and all `INSERT`,
`UPDATE`, `DELETE`, or `MERGE` statements. Data population belongs in a
separately tested, bounded, idempotent backfill after the application is dual
writing. This keeps the expansion transaction short and prevents a migration
from rewriting or locking a live evidence table for the duration of a
historical backfill. Apply mode also sets a five-second PostgreSQL lock timeout
and a five-minute statement timeout; exceeding either fails and rolls back the
migration rather than extending an unbounded production lock.

Use the normal expand/contract order. First promote code that works with schema
N and N+1. Next merge an isolated commit adding migration N+1, run
`apply-canary`, then run `apply-production` with current backup evidence. Both
operations are retry-safe: if SQLx already recorded the exact migration, they
verify and continue instead of applying it twice. Finally promote the feature
code that uses N+1. Promotion recognizes the verified production expansion and
allows that single ledger boundary.

Use opaque provider IDs in backup fields. Never paste a database URL, signed
backup URL, access token, or other credential into a workflow input or summary.

## Rollback

Run the same workflow with `operation=rollback`, the prior API and web SHA
tags, `confirm_rollback=true`, and a non-empty `rollback_reason`. Rollback is an
explicit paired API-then-web deployment with the same tag, digest, approval,
and failure-recovery checks as promotion. Do not use a floating production tag
as the rollback target.

An image rollback does **not** roll back database migrations. Production API
startup verifies the known SQLx prefix and its authorized additive suffix but
never changes the schema. Every production migration must therefore remain
compatible with the immediately prior API image. If a migration itself must be
reversed, stop the image rollback, assess data loss, and execute a separately
reviewed database recovery or forward-fix before changing application images.
