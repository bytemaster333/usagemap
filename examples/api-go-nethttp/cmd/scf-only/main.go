// SPDX-License-Identifier: Apache-2.0

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
