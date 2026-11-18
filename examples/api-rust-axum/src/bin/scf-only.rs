// SPDX-License-Identifier: Apache-2.0
//! UsageMap only: endpoint, protocol and the Authorization header come from OTEL_EXPORTER_OTLP_* in the environment.
use example_api_rust_axum::{port, routes, shutdown_signal};
use opentelemetry::global;
use opentelemetry_otlp::MetricExporter;
use opentelemetry_sdk::{Resource, metrics::SdkMeterProvider};
use tracing_subscriber::{EnvFilter, prelude::*};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
    let scf = MetricExporter::builder().with_http().build()?;
    let mp = SdkMeterProvider::builder()
        .with_resource(Resource::builder().build()) // reads OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
        .with_periodic_exporter(scf)
        .build();
    global::set_meter_provider(mp.clone()); // before building the layer
    tracing_subscriber::registry().with(EnvFilter::new("warn")).with(tracing_subscriber::fmt::layer()).init();

    let app = routes().layer(opentelemetry_instrumentation_tower::http::server::Layer::new()); // after the routes
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port())).await?;
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    tokio::task::spawn_blocking(move || mp.shutdown()).await??; // flushes the last interval
    Ok(())
}
