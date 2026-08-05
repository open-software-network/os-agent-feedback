FROM grafana/tempo:2.9.4
COPY tempo.yaml /etc/tempo.yaml
# Attach a Railway volume at /tempo.
CMD ["-config.file=/etc/tempo.yaml"]
