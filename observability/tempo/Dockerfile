FROM grafana/tempo:2.9.4
COPY tempo.yaml /etc/tempo.yaml
# Attach a Railway volume at /var/tempo. (Not /tempo: the tempo binary
# itself is that file, so a volume cannot mount there.)
# Railway volumes mount root-owned while the upstream image drops to a
# non-root user, which cannot create its storage directories. Run as root
# inside the container (private-network, single-tenant state service).
USER root
CMD ["-config.file=/etc/tempo.yaml"]
