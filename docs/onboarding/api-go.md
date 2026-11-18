# Go `net/http` API: the first 10 minutes

**UsageMap-only, configured by environment variables.** Go has no zero-code agent, so a few lines set up the meter
provider; the exporter itself (`autoexport`) reads the endpoint, protocol and token from the environment. Already have
an APM? See [dual export](api-dual-export.md).

**Tested:** the program below is the example service `examples/api-go-nethttp` (Go 1.27.4). The repository's backend
suite runs it with the environment of step 3 against a local stand-in of the UsageMap endpoint: requests with three
status codes on `/accounts/{id}`, then `SIGTERM`. UsageMap received `http.server.request.duration` with `http.route`, the
status code and the duration, counts equal to what the app answered; no client address, user agent or query string
anywhere in the payload.

| Minute | Step |
|---|---|
| 0–2 | Portal: **Add an API**, then **Ingest tokens** → create a token |
| 2–4 | `go get` three modules |
| 4–7 | Add the setup below to `main` |
| 7–10 | Run with the environment below; the API wizard shows data after one export interval (60 s) |

## 1. Modules

```sh
go get go.opentelemetry.io/otel@v1.47.0 go.opentelemetry.io/otel/sdk/metric@v1.47.0 \
  go.opentelemetry.io/contrib/exporters/autoexport@v0.72.0 \
  go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp@v0.72.0
```

`otel` v1.47.0 and `otelhttp` v0.72.0 are the versions our test suite runs; `autoexport` v0.72.0 is from the same
release (current on the Go module proxy on 2026-11-16).

## 2. Setup

The whole `main.go` of the example service [`examples/api-go-nethttp`](../../examples/api-go-nethttp/cmd/scf-only/main.go):

```go
// UsageMap only: the exporter (autoexport) reads endpoint, protocol and token from OTEL_EXPORTER_OTLP_* in the environment.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"go.opentelemetry.io/contrib/exporters/autoexport"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
)

func getAccount(w http.ResponseWriter, r *http.Request) {
	switch r.PathValue("id") {
	case "GMISSING":
		http.Error(w, `{"error":"account not found"}`, http.StatusNotFound)
	case "GBOOM":
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
	default:
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"` + r.PathValue("id") + `"}`))
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// OTEL_METRICS_EXPORTER, OTEL_EXPORTER_OTLP_ENDPOINT, _HEADERS and _PROTOCOL come from the environment.
	reader, err := autoexport.NewMetricReader(ctx)
	if err != nil {
		log.Fatal(err)
	}
	// WithFromEnv after WithService, so OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win.
	res, err := resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK())
	if err != nil {
		log.Fatal(err)
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader), sdkmetric.WithResource(res))
	otel.SetMeterProvider(mp)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /accounts/{id}", getAccount) // the pattern becomes http.route
	srv := &http.Server{
		Addr: ":" + envOr("PORT", "8080"),
		// WithServerName (with the port) stops server.address from being copied from the Host header.
		Handler: otelhttp.NewHandler(mux, "api", otelhttp.WithServerName("api.example.org:443")),
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	_ = srv.Shutdown(context.Background())
	_ = mp.Shutdown(context.Background()) // flushes the last interval
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
```

- Use Go 1.22+ `ServeMux` patterns (or a router that sets the pattern) so that each request carries its route.
- `WithServerName` with the port stops `server.address` from being copied from the request's `Host` header. The
  platform drops it anyway; pin it so it never leaves your process.
- `mp.Shutdown` runs after `SIGTERM` (`signal.NotifyContext`, then `http.Server.Shutdown`) so the last interval is
  not lost on deploys; measured, the only export of a short run arrived on shutdown.

## 3. Environment

```sh
OTEL_SERVICE_NAME=my-api
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.scf.example
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_...
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_METRICS_EXPORTER=otlp
OTEL_RESOURCE_ATTRIBUTES=service.instance.id=api-1
```

`service.instance.id` is missing by default in Go; give each replica its own value. The token's space is written
`%20`.

## 4. Check it

The API wizard shows requests per route, status codes and latency after a minute. otelhttp also emits request and
response size metrics; UsageMap drops them before storage (the data-quality table lists them). Nothing arrives? See
[troubleshooting](troubleshooting.md#api-opentelemetry).

## Where this comes from

- `autoexport` v0.72.0 documentation (pkg.go.dev, read 2026-11-16): `NewMetricReader` selects the exporter from
  `OTEL_METRICS_EXPORTER` (default `otlp`) and the protocol from `OTEL_EXPORTER_OTLP_PROTOCOL` (default
  `http/protobuf`).
- OpenTelemetry specification, OTLP exporter configuration (read 2026-11-16).
- The program, the resource set-up, `WithServerName`, the routes and the shutdown flush are run with `otel` v1.47.0 /
  `otelhttp` v0.72.0 / `autoexport` v0.72.0 by our test suite (`examples/api-go-nethttp`).
