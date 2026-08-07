FROM prom/prometheus:v3.13.2
COPY prometheus.yml /etc/prometheus/prometheus.yml
# Attach a Railway volume at /prometheus. The OTLP receiver is how the
# collector delivers application metrics; retention bounds volume growth.
# Railway volumes mount root-owned while the upstream image drops to
# `nobody`, which cannot write the TSDB. Run as root inside the container
# (private-network, single-tenant state service).
USER root
# Keep the CMD JSON array on one line: multi-line JSON is not valid
# Dockerfile syntax and fails the image build.
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--web.enable-otlp-receiver", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=30d"]
