// SPDX-License-Identifier: Apache-2.0
//! Dual export: your APM and UsageMap, both configured in code. Leave OTEL_EXPORTER_OTLP_HEADERS and
//! OTEL_EXPORTER_OTLP_METRICS_HEADERS unset: opentelemetry-otlp 0.33.1 applies them *after* the code's headers, so an
//! env `authorization` would replace the UsageMap token and an env `api-key` would be sent to UsageMap.
//! A filter wrapper cannot be written in 0.33.1 (`ResourceMetrics` fields are crate-private): UsageMap also receives the
//! tower layer's three other metrics, which it drops before storage.
use std::collections::HashMap;

use example_api_rust_axum::{port, routes, shutdown_signal};
use opentelemetry::global;
use opentelemetry_otlp::{MetricExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{Resource, metrics::SdkMeterProvider};
use tracing_subscriber::{EnvFilter, prelude::*};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
    let apm = MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/metrics", std::env::var("APM_OTLP_ENDPOINT")?)) // full URL incl. /v1/metrics
        .with_headers(HashMap::from([("api-key".into(), std::env::var("APM_API_KEY")?)]))
        .build()?;
    let scf = MetricExporter::builder()
        .with_http()
        .with_endpoint(format!("{}/v1/metrics", std::env::var("SCF_OTLP_ENDPOINT")?))
        .with_headers(HashMap::from([(
            "Authorization".into(),
            format!("Bearer {}", std::env::var("SCF_OTLP_TOKEN")?),
        )]))
        .build()?;
    let mp = SdkMeterProvider::builder()
        .with_resource(Resource::builder().build()) // reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
        .with_periodic_exporter(apm)
        .with_periodic_exporter(scf)
        .build();
    global::set_meter_provider(mp.clone()); // before building the layer
    tracing_subscriber::registry().with(EnvFilter::new("warn")).with(tracing_subscriber::fmt::layer()).init();

    let app = routes().layer(opentelemetry_instrumentation_tower::http::server::Layer::new()); // after the routes
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port())).await?;
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    tokio::task::spawn_blocking(move || mp.shutdown()).await??; // flushes both exporters
    Ok(())
}
