FROM grafana/loki:3.7.4
COPY loki.yaml /etc/loki/local-config.yaml
# Attach a Railway volume at /loki.
# Railway volumes mount root-owned while the upstream image drops to a
# non-root user, which cannot create its storage directories. Run as root
# inside the container (private-network, single-tenant state service).
USER root
CMD ["-config.file=/etc/loki/local-config.yaml"]
