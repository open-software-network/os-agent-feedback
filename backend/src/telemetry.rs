//! Optional OpenTelemetry export: distributed traces, HTTP request metrics,
//! and log forwarding over OTLP/HTTP.
//!
//! Export is strictly opt-in. When neither `OTEL_EXPORTER_OTLP_ENDPOINT` nor
//! `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set the binary behaves exactly as
//! before: structured stdout logging only, and every hook in this module is a
//! cheap no-op. When an endpoint is configured, the standard OTLP environment
//! variables (`OTEL_EXPORTER_OTLP_HEADERS`, per-signal endpoint overrides,
//! `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`) are honored by the
//! exporters, so Railway and local configuration stay convention-based.
//!
//! Signal destinations in the bundled stack:
//! - traces -> collector -> Tempo
//! - metrics -> collector -> Prometheus (native OTLP ingest)
//! - logs   -> collector -> Loki (OTLP endpoint)

#![allow(
    clippy::redundant_pub_crate,
    reason = "crate-restricted visibility satisfies unreachable_pub in this binary-only crate"
)]

use std::{
    env,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

use axum::{extract::MatchedPath, extract::Request, middleware::Next, response::Response};
use opentelemetry::{KeyValue, global, metrics::Histogram, trace::TracerProvider as _};
use opentelemetry_http::HeaderExtractor;
use opentelemetry_otlp::{LogExporter, MetricExporter, SpanExporter};
use opentelemetry_sdk::{
    logs::SdkLoggerProvider, metrics::SdkMeterProvider, propagation::TraceContextPropagator,
    trace::SdkTracerProvider,
};
use tracing_opentelemetry::OpenTelemetrySpanExt as _;
use tracing_subscriber::{
    EnvFilter, Layer as _, layer::SubscriberExt as _, util::SubscriberInitExt as _,
};

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether OTLP export was configured at startup. Middleware uses this gate so
/// the disabled path costs one atomic load per request.
pub(crate) fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

fn otlp_configured() -> bool {
    env::var_os("OTEL_EXPORTER_OTLP_ENDPOINT").is_some()
        || env::var_os("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").is_some()
}

/// The deployment environment stamped onto exported telemetry, preferring
/// Railway's environment name when the service runs on Railway.
fn deployment_environment(app_env: Option<&str>, railway_environment: Option<&str>) -> String {
    railway_environment
        .filter(|value| !value.is_empty())
        .or_else(|| app_env.filter(|value| !value.is_empty()))
        .unwrap_or("development")
        .to_owned()
}

/// Holds the SDK providers so `main` can flush and shut them down after the
/// HTTP server drains. A disabled telemetry stack shuts down as a no-op.
pub(crate) struct Telemetry {
    traces: Option<SdkTracerProvider>,
    metrics: Option<SdkMeterProvider>,
    logs: Option<SdkLoggerProvider>,
}

impl Telemetry {
    const fn disabled() -> Self {
        Self {
            traces: None,
            metrics: None,
            logs: None,
        }
    }

    /// Flushes buffered spans, metrics, and logs. Call after the HTTP server
    /// has stopped accepting connections so in-flight exports complete.
    pub(crate) fn shutdown(self) {
        if let Some(provider) = self.traces
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "opentelemetry tracer provider shutdown failed");
        }
        if let Some(provider) = self.metrics
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "opentelemetry meter provider shutdown failed");
        }
        if let Some(provider) = self.logs
            && let Err(error) = provider.shutdown()
        {
            tracing::warn!(%error, "opentelemetry logger provider shutdown failed");
        }
    }
}

/// Initializes the global tracing subscriber, adding OTLP export layers when
/// an endpoint is configured. Must run before any other subscriber is set.
pub(crate) fn init(production: bool) -> anyhow::Result<Telemetry> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "agent_feedback=info,tower_http=info".into());

    if !otlp_configured() {
        let fmt_layer = tracing_subscriber::fmt::layer();
        if production {
            tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer.json().boxed())
                .init();
        } else {
            tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer.boxed())
                .init();
        }
        return Ok(Telemetry::disabled());
    }

    let service_name = env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "epode-api".to_owned());
    let resource = opentelemetry_sdk::Resource::builder()
        .with_service_name(service_name.clone())
        .with_attributes([
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
            KeyValue::new(
                "deployment.environment.name",
                deployment_environment(
                    env::var("APP_ENV").ok().as_deref(),
                    env::var("RAILWAY_ENVIRONMENT").ok().as_deref(),
                ),
            ),
        ])
        .build();

    let span_exporter = SpanExporter::builder().with_http().build()?;
    let tracer_provider = SdkTracerProvider::builder()
        .with_batch_exporter(span_exporter)
        .with_resource(resource.clone())
        .build();
    global::set_tracer_provider(tracer_provider.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());

    let metric_exporter = MetricExporter::builder().with_http().build()?;
    let meter_provider = SdkMeterProvider::builder()
        .with_reader(opentelemetry_sdk::metrics::PeriodicReader::builder(metric_exporter).build())
        .with_resource(resource.clone())
        .build();
    global::set_meter_provider(meter_provider.clone());

    let log_exporter = LogExporter::builder().with_http().build()?;
    let logger_provider = SdkLoggerProvider::builder()
        .with_batch_exporter(log_exporter)
        .with_resource(resource)
        .build();

    let tracer = tracer_provider.tracer("epode-api");
    let span_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    let log_layer =
        opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new(&logger_provider);

    let fmt_layer = tracing_subscriber::fmt::layer();
    if production {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer.json().boxed())
            .with(span_layer.boxed())
            .with(log_layer)
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer.boxed())
            .with(span_layer.boxed())
            .with(log_layer)
            .init();
    }

    ENABLED.store(true, Ordering::Relaxed);
    tracing::info!(service = %service_name, "opentelemetry export enabled");
    Ok(Telemetry {
        traces: Some(tracer_provider),
        metrics: Some(meter_provider),
        logs: Some(logger_provider),
    })
}

/// Records the W3C `traceparent`/`tracestate` headers of an inbound request as
/// the parent of the current `tower_http` request span, joining traces that
/// the web BFF (or any instrumented client) started. Runs inside the
/// `TraceLayer` span because of layer ordering in `build_app_router`.
pub(crate) async fn extract_parent_context(request: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(request).await;
    }
    let parent = global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(request.headers()))
    });
    let _ = tracing::Span::current().set_parent(parent);
    next.run(request).await
}

fn request_duration_histogram() -> &'static Histogram<f64> {
    static HISTOGRAM: OnceLock<Histogram<f64>> = OnceLock::new();
    HISTOGRAM.get_or_init(|| {
        global::meter("epode-api")
            .f64_histogram("http.server.request.duration")
            .with_unit("s")
            .with_description("Duration of inbound HTTP requests")
            .build()
    })
}

/// Records one `http.server.request.duration` sample per request, keyed by
/// method, matched route template, and response status. Route templates (not
/// raw paths) keep the metric cardinality bounded.
pub(crate) async fn record_request_metrics(request: Request, next: Next) -> Response {
    if !enabled() {
        return next.run(request).await;
    }
    let method = request.method().as_str().to_owned();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_owned(), |path| path.as_str().to_owned());
    let started = Instant::now();
    let response = next.run(request).await;
    let attributes = [
        KeyValue::new("http.request.method", method),
        KeyValue::new("http.route", route),
        KeyValue::new(
            "http.response.status_code",
            i64::from(response.status().as_u16()),
        ),
    ];
    request_duration_histogram().record(started.elapsed().as_secs_f64(), &attributes);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_is_disabled_by_default_in_tests() {
        assert!(!enabled());
    }

    #[test]
    fn disabled_telemetry_shutdown_is_a_noop() {
        Telemetry::disabled().shutdown();
    }

    #[test]
    fn deployment_environment_prefers_railway() {
        assert_eq!(
            deployment_environment(Some("production"), Some("production")),
            "production"
        );
        assert_eq!(
            deployment_environment(Some("production"), Some("pr-12")),
            "pr-12"
        );
    }

    #[test]
    fn deployment_environment_falls_back_to_app_env_then_development() {
        assert_eq!(deployment_environment(Some("staging"), None), "staging");
        assert_eq!(deployment_environment(Some(""), None), "development");
        assert_eq!(deployment_environment(None, None), "development");
    }
}
