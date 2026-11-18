// SPDX-License-Identifier: Apache-2.0

// Dual export: your APM keeps its export (configured from the standard OTEL_EXPORTER_OTLP_* environment, as before);
// a second reader sends only the HTTP server duration metric to UsageMap, with the UsageMap endpoint and token set in code.
// Go does not merge environment headers into an exporter configured WithHeaders.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
)

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

	res, err := resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK())
	if err != nil {
		log.Fatal(err)
	}
	apm, err := otlpmetrichttp.New(ctx) // your APM, from OTEL_EXPORTER_OTLP_* as before
	if err != nil {
		log.Fatal(err)
	}
	scf, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(os.Getenv("SCF_OTLP_ENDPOINT")+"/v1/metrics"),
		otlpmetrichttp.WithHeaders(map[string]string{"Authorization": "Bearer " + os.Getenv("SCF_OTLP_TOKEN")}))
	if err != nil {
		log.Fatal(err)
	}
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(apm)),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(onlyHTTPServer{scf})))
	otel.SetMeterProvider(mp)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /accounts/{id}", getAccount) // the pattern becomes http.route
	srv := &http.Server{
		Addr:    ":" + envOr("PORT", "8080"),
		Handler: otelhttp.NewHandler(mux, "api", otelhttp.WithServerName("api.example.org:443")),
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	_ = srv.Shutdown(context.Background())
	_ = mp.Shutdown(context.Background()) // flushes the last interval of both readers
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
