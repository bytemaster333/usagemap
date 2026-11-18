# API: Go `net/http` (in-SDK dual export)

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: — the same recipe, in the sample service `tests/fixtures/api/go-nethttp/`, dual-exports to the gateway's OTLP front door in the end-to-end suite `tests/e2e/api/30-api.e2e.test.ts` (exact request counts asserted). Source: `spikes/s06b-dual-export-go-rust-jvm-dotnet/README.md`
("Go 1.22+ `net/http`", app `apps/go-nethttp/main.go`, `sdk.yaml`). Read [api-common.md](api-common.md) first.

Measured: UsageMap received only `http.server.request.duration` (s, 14 explicit bounds, cumulative) with `http.route` from
`ServeMux` patterns. Go does **not** merge environment headers into an exporter configured with `WithHeaders` (the
wrong env `Authorization` was ignored).

## Modules (as tested)

`go.opentelemetry.io/otel` v1.47.0 (`sdk`, `sdk/metric`, `exporters/otlp/otlpmetric/otlpmetrichttp`,
`exporters/otlp/otlptrace/otlptracehttp`), `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` v0.72.0;
Go 1.27.4.

## Setup

```go
res, _ := resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK()) // service.instance.id
apm, _ := otlpmetrichttp.New(ctx) // your APM, from OTEL_EXPORTER_OTLP_* env (Go does not leak env headers into WithHeaders)
scf, _ := otlpmetrichttp.New(ctx,
    otlpmetrichttp.WithEndpointURL("https://ingest.scf.example/v1/metrics"),
    otlpmetrichttp.WithHeaders(map[string]string{"Authorization": "Bearer " + os.Getenv("SCF_OTLP_TOKEN")}))
mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
    sdkmetric.WithReader(sdkmetric.NewPeriodicReader(apm)),
    sdkmetric.WithReader(sdkmetric.NewPeriodicReader(onlyHTTPServer{scf})))
otel.SetMeterProvider(mp); defer mp.Shutdown(context.Background())
mux := http.NewServeMux()
mux.HandleFunc("GET /accounts/{id}", getAccount) // pattern => http.route
http.ListenAndServe(":8080", otelhttp.NewHandler(mux, "api", otelhttp.WithServerName("api.example.com:443")))
```

The filtering wrapper (from the spike's `main.go`):

```go
// onlyHTTPServer forwards only the HTTP server duration metric to UsageMap.
type onlyHTTPServer struct{ sdkmetric.Exporter }

func (e onlyHTTPServer) Export(ctx context.Context, rm *metricdata.ResourceMetrics) error {
	out := metricdata.ResourceMetrics{Resource: rm.Resource}
	for _, sm := range rm.ScopeMetrics {
		var keep []metricdata.Metrics
		for _, m := range sm.Metrics {
			if m.Name == "http.server.request.duration" {
				keep = append(keep, m)
			}
		}
		if len(keep) > 0 {
			sm.Metrics = keep
			out.ScopeMetrics = append(out.ScopeMetrics, sm)
		}
	}
	if len(out.ScopeMetrics) == 0 {
		return nil
	}
	return e.Exporter.Export(ctx, &out)
}
```

## Pitfalls the spike hit

1. **`resource.Default()` has no `service.instance.id`** (only with the experimental `OTEL_GO_X_RESOURCE=true`). Use
   `resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK())` — `WithFromEnv` after
   `WithService` so `OTEL_SERVICE_NAME` wins.
2. **`server.address` / `server.port` are copied from the request's `Host` header** unless you pin
   `otelhttp.WithServerName("<host>:<port>")` — **with the port**; without it the port still comes from `Host`. The
   platform drops both attributes, but pin them anyway.
3. No `error.type` on 5xx — the platform derives errors from the status code.
4. otelhttp spans carry the route only in the span name and `client.address` from `X-Forwarded-For`: prefer the metric
   for Go, and keep spans to your APM.
5. The exporter's User-Agent reports `…/1.43.0` although the module is v1.47.0 (stale constant upstream).

## No-code alternative: `otelconf` and `OTEL_CONFIG_FILE`

`otelconf.NewSDK()` (contrib `otelconf` v0.27.0) reads `OTEL_CONFIG_FILE` itself; two `meter_provider.readers` with
`otlp_http` exporters work, and the env `Authorization` is ignored. Limits measured: **no per-reader filter**, so UsageMap
receives all three otelhttp metrics (the platform keeps only the duration); `detection/development` is silently
ignored, so set `service.instance.id` as an explicit `resource.attributes` entry (that workaround was **not run** in the
spike); `OTEL_EXPERIMENTAL_CONFIG_FILE` makes start-up fail. Example: `apps/go-nethttp/sdk.yaml` in the spike.
