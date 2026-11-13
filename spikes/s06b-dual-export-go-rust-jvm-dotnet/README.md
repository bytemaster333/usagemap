# S-06b — Dual export from Go, Rust, Java and .NET to a tenant APM and the UsageMap endpoint

**Result:** PASS — all four stacks dual-export with the corrected recipes. Every stack except Rust's `tracing` option
delivers `http.server.request.duration` (s, explicit semconv buckets, cumulative) with `http.route` to an endpoint that
requires a bearer token. The Rust env-header hazard is confirmed (`Bearer WRONG` replaced the code token: 401, UsageMap data
lost). Nine recipe corrections are listed below.

## Question

Do the researched dual-export recipes (§A, §B.3–B.6, §C), none of which had
ever been run, actually work for Go `net/http`, Rust `axum`, Java Spring Boot (agent 2.x) and .NET minimal API? What
reaches the UsageMap endpoint: signals, metric names, units, histogram type and bounds, temporality, `http.route` on metrics
and spans, and attributes that could carry personal data? Does the Rust env-header precedence hazard (ADR-0009) occur?

## Method (versions, commands, how to re-run: one command if possible)

**Re-run everything:** `./run.sh` (or `./run.sh go|rust|java|dotnet`). Takes about 7 minutes. It writes
`evidence/report-<stack>.md`, removes the containers with `docker compose -p scf-s06b down -v` and keeps the images.
Host ports: 18610 (APM), 18620 (UsageMap), 18640 (Go), 18650 (Rust), 18660 (Java), 18670 (.NET). All are bound to 127.0.0.1.

Test rig (`compose.yaml`, project `scf-s06b`):

| Component | What it is |
|---|---|
| `apm` | stock `otel/opentelemetry-collector-contrib:0.165.0` (`sha256:e40d61f1…8cea`), OTLP/HTTP with no auth, file exporters `out/apm-{metrics,traces,logs}.jsonl`. This is the tenant's own APM. |
| `scf` | the same image, OTLP/HTTP behind `bearertokenauth` (`Authorization: Bearer <token>`), metrics and traces pipelines only (no logs, as in ADR-0009), file exporters `out/scf-*.jsonl`. |
| `scf-proxy` | `tools/scf_proxy.py` (stdlib Python on `python:3.13-alpine3.23`), placed in front of `scf`. It records per request the scenario, status, Authorization (shown as `Bearer <UsageMap token>` when correct), whether an `api-key` header (the APM key) was present, User-Agent and TLS. It serves `:4318` (http) and `:4443` (https, throwaway CA made by `run.sh`). |
| `tenant-col` | recipe §A, unchanged except for the endpoints (`collector/tenant-fanout.yaml`). |

The test credentials are fake: UsageMap token `scfa_ing_s06btest…`, APM key `apm-test-key-s06b`.

Sample apps (`apps/`, reusable as e2e fixtures). All have the same routes: `GET /health` (200), `GET /accounts/{id}`
(200; 404 for `GNOTFOUND`, a 4xx on a matched route), `GET /assets/{code}/{issuer}` (200, 15 ms), `POST /payments` (400),
`GET /boom` (500).

`tools/traffic.sh` sends 44 requests, including 3 to an unmatched path. Every request carries canaries: a query
`?cursor=42&email=canary%40example.com`, `User-Agent: s06b-canary-UA/1.0`, `X-Forwarded-For: 203.0.113.7` (an RFC 5737
documentation address) and `Host: canary-host.example:8443`. Export interval is 5 s, and each app flushes on SIGTERM.
`tools/analyze.py` summarises the collector files per `service.name` (one per scenario).

| Stack | Versions (exact) | Build/run |
|---|---|---|
| Go | go 1.27.4 (mise); `go.opentelemetry.io/otel{,/sdk,/sdk/metric,/exporters/otlp/otlpmetric/otlpmetrichttp,/exporters/otlp/otlptrace/otlptracehttp}` v1.47.0; `contrib/instrumentation/net/http/otelhttp` v0.72.0; `contrib/otelconf` v0.27.0 | host, `GOWORK=off go build` |
| Rust | rustc 1.99.1 (`rust:1.99.1-slim-trixie`); `opentelemetry`/`opentelemetry_sdk`/`opentelemetry-otlp` 0.33.1; `opentelemetry-instrumentation-tower` 0.19.0 (`axum` feature); `tracing-opentelemetry` 0.34.0; `axum-tracing-opentelemetry` 0.42.1; axum 0.8.9; reqwest 0.13.5 (`Cargo.lock` committed) | Docker; runtime `debian:trixie-slim` + `ca-certificates` |
| Java | OpenTelemetry Java agent 2.33.1 (SDK 1.67.0 inside); Spring Boot 4.1.2 (`spring-boot-starter-webmvc`, Tomcat); Java 25 (`maven:3.9.16-eclipse-temurin-25`, `eclipse-temurin:25.0.5_8-jre`) | Docker |
| .NET | .NET SDK 10.0.404 / ASP.NET Core runtime 10.0.15; `OpenTelemetry.Extensions.Hosting`, `.Exporter.OpenTelemetryProtocol`, `.Instrumentation.AspNetCore` 1.21.0 | Docker |

Scenarios (`run.sh`):

| Scenario | Setup |
|---|---|
| `s06b-go-code` | §B.3: APM exporters configured from env, UsageMap reader in code with the `onlyHTTPServer` wrapper |
| `s06b-go-code-envhazard` | as above, plus `OTEL_EXPORTER_OTLP_HEADERS=api-key=…,authorization=Bearer%20WRONG` |
| `s06b-go-code-servername[-port]` | `otelhttp.WithServerName("accounts-api")` / `("accounts-api:443")` |
| `s06b-go-otelconf` | `OTEL_CONFIG_FILE=apps/go-nethttp/sdk.yaml` read by `otelconf.NewSDK()`, plus the WRONG env header |
| `s06b-go-otelconf-deprecated-var` | `OTEL_EXPERIMENTAL_CONFIG_FILE` only |
| `s06b-rust-tower` | R1: tower layer, two periodic exporters (metrics), APM span exporter |
| `s06b-rust-tower-envleak` / `-envhazard` | R1 + `OTEL_EXPORTER_OTLP_HEADERS=api-key=…` / `=authorization=Bearer%20WRONG` |
| `s06b-rust-tracing` / `-infofilter` | R3: `tracing` + `axum-tracing-opentelemetry`, two batch span exporters; the second uses `RUST_LOG=info` |
| `s06b-rust-https-default` / `-tlsfeature` / `-tls-no-ca-bundle` | UsageMap at `https://scf-proxy:4443`: default features, then `reqwest-rustls`, then `reqwest-rustls` with an empty `/etc/ssl/certs` |
| `s06b-java-otelconf` | agent + `OTEL_CONFIG_FILE` with two metric readers, plus the WRONG env header |
| `s06b-java-tenantcol` | agent with plain env config → tenant Collector (recipe §A) → APM + UsageMap |
| `s06b-dotnet` / `-envhazard` | three named `AddOtlpExporter`s; the second adds env `api-key` + `authorization=Bearer WRONG` |

## Observations (raw facts, with excerpts of output)

The full generated report is `evidence/report-all.md`. Request counts are the cumulative `count` summed over series;
44 requests were sent in every scenario.

### What arrived at the UsageMap endpoint

| Scenario | Signals at UsageMap | Metric (unit, type, temporality) | Bounds | Requests counted | `http.route` on metric | Unmatched 404 route | `error.type` on 500 |
|---|---|---|---|---|---|---|---|
| go-code | metrics (only the duration metric; wrapper works) | `http.server.request.duration` (s, histogram, cumulative) | 0.005 … 10 (14 semconv) | 44 | yes | absent | **absent** |
| go-otelconf | metrics (all 3 otelhttp metrics: no per-reader filter) | same | same | 44 | yes | absent | absent |
| rust-tower | metrics (duration, `http.server.active_requests`, request/response `body.size`) | same | same | 44 | yes | absent | absent |
| rust-tracing | **spans only** (44 SERVER) | — | — | — | span: yes | **`""` (empty string)** | — |
| rust-tracing-infofilter | **nothing (neither UsageMap nor APM)** | — | — | — | — | — | — |
| java-otelconf | metrics (duration + 12 `jvm.*` + `otel.sdk.*`) | same, scope `io.opentelemetry.tomcat-10.0` | same | 44 | yes | **`/**`** | `500` |
| java-tenantcol | metrics (duration only; recipe §A filter) | same | same | 44 | yes | `/**` | `500` |
| dotnet | metrics (duration, `http.server.active_requests`, `aspnetcore.*`, `kestrel.*`) | same, scope `Microsoft.AspNetCore.Hosting` | same | 44 | yes | absent (+`aspnetcore.request.is_unhandled=true`) | `500` |

- No SDK emitted legacy `http.server.duration`. No SDK emitted an exponential histogram or delta temporality by default.
- On every stack, the matched-route 404 (`/accounts/GNOTFOUND`) kept `http.route=/accounts/{id}`.
- Duration-metric point attributes:
  - Go: `http.request.method, http.response.status_code, http.route, network.protocol.name, network.protocol.version, server.address, server.port, url.scheme`
  - Rust tower: the same without `server.*`
  - Java: `error.type, http.request.method, http.response.status_code, http.route, network.protocol.version, url.scheme`
  - .NET: the Java set + `aspnetcore.request.is_unhandled`

### UsageMap endpoint request log (Authorization and header leakage)

```
| scenario                  | path        | status | Authorization      | api-key hdr | User-Agent                                             | TLS   |
| s06b-go-code-envhazard    | /v1/metrics | 200    | Bearer <UsageMap token> | False       | OTel Go OTLP over HTTP/protobuf metrics exporter/1.43.0 | False |
| s06b-go-otelconf          | /v1/metrics | 200    | Bearer <UsageMap token> | False       | OTel Go OTLP over HTTP/protobuf metrics exporter/1.43.0 | False |
| s06b-rust-tower           | /v1/metrics | 200    | Bearer <UsageMap token> | False       | OTel-OTLP-Exporter-Rust/0.33.1                          | False |
| s06b-rust-tower-envhazard | /v1/metrics | 401    | Bearer WRONG       | False       | OTel-OTLP-Exporter-Rust/0.33.1                          | False |
| s06b-rust-tower-envleak   | /v1/metrics | 200    | Bearer <UsageMap token> | True        | OTel-OTLP-Exporter-Rust/0.33.1                          | False |
| s06b-rust-https-tlsfeature| /v1/metrics | 200    | Bearer <UsageMap token> | False       | OTel-OTLP-Exporter-Rust/0.33.1                          | True  |
| s06b-java-otelconf        | /v1/metrics | 200    | Bearer <UsageMap token> | False       | OTel-OTLP-Exporter-Java/1.67.0                          | False |
| s06b-java-tenantcol       | /v1/metrics | 200    | Bearer <UsageMap token> | False       | OpenTelemetry Collector Contrib/0.165.0 (gzip)          | False |
| s06b-dotnet-envhazard     | /v1/metrics | 200    | Bearer <UsageMap token> | False       | OTel-OTLP-Exporter-Dotnet/1.21.0                        | False |
```

Rust app log for the env hazard (the tenant only sees this if a `tracing` subscriber is installed):
```
WARN  opentelemetry-otlp: name="Export.Failed.NonRetryable" operation="HttpMetricsClient.Export" OTLP export failed with non-retryable error - telemetry data will be lost
ERROR opentelemetry_sdk: name="PeriodicReader.ExportError" error="Operation failed: HTTP export failed with status code: 401"
```
The cause is `opentelemetry-otlp-0.33.1/src/exporter/http/mod.rs` l.278–298: code headers are collected first, then
`add_header_from_string(env)` extends the map, so the env value wins for the same (lower-cased) name. The APM data in the
same run was complete.

### Rust TLS

| Build | Result |
|---|---|
| Default features, https UsageMap endpoint | every export fails with `HttpClient.NetworkError … error sending request for url (https://scf-proxy:4443/v1/metrics)` and nothing arrives. `opentelemetry-otlp` 0.33.1 depends on reqwest with `default-features = false`, and its default features enable no TLS backend. |
| With `features = ["reqwest-rustls"]` | 200 over TLS. |
| With `reqwest-rustls` but no CA bundle in the image (`--tmpfs /etc/ssl/certs`) | the process panics at start-up, while building the **http://** APM exporter: `InternalFailure("failed to build the blocking reqwest HTTP client: builder error")`, exit 101. |

### Rust `tracing` option (R3)

- With `EnvFilter::new("info")`, **no span is exported at all**, silently. `axum-tracing-opentelemetry` 0.42.1 creates its
  span at `TRACE` level on target `otel::tracing` (`tracing-opentelemetry-instrumentation-sdk` `TRACING_LEVEL`, unless
  that crate's feature `tracing_level_info` is enabled). You need `otel::tracing=trace` in the filter.
- SERVER-span attributes at UsageMap:
  - standard: `http.request.method, http.response.status_code, http.route, network.protocol.version, server.address, server.port, url.path, url.query, url.scheme, user_agent.original`
  - non-semconv, added by `tracing-opentelemetry`: `busy_ns, idle_ns, code.file.path, code.line.number, code.module.name, target, thread.id, thread.name, span.type`
- `url.query` arrives **raw** (`cursor=42&email=canary%40example.com`), and `server.address=canary-host.example` comes from
  the Host header. The client IP is **not** recorded by default (`OtelAxumLayer::try_extract_client_ip` defaults to false).

### Personal-data-bearing attributes (canary hits)

| Stack | On metrics | On SERVER spans (APM, or UsageMap for Rust R3) |
|---|---|---|
| Go otelhttp | **`server.address`/`server.port` copied from the Host header** (`canary-host.example`, `8443`) unless `WithServerName("host:port")` is set. With `WithServerName("accounts-api")` (no port) `server.port=8443` still comes from Host. | `client.address=203.0.113.7` **from X-Forwarded-For**, `network.peer.*`, `server.*` (Host), `url.path`, `user_agent.original`; no `url.query`; **no `http.route` attribute** (the route is only in the span name) |
| Rust tower | none | `url.path`, `url.query` raw (only signature keys are redacted), `user_agent.original` |
| Rust tracing | — | see above |
| Java agent | none | `client.address` from XFF, `network.peer.*`, `server.*` from Host, `url.path`, `url.query` raw, `user_agent.original` |
| .NET | `server.address` on `kestrel.*` metrics (the listen address, not Host) | `server.*` from Host, `url.path`, `url.query` **values redacted** (`?cursor=Redacted&email=Redacted`), `user_agent.original`; no client IP |

### Resource attributes at UsageMap

| Setup | `service.instance.id`? | Other resource keys |
|---|---|---|
| Go `resource.Default()` (research recipe) | **no**. It is added only with the experimental `OTEL_GO_X_RESOURCE=true` (`sdk/resource/resource.go` l.256–263). The fixture now uses `resource.WithService()`. | — |
| Rust `Resource::builder()` | **no**. Fixed through `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=…` in `s06b-rust-tower`. | — |
| Java agent, env config | yes | also sends `host.name`, `container.id`, `process.pid`, `process.command_args`, `process.executable.path`, `os.*`, `process.runtime.*` (all on the drop list). Recipe §A's `keep_keys` reduced these to `service.name, service.version, service.instance.id`. |
| Java agent, declarative config | **none of the detectors run by default** (only `service.name`, `telemetry.*`). The fixture adds `detection/development: detectors: [service:]`, and the final run then shows `service.instance.id`. | — |
| Go `otelconf` v0.27.0 | **no**, even with `detection/development: detectors: [service:]`: `otelconf/resource.go` has no detector support and the key is silently ignored. | — |
| .NET `AddService(...)` | yes (automatic) | — |

### Configuration-file route

- **Go `otelconf` v0.27.0:** `otelconf.NewSDK()` with no options reads `OTEL_CONFIG_FILE` itself. `file_format: "1.0"`
  was accepted. The wrong env Authorization was ignored: UsageMap got the file's token. With only
  `OTEL_EXPERIMENTAL_CONFIG_FILE`, start-up fails: `otel setup: OTEL_EXPERIMENTAL_CONFIG_FILE is no longer supported,
  use OTEL_CONFIG_FILE instead`.
- **Java agent 2.33.1 + `OTEL_CONFIG_FILE`:** works. With `file_format: "1.0"` it logs
  `Configuration file_format '1.0' does not exactly match expected version '1.2'`. `"1.2"` is clean. The wrong env
  Authorization was ignored.
- **Views or filters per reader are unavailable in both**, so UsageMap receives every metric (Go 3, Java 14).

### Recipe §A (tenant Collector) on contrib 0.165.0

It works verbatim: filter, transform and gzip. UsageMap received only `http.server.request.duration` with the minimal
resource. The Collector logs `"otlphttp" alias is deprecated; use "otlp_http" instead` for each exporter.

### Other

- **Go exporter User-Agent:** reports `…metrics exporter/1.43.0` although the module is v1.47.0. The `Version()`
  constant in `otlpmetrichttp@v1.47.0/version.go` is stale, so do not infer the SDK version from the UA.
- **Rust `ResourceMetrics`:** its fields are `pub(crate)` in `opentelemetry_sdk` 0.33.1, so a Go-style "forward only one
  metric" exporter wrapper **cannot be written** in Rust.
- **`opentelemetry-instrumentation-tower` 0.19.0 docs are wrong:** its README and lib docs say "With the default `axum`
  feature", but `Cargo.toml` has `default = []`.

## Answer to the question

**Go (otelhttp v0.72.0): works.**
- UsageMap gets the stable metric in s with semconv buckets, cumulative, with `http.route` from `ServeMux` patterns.
- In-SDK dual export has no header hazard: Go replaces env headers.
- `otelconf` + `OTEL_CONFIG_FILE` works, but forwards all metrics.
- Hazards:
  - the metric's `server.address/port` comes from the Host header unless a server name *with port* is pinned;
  - no `service.instance.id` with `resource.Default()`;
  - no `error.type` on 5xx;
  - spans carry `client.address` from X-Forwarded-For and lack an `http.route` attribute.

**Rust: works with R1** (`opentelemetry-instrumentation-tower` 0.19.0 + `axum` feature).
- UsageMap gets the stable metric with `http.route`, and no personal data on metrics.
- R3 (`tracing` + `axum-tracing-opentelemetry`) produces spans only, carrying raw `url.query`, Host and UA. It exports
  **nothing** under a plain `info` filter.
- **Env-header hazard confirmed** both ways:
  - an env `authorization` *replaces* the code token: 401, all UsageMap data lost, a `WARN` line only if a subscriber exists;
  - an env `api-key` (the tenant's APM key) is *added* to the UsageMap request.
- HTTPS needs `reqwest-rustls`, and that in turn needs a CA bundle or the app panics at start-up.

**Java (agent 2.33.1, Spring Boot 4.1.2): works**, either through the agent's declarative config (`file_format "1.2"`)
or through a tenant Collector (recipe §A). The metric comes from the **Tomcat** scope, not Spring. Unmatched requests
get `http.route="/**"`.

**.NET (OpenTelemetry 1.21.0, ASP.NET Core 10): works** with named OTLP exporters. Code headers win over env headers.
UsageMap also receives `aspnetcore.*`/`kestrel.*` metrics.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)

1. **ADR-0009 "Tenant APM-key leak hazard": confirmed for Rust**, in both directions. Go and .NET are confirmed **not**
   affected. The gateway must:
   - treat a non-`scfa_ing_` bearer as 401 without logging the value (as written);
   - strip and never log other headers: the tenant's `api-key` did arrive at the endpoint.

   Onboarding for Rust must say "unset `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_METRICS_HEADERS`" or use the
   tenant Collector.
2. **ADR-0012 / `scfsanitize` path rules:** treat `http.route` values `"/**"` (Spring catch-all) and `""` (Rust
   `axum-tracing-opentelemetry` on unmatched paths) as **no route** (`{unknown}`), exactly like an absent route.
   Add both to the normaliser test vectors.
3. **ADR-0009 allow-list:** confirmed adequate for these four SDKs. Observed point keys outside the keep list, all to
   be dropped:
   - `network.protocol.name` (Go, Rust);
   - `server.address`/`server.port` (Go: from the Host header);
   - `aspnetcore.request.is_unhandled` (.NET; it marks unmatched requests, so it is a useful hint for `{unknown}` before
     it is dropped).

   On span-derived input (Rust R3): `code.*`, `thread.*`, `busy_ns`, `idle_ns`, `target`, `span.type`.
4. **C-22 / ADR-0010 cumulative streams keyed on `service.instance.id`:** the attribute is **missing by default** in Go
   (`resource.Default()` and `otelconf`), Rust and the Java agent's declarative mode. Two replicas without it would merge into one
   cumulative stream and corrupt deltas. Two changes:
   - (a) onboarding requires it (recipes below set it);
   - (b) the writer needs a fallback stream identity when it is absent. Suggested: `start_time_unix_nano` of the data
     point, plus the resource attribute set and the scope. Flag such services in the UI.
5. **C-22 scope priority list** must name the scopes actually observed:
   - `io.opentelemetry.tomcat-10.0` (Java agent records server metrics at the servlet-container scope, version
     `2.33.1-alpha`);
   - `Microsoft.AspNetCore.Hosting`;
   - `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp`;
   - `opentelemetry-instrumentation-tower`.

   Match on name prefix, without version: Java scope versions carry `-alpha`.
6. **ADR-0009 signal handling:** `error.type` is absent on Go and Rust 5xx metrics, so derive errors from
   `http.response.status_code ≥ 500`, not from `error.type`.
7. **Ingest bucket check (findings §3.3 "bucket hazard"):** all four stacks send the 14 semconv bounds in seconds, so no
   low-resolution series came up in the spike. The check stays as a guard for custom metrics.
8. **The dual-export recipe research** must be corrected as listed in "Recipe corrections" below.
   The quickstarts below replace §B.3, §B.4, §B.5 (agent part) and §B.6.

### Recipe corrections versus the research file

| # | Section | Research said | Observed / correct |
|---|---|---|---|
| 1 | §A | `otlphttp/…` exporters | Works, but deprecated in contrib 0.165: use `otlp_http/apm`, `otlp_http/scf`. |
| 2 | §B.3 Go | `resource.Default()`; `otelhttp.NewHandler(mux, "api")`; findings §3.3: `server.address` "only from the configured server name, not the Host header" | `resource.Default()` has no `service.instance.id`: use `resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK())`. otelhttp falls back to `req.Host`, so pass `otelhttp.WithServerName("<host>:<port>")`. The port part matters. |
| 3 | §B.3 Go | (implicit) spans carry `http.route` | otelhttp spans have the route only in the span name; prefer metrics for Go. |
| 4 | §B.4 Rust | default `opentelemetry-otlp` features suffice | No TLS by default: add `features = ["reqwest-rustls"]`, and ship `ca-certificates` in the image or the exporter builder panics. |
| 5 | §B.4 Rust | "custom `PushMetricExporter` wrapper (not sketched)" to send only the HTTP metric | Impossible in 0.33.1 (`ResourceMetrics` fields `pub(crate)`). Send all tower metrics (4, no personal data) or use the tenant Collector. |
| 6 | §B.4 Rust | no `service.instance.id` mention | Not detected: set `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<pod/host name>`. |
| 7 | §B.4 Rust R3 | "this crate records the client IP as `http.client.address`" | Off by default (`try_extract_client_ip(false)`; when enabled it writes `client.address`). The real traps: spans are TRACE level (set `otel::tracing=trace`, or nothing is exported); `url.query` is raw; `server.address` comes from Host. |
| 8 | §B.5 Java / §C | agent supports file format "1.0.0-rc.3" | Agent 2.33.1 expects `file_format: "1.2"` ("1.0" works with a warning). Declarative mode runs no resource detectors: add `detection/development.detectors: [service:]`. Env OTLP headers are ignored when the file is used (verified). |
| 9 | §C Go | `OTEL_EXPERIMENTAL_CONFIG_FILE` "now errors" | Confirmed: `NewSDK` returns the error and the app's start-up fails. `NewSDK()` reads `OTEL_CONFIG_FILE` itself; `ParseYAML` is unnecessary. |
| — | §B.6 .NET | "LIKELY" pattern | Verified as written. Use a distinct name per `AddOtlpExporter` call (the fixture uses `apm-traces`, `apm-metrics`, `scf`). Code `Headers` overrides env headers (verified). UsageMap additionally receives `aspnetcore.*`/`kestrel.*` metrics. |
| — | §B.6 / findings §3.4 | ".NET: AddOtlpExporter twice with named options (LIKELY)" | VERIFIED. |

## Values the implementation must use (env vars, headers, config keys, flags, limits)

Onboarding quickstarts (tested in this spike). Replace `https://ingest.scf.example` and the token.

**Go 1.22+ `net/http`.** `go.opentelemetry.io/otel` v1.47.0 (`sdk`, `sdk/metric`, `exporters/otlp/otlpmetric/otlpmetrichttp`), `contrib/instrumentation/net/http/otelhttp` v0.72.0.
```go
res, _ := resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK()) // service.instance.id
apm, _ := otlpmetrichttp.New(ctx) // your APM, from OTEL_EXPORTER_OTLP_* env (Go does not leak env headers into WithHeaders)
scf, _ := otlpmetrichttp.New(ctx,
    otlpmetrichttp.WithEndpointURL("https://ingest.scf.example/v1/metrics"),
    otlpmetrichttp.WithHeaders(map[string]string{"Authorization": "Bearer " + os.Getenv("SCF_OTLP_TOKEN")}))
mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
    sdkmetric.WithReader(sdkmetric.NewPeriodicReader(apm)),
    sdkmetric.WithReader(sdkmetric.NewPeriodicReader(onlyHTTPServer{scf}))) // wrapper: apps/go-nethttp/main.go
otel.SetMeterProvider(mp); defer mp.Shutdown(context.Background())
mux := http.NewServeMux()
mux.HandleFunc("GET /accounts/{id}", getAccount) // pattern => http.route
http.ListenAndServe(":8080", otelhttp.NewHandler(mux, "api", otelhttp.WithServerName("api.example.com:443")))
```

**Go, no-code alternative.** `contrib/otelconf` v0.27.0, `s, err := otelconf.NewSDK()` with `OTEL_CONFIG_FILE=sdk.yaml`.
See `apps/go-nethttp/sdk.yaml`: `file_format: "1.0"`, two `meter_provider.readers[].periodic.exporter.otlp_http`
blocks, Never set `OTEL_EXPERIMENTAL_CONFIG_FILE`. otelconf v0.27.0 ignores `detection/development`, so add
`service.instance.id` as an explicit `resource.attributes` entry (for example `${HOSTNAME}`; not run in this spike).

**Rust axum 0.8.** Metrics with `http.route`.
```toml
opentelemetry = "0.33.1"
opentelemetry_sdk = "0.33.1"
opentelemetry-otlp = { version = "0.33.1", features = ["reqwest-rustls"] }   # without it: no https
opentelemetry-instrumentation-tower = { version = "0.19.0", features = ["axum"] }   # 'axum' is NOT default
tracing-subscriber = { version = "0.3", features = ["env-filter"] }         # to see export errors
```
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
Runtime requirements for Rust:
- **Unset** `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS`: they override the UsageMap token and leak
  your APM key. Configure the APM headers in code, or use the tenant Collector.
- Set `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<unique per replica>`.
- The image needs `ca-certificates`.

If you must use the `tracing` stack (spans only):
- add `otel::tracing=trace` to the `EnvFilter`;
- prefer the tenant Collector with the SERVER-span filter.

**Java (any Spring MVC/WebFlux/JAX-RS app).** Java agent 2.33.1:
`java -javaagent:opentelemetry-javaagent.jar -jar app.jar` with `OTEL_CONFIG_FILE=/etc/otel/sdk.yaml`. See
`apps/java-spring/otel/sdk.yaml`: `file_format: "1.2"`, two periodic `otlp_http` readers (the second with
`Authorization: Bearer ${SCF_OTLP_TOKEN}`), and `detection/development.detectors: [service:]`. Alternative: the agent's
normal env config pointed at a tenant Collector with recipe §A (`collector/tenant-fanout.yaml`, exporters renamed to
`otlp_http`).

**.NET 8+ (tested on 10).** `OpenTelemetry.Extensions.Hosting`, `OpenTelemetry.Exporter.OpenTelemetryProtocol` and
`OpenTelemetry.Instrumentation.AspNetCore` 1.21.0.
```csharp
builder.Services.AddOpenTelemetry()
  .ConfigureResource(r => r.AddService("my-api"))          // adds service.instance.id
  .WithMetrics(m => m.AddAspNetCoreInstrumentation()
    .AddOtlpExporter("apm-metrics", o => { o.Endpoint = new Uri("https://apm.example/v1/metrics"); o.Protocol = OtlpExportProtocol.HttpProtobuf; o.Headers = "api-key=" + apmKey; })
    .AddOtlpExporter("scf", o => { o.Endpoint = new Uri("https://ingest.scf.example/v1/metrics"); o.Protocol = OtlpExportProtocol.HttpProtobuf; o.Headers = "Authorization=Bearer " + scfToken; }));
```

**Ingest side (UsageMap):**
- Expect, per request, only `http.server.request.duration`, unit `s`, explicit bounds
  `[0.005,0.01,0.025,0.05,0.075,0.1,0.25,0.5,0.75,1,2.5,5,7.5,10]`, cumulative (`aggregationTemporality=2`), from
  scopes `otelhttp`, `opentelemetry-instrumentation-tower`, `io.opentelemetry.tomcat-*`/other Java agent scopes, and
  `Microsoft.AspNetCore.Hosting`.
- Treat `http.route ∈ {absent, "", "/**"}` as unmatched.
- Derive errors from status ≥ 500.
- Exporter User-Agents seen: `OTel Go OTLP over HTTP/protobuf metrics exporter/<v>`, `OTel-OTLP-Exporter-Rust/<v>`,
  `OTel-OTLP-Exporter-Java/<v>`, `OTel-OTLP-Exporter-Dotnet/<v>`, `OpenTelemetry Collector Contrib/<v>`. These are
  informational only (the Go one is stale).

## Open issues

1. **Java agent extension** (`AutoConfigurationCustomizerProvider` adding a second reader, §B.5) was **not tested**.
   Declarative config and the tenant Collector cover the Java case.
2. **gRPC, and OTLP/HTTP JSON**, were not tested: all exporters used OTLP/HTTP protobuf. The .NET default protocol is
   gRPC, so the recipe sets `HttpProtobuf` explicitly.
3. **Logs:** the Java agent exports logs by default. If a tenant points the agent's single env endpoint at UsageMap, it will
   get 404 on `/v1/logs` (verified with curl against the test collector only, not with the agent).
4. **Untested frameworks:** Go gin/chi, Rust actix-web (§B.4 R2), Spring WebFlux and .NET controllers.
5. **Rust shutdown from async context:** wrapped in `spawn_blocking` as a precaution. Calling `shutdown()` directly on
   a Tokio worker was not tested.
6. **Go `otelconf` explicit `service.instance.id` attribute** (the workaround for the ignored detector) was not run.
7. **The `service.instance.id` fallback** for streams without it (Consequence 4) needs a design decision.
