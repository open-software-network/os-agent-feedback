FROM grafana/loki:3.7.4
COPY loki.yaml /etc/loki/local-config.yaml
# Attach a Railway volume at /loki.
CMD ["-config.file=/etc/loki/local-config.yaml"]
