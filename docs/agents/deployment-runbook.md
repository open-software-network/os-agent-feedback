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

The canary workflow safely provisions only public routing values:
`PUBLIC_BASE_URL`, `WEB_APP_URL`, and `API_URL`. It stages them without an
extra deployment, re-reads them for equality, then deploys the API and checks
its health before deploying the web service.

`PUBLIC_BASE_URL` and `WEB_APP_URL` intentionally use the web domain. That
keeps browser authentication cookies, the OAuth callback, same-origin feedback
relay routes, and generated public links on one origin. `API_URL` on the web
service points to the API domain only for server-to-server BFF forwarding.

## Canary deployment

Run `Deploy v2 canary` with the API and web commit SHAs. Each may be a 7-40
character lowercase SHA because path-filtered build workflows can legitimately
produce the two images from different commits. The workflow resolves both
7-character tags and digests before entering the `v2-canary` environment. It
then deploys API followed by web and verifies each Railway digest and public
health endpoint. Floating `staging`, `latest`, and `production` tags are never
accepted as deployment inputs.

## Production promotion

Run `Promote or rollback production` with `operation=promote` and the exact API
and web SHAs reviewed in canary. The workflow resolves the complete pair before
the production approval and captures the currently serving pair as a verified
recovery point. After approval it deploys API and then web. Production GHCR
tags move only after both Railway deployments report the planned digests.

If the web deployment fails, the workflow restores the API recovery image and
leaves both `production` tags unchanged. A manual cancellation or external
Railway mutation can still interrupt this recovery path; inspect both service
deployment IDs and digests before retrying.

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
