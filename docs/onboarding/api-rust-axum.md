# Rust / axum API: the first 10 minutes

**UsageMap-only, configured by environment variables.** A few lines build the meter provider and the tower layer; the
endpoint and token come from the environment. With UsageMap as the only destination the Rust exporter's header behaviour
(environment headers override code headers) cannot hurt you. Already have an APM? See
[dual export](api-dual-export.md): there the environment headers **must** stay unset.

**Tested:** the example below runs in the repository's backend suite with the environment of step 3 against a local
stand-in of the UsageMap endpoint: requests with three status codes on `/accounts/{id}`, then `SIGTERM`. UsageMap received
`http.server.request.duration` with `http.route`, the status code and the duration, counts equal to what the app
answered, in the export the shutdown flush sent; no client address, user agent or query string anywhere.

| Minute | Step |
|---|---|
| 0–2 | Portal: **Add an API**, then **Ingest tokens** → create a token |
| 2–4 | Add the crates |
| 4–7 | Add the setup below |
| 7–10 | Run with the environment below; the API wizard shows data after one export interval (60 s) |

## 1. Crates

```toml
[dependencies]
opentelemetry = "0.33.1"
opentelemetry_sdk = "0.33.1"
opentelemetry-otlp = { version = "0.33.1", features = ["reqwest-rustls"] }          # https support
opentelemetry-instrumentation-tower = { version = "0.19.0", features = ["axum"] }  # 'axum' is not a default feature
tracing-subscriber = { version = "0.3", features = ["env-filter"] }                # export errors are reported here
```

The versions our test suite runs and the current ones on crates.io (2026-11-16), with axum 0.8.9, tokio 1.54.1 and
rustc 1.99.1. The example's `Cargo.toml` pins them exactly (`=0.33.1`) and its `Cargo.lock` pins the rest.

## 2. Setup

The example service [`examples/api-rust-axum`](../../examples/api-rust-axum/) in full: the binary `src/bin/scf-only.rs`

```rust
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
```

and the route and shutdown signal it shares with the dual-export binary, `src/lib.rs`:

```rust
//! The tenant's API (one route) and the shutdown signal both binaries use.
use axum::{Router, extract::Path, http::StatusCode, routing::get};

pub async fn account(Path(id): Path<String>) -> (StatusCode, String) {
    match id.as_str() {
        "GMISSING" => (StatusCode::NOT_FOUND, r#"{"error":"account not found"}"#.into()),
        "GBOOM" => (StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"internal"}"#.into()),
        _ => (StatusCode::OK, format!(r#"{{"id":"{id}"}}"#)),
    }
}

pub fn routes() -> Router {
    Router::new().route("/accounts/{id}", get(account))
}

/// SIGTERM (deploys, `docker stop`) or Ctrl-C.
pub async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {},
        _ = tokio::signal::ctrl_c() => {},
    }
}

pub fn port() -> String {
    std::env::var("PORT").unwrap_or_else(|_| "8080".into())
}
```

## 3. Environment

```sh
OTEL_SERVICE_NAME=my-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_...
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_RESOURCE_ATTRIBUTES=service.instance.id=api-1
```

- The exporter appends `/v1/metrics` to the endpoint and URL-decodes header values (`%20` is the space).
- The Rust SDK sets no instance id; give each replica its own `service.instance.id`.
- The container image needs **`ca-certificates`**: without a CA bundle the process panics at start-up while building
  the HTTPS client.

## 4. Check it

The API wizard shows requests per route (`/accounts/{id}`), status codes and latency. The tower layer also sends
active-request and body-size metrics, which UsageMap drops (they appear in the data-quality table). Nothing arrives? See
[troubleshooting](troubleshooting.md#api-opentelemetry).

Do not use the `tracing` span stack (`axum-tracing-opentelemetry`) for UsageMap: it sends spans only, carries raw query
strings and Host headers, and exports nothing under a plain `info` filter.

## Where this comes from

- `opentelemetry-otlp` 0.33.1 documentation (docs.rs, read 2026-11-16): signal paths appended to
  `OTEL_EXPORTER_OTLP_ENDPOINT` for HTTP; `OTEL_EXPORTER_OTLP_HEADERS` as `key1=value1,key2=value2`, values
  URL-decoded.
- The crates, the `axum` feature, the resource and the shutdown flush are run with these versions by our test suite
  (`examples/api-rust-axum`); `ca-certificates` was measured against the real https endpoint; crates.io for the
  current versions.
