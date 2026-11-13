//! S-06b Rust sample API: axum 0.8 with two instrumentation options, dual export.
//!   RUST_OTEL_MODE=tower    (R1) opentelemetry-instrumentation-tower: metrics -> APM + UsageMap, spans -> APM
//!   RUST_OTEL_MODE=tracing  (R3) tracing + tracing-opentelemetry + axum-tracing-opentelemetry: spans -> APM + UsageMap
use std::collections::HashMap;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::Path,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use opentelemetry::{global, trace::TracerProvider as _};
use opentelemetry_otlp::{MetricExporter, SpanExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    Resource, metrics::SdkMeterProvider, propagation::TraceContextPropagator, trace::SdkTracerProvider,
};
use serde_json::json;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

fn env(k: &str) -> String {
    std::env::var(k).unwrap_or_default()
}
fn apm_headers() -> HashMap<String, String> {
    HashMap::from([("api-key".into(), env("APM_API_KEY"))])
}
fn scf_headers() -> HashMap<String, String> {
    HashMap::from([("Authorization".into(), format!("Bearer {}", env("SCF_OTLP_TOKEN")))])
}

// ---- sample API ----
async fn health() -> impl IntoResponse {
    Json(json!({"status": "ok"}))
}
async fn account(Path(id): Path<String>) -> impl IntoResponse {
    if id == "GNOTFOUND" {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "account not found"})));
    }
    (StatusCode::OK, Json(json!({"id": id, "balance": "100.0000000"})))
}
async fn asset(Path((code, issuer)): Path<(String, String)>) -> impl IntoResponse {
    tokio::time::sleep(Duration::from_millis(15)).await;
    Json(json!({"code": code, "issuer": issuer}))
}
async fn payments() -> impl IntoResponse {
    (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid payment"})))
}
async fn boom() -> impl IntoResponse {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "internal"})))
}
fn routes() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/accounts/{id}", get(account))
        .route("/assets/{code}/{issuer}", get(asset))
        .route("/payments", post(payments))
        .route("/boom", get(boom))
}

enum Providers {
    Tower(SdkMeterProvider, SdkTracerProvider),
    Tracing(SdkTracerProvider),
}

// ---- R1: tower metrics, two periodic readers ----
fn init_tower() -> Providers {
    let resource = Resource::builder().build(); // service.name from OTEL_SERVICE_NAME
    let apm = MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/metrics", env("APM_ENDPOINT"))) // full URL incl. /v1/metrics
        .with_headers(apm_headers())
        .build()
        .expect("apm metric exporter");
    let scf = MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/metrics", env("SCF_OTLP_ENDPOINT")))
        .with_headers(scf_headers())
        .build()
        .expect("scf metric exporter");
    let mp = SdkMeterProvider::builder()
        .with_resource(resource.clone())
        .with_periodic_exporter(apm)
        .with_periodic_exporter(scf)
        .build();
    let apm_spans = SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/traces", env("APM_ENDPOINT")))
        .with_headers(apm_headers())
        .build()
        .expect("apm span exporter");
    let tp = SdkTracerProvider::builder().with_resource(resource).with_batch_exporter(apm_spans).build();
    global::set_meter_provider(mp.clone()); // before building the layer
    global::set_tracer_provider(tp.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());
    // Without a tracing subscriber the SDK's own export errors (e.g. HTTP 401) are invisible.
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();
    Providers::Tower(mp, tp)
}

// ---- R3: tracing stack, two batch span exporters ----
fn init_tracing() -> Providers {
    let resource = Resource::builder().build();
    let apm = SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/traces", env("APM_ENDPOINT")))
        .with_headers(apm_headers())
        .build()
        .expect("apm span exporter");
    let scf = SpanExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/traces", env("SCF_OTLP_ENDPOINT")))
        .with_headers(scf_headers())
        .build()
        .expect("scf span exporter");
    let tp = SdkTracerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(apm)
        .with_batch_exporter(scf)
        .build();
    global::set_tracer_provider(tp.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());
    // axum-tracing-opentelemetry creates its spans at TRACE level on target "otel::tracing".
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,otel::tracing=trace"));
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_opentelemetry::layer().with_tracer(tp.tracer("s06b-rust-axum")))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();
    Providers::Tracing(tp)
}

#[tokio::main]
async fn main() {
    let mode = env("RUST_OTEL_MODE");
    let (providers, app) = if mode == "tracing" {
        let p = init_tracing();
        let app = routes()
            .layer(axum_tracing_opentelemetry::middleware::OtelInResponseLayer)
            .layer(axum_tracing_opentelemetry::middleware::OtelAxumLayer::default());
        (p, app)
    } else {
        let p = init_tower();
        // Apply after the routes so MatchedPath (http.route) is visible to the layer.
        let app = routes().layer(opentelemetry_instrumentation_tower::http::server::Layer::new());
        (p, app)
    };
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await.unwrap();
    eprintln!("listening on :8080 mode={mode}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            term.recv().await;
        })
        .await
        .unwrap();
    // Flush on exit. The default exporters use a blocking reqwest client; run shutdown off the async runtime.
    tokio::task::spawn_blocking(move || match providers {
        Providers::Tower(mp, tp) => {
            eprintln!("shutdown metrics: {:?}", mp.shutdown());
            eprintln!("shutdown traces: {:?}", tp.shutdown());
        }
        Providers::Tracing(tp) => eprintln!("shutdown traces: {:?}", tp.shutdown()),
    })
    .await
    .unwrap();
}
