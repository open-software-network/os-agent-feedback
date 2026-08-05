/**
 * Optional OpenTelemetry export for the Next.js Node runtime.
 *
 * This module is dynamically imported only by the Node instrumentation entry.
 * Keeping Node process APIs here prevents Next.js from including them in its
 * Edge instrumentation analysis. No telemetry is sent from the browser.
 */
export async function registerNodeInstrumentation() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  const [
    { NodeSDK },
    { getNodeAutoInstrumentations },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "epode-web",
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? process.env.OTEL_SERVICE_VERSION,
      "deployment.environment.name":
        process.env.RAILWAY_ENVIRONMENT ?? process.env.APP_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 60_000,
      }),
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = () => {
    sdk.shutdown().catch((error: unknown) => {
      process.stderr.write(
        `opentelemetry shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
