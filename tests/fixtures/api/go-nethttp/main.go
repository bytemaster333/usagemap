// SPDX-License-Identifier: Apache-2.0
// S-06b Go sample API: net/http ServeMux + otelhttp, dual export.
//
//	OTEL_SETUP=code      programmatic: APM exporters from OTEL_EXPORTER_OTLP_* env, UsageMap metric reader in code
//	OTEL_SETUP=otelconf  declarative: otelconf.NewSDK() reads the file named by OTEL_CONFIG_FILE
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/contrib/otelconf"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// ---- recipe: forward only the HTTP server duration metric to UsageMap ----

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

func setupCode(ctx context.Context) (func(context.Context) error, error) {
	// WithService adds a random service.instance.id (resource.Default() does so only with OTEL_GO_X_RESOURCE=true);
	// WithFromEnv comes after it so OTEL_SERVICE_NAME wins over the "unknown_service" default.
	res, err := resource.New(ctx, resource.WithService(), resource.WithFromEnv(), resource.WithTelemetrySDK())
	if err != nil {
		return nil, err
	}
	// Tenant APM: configured entirely by OTEL_EXPORTER_OTLP_* env vars (endpoint + headers).
	apmTraces, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	apmMetrics, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, err
	}
	// UsageMap: endpoint and header in code. WithHeaders replaces (does not merge) env headers.
	scfMetrics, err := otlpmetrichttp.New(ctx,
		otlpmetrichttp.WithEndpointURL(os.Getenv("SCF_OTLP_ENDPOINT")+"/v1/metrics"),
		otlpmetrichttp.WithHeaders(map[string]string{"Authorization": "Bearer " + os.Getenv("SCF_OTLP_TOKEN")}),
	)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(apmTraces))
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(apmMetrics)),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(onlyHTTPServer{scfMetrics})),
	)
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return func(ctx context.Context) error { return errors.Join(mp.Shutdown(ctx), tp.Shutdown(ctx)) }, nil
}

func setupOtelconf(context.Context) (func(context.Context) error, error) {
	sdk, err := otelconf.NewSDK() // reads OTEL_CONFIG_FILE
	if err != nil {
		return nil, err
	}
	otel.SetTracerProvider(sdk.TracerProvider())
	otel.SetMeterProvider(sdk.MeterProvider())
	otel.SetTextMapPropagator(sdk.Propagator())
	return sdk.Shutdown, nil
}

// ---- sample API ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("GET /accounts/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "GNOTFOUND" {
			writeJSON(w, 404, map[string]string{"error": "account not found"})
			return
		}
		writeJSON(w, 200, map[string]any{"id": id, "balance": "100.0000000"})
	})
	mux.HandleFunc("GET /assets/{code}/{issuer}", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(15 * time.Millisecond)
		writeJSON(w, 200, map[string]string{"code": r.PathValue("code"), "issuer": r.PathValue("issuer")})
	})
	mux.HandleFunc("POST /payments", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 400, map[string]string{"error": "invalid payment"}) })
	mux.HandleFunc("GET /boom", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 500, map[string]string{"error": "internal"}) })
	return mux
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	setup := setupCode
	if os.Getenv("OTEL_SETUP") == "otelconf" {
		setup = setupOtelconf
	}
	shutdown, err := setup(ctx)
	if err != nil {
		log.Fatalf("otel setup: %v", err)
	}
	addr := os.Getenv("LISTEN")
	if addr == "" {
		addr = "127.0.0.1:18640"
	}
	var hopts []otelhttp.Option
	if sn := os.Getenv("HTTP_SERVER_NAME"); sn != "" {
		// Pins server.address on the metric; otherwise otelhttp copies it from the request Host header.
		hopts = append(hopts, otelhttp.WithServerName(sn))
	}
	srv := &http.Server{Addr: addr, Handler: otelhttp.NewHandler(routes(), "api", hopts...)}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()
	log.Printf("listening on %s (setup=%s)", addr, os.Getenv("OTEL_SETUP"))
	<-ctx.Done()
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(sctx)
	if err := shutdown(sctx); err != nil {
		log.Printf("otel shutdown: %v", err)
	}
}
