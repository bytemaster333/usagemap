# API: Rust / axum (in-SDK dual export)

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: — the same recipe, in the sample service `tests/fixtures/api/rust-axum/`, dual-exports to the gateway's OTLP front door in the end-to-end suite `tests/e2e/api/30-api.e2e.test.ts` (exact request counts asserted). Source: `spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md`
("Rust axum 0.8", option R1; app `apps/rust-axum/`). Read [api-common.md](api-common.md) first.

> **Header hazard (measured): unset `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS`.** In
> `opentelemetry-otlp` 0.33.1 environment headers are applied after the code's headers: an env `authorization`
> replaced the UsageMap token (401, all UsageMap data lost), and an env `api-key` (your APM key) was added to the UsageMap request.
> Configure your APM headers in code, or use the [tenant Collector](api-collector-fanout.md).

Measured with option R1 (`opentelemetry-instrumentation-tower`): UsageMap received `http.server.request.duration` (s, 14
explicit bounds, cumulative) with `http.route`, and no personal data on metrics. It also received three other tower
metrics (`http.server.active_requests`, request/response body size), which the platform drops: a "forward only one
metric" wrapper **cannot be written** in Rust 0.33.1 (`ResourceMetrics` fields are crate-private).

## `Cargo.toml` (as tested)

```toml
opentelemetry = "0.33.1"
opentelemetry_sdk = "0.33.1"
opentelemetry-otlp = { version = "0.33.1", features = ["reqwest-rustls"] }   # without it: no https
opentelemetry-instrumentation-tower = { version = "0.19.0", features = ["axum"] }   # 'axum' is NOT default
tracing-subscriber = { version = "0.3", features = ["env-filter"] }         # to see export errors
```

axum 0.8.9, rustc 1.99.1. The tower crate's README says `axum` is a default feature; its `Cargo.toml` says
`default = []` — enable it explicitly.

## Setup

```rust
let scf = MetricExporter::builder().with_http()
    .with_endpoint("https://ingest.scf.example/v1/metrics")              // full URL incl. /v1/metrics
    .with_headers(HashMap::from([("Authorization".into(), format!("Bearer {}", std::env::var("SCF_OTLP_TOKEN")?))]))
    .build()?;
let mp = SdkMeterProvider::builder().with_resource(Resource::builder().build())
    .with_periodic_exporter(apm).with_periodic_exporter(scf).build();
global::set_meter_provider(mp.clone());                                   // before building the layer
tracing_subscriber::registry().with(EnvFilter::new("warn")).with(tracing_subscriber::fmt::layer()).init();
let app = Router::new().route("/accounts/{id}", get(account))
    .layer(opentelemetry_instrumentation_tower::http::server::Layer::new()); // after the routes
// on exit (blocking client): tokio::task::spawn_blocking(move || mp.shutdown()).await
```

`apm` is your APM exporter built the same way with its own endpoint and headers in code (the spike's
`apps/rust-axum/src/main.rs`, `init_tower`).

## Runtime requirements

- **Unset** `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS` (see above).
- Set `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<unique per replica>` — the Rust SDK detects
  no instance id.
- The image needs **`ca-certificates`**: with `reqwest-rustls` but no CA bundle, the process panics at start-up while
  building the exporter's HTTP client (exit 101) — even for an `http://` APM exporter.
- Install a `tracing` subscriber: export failures are reported only through it.
- Shutdown was wrapped in `spawn_blocking` as a precaution; calling it directly on a Tokio worker was not tested.

## The `tracing` stack (option R3) — avoid for UsageMap

With `tracing` + `axum-tracing-opentelemetry` 0.42.1 you get **spans only**, carrying raw `url.query`, `Host` and the
User-Agent; unmatched paths get `http.route = ""` (counted as `{unknown}`). Under a plain `info` filter **nothing at
all** is exported, silently: the spans are created at TRACE level on target `otel::tracing`, so add
`otel::tracing=trace` to the `EnvFilter`. If you must use it, send through the tenant Collector with the SERVER-span
filter.
