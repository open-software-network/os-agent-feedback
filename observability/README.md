# Observability stack (self-hosted on Railway)

Epode's applications export OpenTelemetry signals (traces, metrics, logs)
over OTLP to a single collector, which fans them out to a small Grafana
stack. Everything here is open source and runs as ordinary Railway services.

```text
epode-api (Rust) ─┐
                  ├─ OTLP ─▶ collector ─┬─ traces  ─▶ Tempo
epode-web (Next) ─┘                     ├─ metrics ─▶ Prometheus (OTLP ingest)
                                        └─ logs    ─▶ Loki (OTLP endpoint)
                                                            ▼
                                                         Grafana
```

Export is opt-in in both applications: with `OTEL_EXPORTER_OTLP_ENDPOINT`
unset they keep their previous behavior exactly (stdout logs, no metrics,
no spans) and pay no runtime cost.

## Local development

Use the bundled all-in-one development image instead of this directory:

```sh
make dev-observability   # Grafana on http://localhost:3001 (admin/admin)
```

Then set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` in
`backend/.env` and `web/.env.local`. The `grafana/otel-lgtm` image is
documented by Grafana as a development/evaluation image — do not deploy it
for real traffic; use the per-component stack below.

## Railway services

Deploy each subdirectory as its own Railway service from this repository
(set the service's root directory to the subdirectory; each has a pinned
`Dockerfile`). Provision in dependency order so the collector can resolve
its peers:

| Service      | Directory                   | Volume mount        | Notes |
| ------------ | --------------------------- | ------------------- | ----- |
| `tempo`      | `observability/tempo`       | `/var/tempo`        | no public domain; `/tempo` is the binary, cannot mount there |
| `loki`       | `observability/loki`        | `/loki`             | no public domain |
| `prometheus` | `observability/prometheus`  | `/prometheus`       | no public domain |
| `collector`  | `observability/collector`   | none                | no public domain |
| `grafana`    | `observability/grafana`     | `/var/lib/grafana`  | the only public domain |

The service names matter: `collector/collector.yaml` and Grafana's
provisioned datasources address peers as `<name>.railway.internal`. If you
name a service differently, update those two configs to match.

Only `grafana` gets a public domain. The collector's OTLP ports (4317/4318)
and the storage services stay on Railway's private network; the applications
reach them through private DNS.

Grafana service variables:

- `GF_SECURITY_ADMIN_PASSWORD` — required secret for the initial admin user.
- `GF_USERS_ALLOW_SIGN_UP=false`
- `GF_ANALYTICS_REPORTING_ENABLED=false`

## Connecting the applications

Set these on `epode-api` and `epode-web` (canary first, then production via
the normal promote flow):

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.railway.internal:4318
OTEL_SERVICE_NAME=epode-api        # epode-web on the web service
```

Both exporters honor the standard `OTEL_EXPORTER_OTLP_HEADERS` variable if
the collector ever gains authentication. The API stamps
`deployment.environment.name` from Railway's environment automatically, so
canary and production telemetry stay separable in Grafana.

What you get once connected:

- **Traces**: one distributed trace per dashboard request, starting in the
  Next.js BFF and continuing in the Rust API (W3C `traceparent` propagation
  on the server-to-server fetch).
- **Metrics**: `http.server.request.duration` per API route/method/status,
  plus Node runtime metrics from the web service.
- **Logs**: the API's structured logs in Loki, correlated to traces by trace
  ID (use the "Logs for this span" button on any trace).

## Alerting

Grafana alerting is provisioned-ready: add a contact point (Slack webhook or
email) in the Grafana UI, then alert rules against Prometheus (error rate,
p95 latency per route) and Loki (e.g. `level=warn` bursts from the data
destination or code-match workers). Alert rule state persists in the Grafana
volume.

## Operations notes

- **Backups**: snapshot the four volumes; Prometheus/Loki/Tempo each keep
  30 days of retention, so loss means a 30-day telemetry gap, not data loss
  for the product.
- **Upgrades**: bump the pinned image tags deliberately, one component at a
  time, collector last. Check upstream release notes for config changes.
- **Scaling out**: the clean exit path is object storage for Loki/Tempo and
  Mimir for metrics, or repointing `OTEL_EXPORTER_OTLP_ENDPOINT` at Grafana
  Cloud. Neither requires application changes.
