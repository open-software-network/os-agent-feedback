FROM grafana/grafana:13.1.2
COPY provisioning /etc/grafana/provisioning
COPY --chmod=0755 entrypoint.sh /usr/local/bin/epode-grafana-entrypoint
# Attach a Railway volume at /var/lib/grafana (dashboards, users, alert
# state). Required service variables: GF_SECURITY_ADMIN_PASSWORD and
# EPODE_ALERT_SLACK_WEBHOOK_URL (secrets).
# Railway volumes mount root-owned while the upstream image runs as the
# `grafana` user, which cannot create its data directories. Run as root
# inside the container so the volume is writable.
USER root
ENTRYPOINT ["/usr/local/bin/epode-grafana-entrypoint"]
