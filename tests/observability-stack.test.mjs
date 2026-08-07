import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoFile = (path) => new URL(`../${path}`, import.meta.url);

test("Prometheus promotes the bounded OTLP resource labels used by production alerts", async () => {
  const config = await readFile(repoFile("observability/prometheus/prometheus.yml"), "utf8");
  assert.match(config, /^otlp:\n/m);
  assert.match(config, /promote_resource_attributes:[\s\S]*deployment\.environment\.name/);
  assert.match(config, /out_of_order_time_window: 30m/);
});

test("Grafana provisions production availability, error-rate, and latency alerts to Slack", async () => {
  const alerts = await readFile(
    repoFile("observability/grafana/provisioning/alerting/epode-production.yaml"),
    "utf8",
  );
  assert.match(alerts, /url: \$EPODE_ALERT_SLACK_WEBHOOK_URL/);
  assert.match(alerts, /uid: epode_api_telemetry_missing/);
  assert.match(alerts, /uid: epode_web_telemetry_missing/);
  assert.match(alerts, /uid: epode_production_5xx_rate/);
  assert.match(alerts, /uid: epode_production_p95_latency/);
  assert.match(alerts, /absent_over_time\(http_server_request_duration_seconds_count/);
  assert.match(alerts, /http_response_status_code=~"5\.\."/);
  assert.match(alerts, /histogram_quantile\(/);
  assert.match(alerts, /deployment_environment_name="production"/);
  assert.equal(alerts.match(/notification_settings:/g)?.length, 4);
  assert.equal(alerts.match(/receiver: Epode production Slack/g)?.length, 4);
  assert.doesNotMatch(
    alerts,
    /^policies:/m,
    "alert provisioning must not overwrite the UI policy tree",
  );
});

test("Grafana fails closed when its production alert receiver is not configured", async () => {
  const dockerfile = await readFile(repoFile("observability/grafana/Dockerfile"), "utf8");
  const entrypoint = await readFile(repoFile("observability/grafana/entrypoint.sh"), "utf8");
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/epode-grafana-entrypoint"\]/);
  assert.match(entrypoint, /-z "\$\{EPODE_ALERT_SLACK_WEBHOOK_URL:-\}"/);
  assert.match(entrypoint, /exec \/run\.sh "\$@"/);
});
