FROM prom/prometheus:v3.13.2
COPY prometheus.yml /etc/prometheus/prometheus.yml
# Attach a Railway volume at /prometheus. The OTLP receiver is how the
# collector delivers application metrics; retention bounds volume growth.
CMD [
    "--config.file=/etc/prometheus/prometheus.yml",
    "--web.enable-otlp-receiver",
    "--storage.tsdb.path=/prometheus",
    "--storage.tsdb.retention.time=30d"
]
