/**
 * Optional OpenTelemetry export for the Next.js server runtime.
 *
 * Export is strictly opt-in: when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset the
 * SDK is never started and the app behaves exactly as before. When set, the
 * standard OTLP variables (`OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_RESOURCE_ATTRIBUTES`, per-signal endpoint overrides) are honored.
 *
 * What this provides:
 * - server traces for page rendering and route handlers (Node SDK
 *   auto-instrumentations), exported to the collector over OTLP/HTTP;
 * - runtime metrics (event loop, memory) on a periodic reader;
 * - W3C trace-context propagation on outbound BFF fetch calls, so the Rust
 *   API continues the same distributed trace (it extracts `traceparent`).
 *
 * Everything here is server-only. No telemetry is sent from the browser.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return;
  }

  // Dynamic imports keep the Node-only SDK out of any edge/client bundles.
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
        // fs instrumentation wraps every static-file read in a span and is
        // pure noise for a Next.js server.
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
