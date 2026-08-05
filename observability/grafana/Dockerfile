FROM grafana/grafana:13.1.2
COPY provisioning /etc/grafana/provisioning
# Attach a Railway volume at /var/lib/grafana (dashboards, users, alert
# state). Required service variables: GF_SECURITY_ADMIN_PASSWORD (secret).
