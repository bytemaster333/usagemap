// SPDX-License-Identifier: Apache-2.0
// sendtest drives the S-04 experiments. It plays the role of the gateway
// (adds the x-scf-* metadata a gateway would add, wire-formats §f.4) in front
// of tenant SDK traffic.
//
//	sendtest logs           -http H:P -grpc H:P        /v1/logs over HTTP (pb+JSON) and gRPC
//	sendtest spans   -proto http|grpc -http/-grpc ...  real Go SDK spans (see scenario below)
//	sendtest metrics -proto http|grpc ...              real Go SDK metrics
//	sendtest burst   -n N -prefix P -http H:P          N single-point metric requests (pdata)
//	sendtest notenant -http H:P                        metric request without x-scf-tenant-id
package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

var (
	httpAddr = flag.String("http", "127.0.0.1:18418", "collector OTLP/HTTP host:port")
	grpcAddr = flag.String("grpc", "127.0.0.1:18417", "collector OTLP/gRPC host:port")
	proto    = flag.String("proto", "http", "http or grpc (spans, metrics)")
	tenant   = flag.String("tenant", "11111111-2222-4333-8444-555555555555", "x-scf-tenant-id")
	allowed  = flag.String("allowed", "checkout,orders%2Fapi", "x-scf-allowed-services")
	n        = flag.Int("n", 100, "burst: number of requests")
	prefix   = flag.String("prefix", "run", "burst: route prefix")
)

func gw() map[string]string {
	return map[string]string{
		"x-scf-tenant-id":        *tenant,
		"x-scf-token-id":         "tok_s04",
		"x-scf-allowed-services": *allowed,
		"x-scf-tenant-level":     "2",
		"x-scf-received-at":      fmt.Sprint(time.Now().UnixNano()),
		"x-scf-node":             "edge-s04",
	}
}

func main() {
	flag.CommandLine.Parse(os.Args[2:])
	ctx := context.Background()
	switch os.Args[1] {
	case "logs":
		logs(ctx)
	case "spans":
		spans(ctx)
	case "metrics":
		metrics(ctx)
	case "burst":
		burst()
	case "notenant":
		fmt.Println("HTTP /v1/metrics without x-scf-tenant-id ->", post("/v1/metrics", onePoint("notenant", 0), map[string]string{}, "application/x-protobuf"))
	default:
		log.Fatalf("unknown command %q", os.Args[1])
	}
}

// ---------------------------------------------------------------- logs

func logs(ctx context.Context) {
	ld := plog.NewLogs()
	lr := ld.ResourceLogs().AppendEmpty()
	lr.Resource().Attributes().PutStr("service.name", "checkout")
	lr.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty().Body().SetStr("CANARY-LOG-7f3a")
	req := plogotlp.NewExportRequestFromLogs(ld)
	pb, _ := req.MarshalProto()
	js, _ := req.MarshalJSON()
	fmt.Println("HTTP protobuf /v1/logs ->", post("/v1/logs", pb, gw(), "application/x-protobuf"))
	fmt.Println("HTTP JSON     /v1/logs ->", post("/v1/logs", js, gw(), "application/json"))

	conn, err := grpc.NewClient(*grpcAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()
	md := metadata.New(gw())
	_, err = plogotlp.NewGRPCClient(conn).Export(metadata.NewOutgoingContext(ctx, md), req)
	st, _ := status.FromError(err)
	fmt.Printf("gRPC LogsService/Export -> code=%s msg=%q\n", st.Code(), st.Message())

	// The real Go SDK log exporters (retry enabled by default): how long until they give up?
	for _, p := range []string{"http", "grpc"} {
		var exp sdklog.Exporter
		if p == "http" {
			exp, err = otlploghttp.New(ctx, otlploghttp.WithEndpoint(*httpAddr), otlploghttp.WithInsecure(), otlploghttp.WithHeaders(gw()))
		} else {
			exp, err = otlploggrpc.New(ctx, otlploggrpc.WithEndpoint(*grpcAddr), otlploggrpc.WithInsecure(), otlploggrpc.WithHeaders(gw()))
		}
		must(err)
		var rec sdklog.Record
		rec.SetBody(attribute.StringValue("CANARY-LOG-7f3a"))
		t := time.Now()
		err = exp.Export(ctx, []sdklog.Record{rec})
		fmt.Printf("Go SDK otlplog%s Export -> after %v: %v\n", p, time.Since(t).Round(time.Millisecond), err)
	}
}

func post(path string, body []byte, hdr map[string]string, ct string) string {
	r, _ := http.NewRequest("POST", "http://"+*httpAddr+path, bytes.NewReader(body))
	r.Header.Set("Content-Type", ct)
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		return "error: " + err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return fmt.Sprintf("%d %q", resp.StatusCode, truncate(string(b), 120))
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// ---------------------------------------------------------------- spans

func traceProvider(ctx context.Context, service string) *sdktrace.TracerProvider {
	var exp sdktrace.SpanExporter
	var err error
	if *proto == "grpc" {
		exp, err = otlptracegrpc.New(ctx, otlptracegrpc.WithEndpoint(*grpcAddr), otlptracegrpc.WithInsecure(), otlptracegrpc.WithHeaders(gw()))
	} else {
		exp, err = otlptracehttp.New(ctx, otlptracehttp.WithEndpoint(*httpAddr), otlptracehttp.WithInsecure(), otlptracehttp.WithHeaders(gw()))
	}
	if err != nil {
		log.Fatal(err)
	}
	res := resource.NewSchemaless(
		attribute.String("service.name", service),
		attribute.String("service.instance.id", "inst-1"),
		attribute.String("deployment.environment.name", "prod"),
		attribute.String("host.name", "CANARY-HOST-9b1c"),
		attribute.String("tenant.id", "FORGED-TENANT"),
		attribute.String("scf.tenant.id", "FORGED-TENANT"),
	)
	return sdktrace.NewTracerProvider(sdktrace.WithSyncer(exp), sdktrace.WithResource(res), sdktrace.WithSampler(sdktrace.AlwaysSample()))
}

func remoteParent(ts string) context.Context {
	tid, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	sid, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	st, _ := trace.ParseTraceState(ts)
	sc := trace.NewSpanContext(trace.SpanContextConfig{TraceID: tid, SpanID: sid, TraceFlags: trace.FlagsSampled, TraceState: st, Remote: true})
	return trace.ContextWithRemoteSpanContext(context.Background(), sc)
}

// Scenario (expected after filter, with remote-parent filtering):
//
//	S1 SERVER, remote parent, route /users/{id}, 120 ms, 200 GET   -> counted
//	S2 SERVER, local parent S1, route /internal/nested, 50 ms       -> dropped (nested)
//	S3 CLIENT, local parent S1                                      -> dropped (kind)
//	S4 INTERNAL, local parent S1                                    -> dropped (kind)
//	S5 SERVER, no parent, url.path /orders/7 only, 300 ms, 500 POST -> counted, scf.route=/orders/7
//	S6 SERVER, no parent, no route/path, 10 ms                      -> counted, scf.route={unknown}
//	S7 SERVER, remote parent with tracestate ot=th:c, route /sampled, 40 ms -> counted ×4 (AdjustedCount)
//	S8 SERVER, root, service.name "forbidden-svc"                   -> dropped by scfsanitize (C-70)
func spans(ctx context.Context) {
	tp := traceProvider(ctx, "checkout")
	tr := tp.Tracer("s04/sendtest")
	t0 := time.Now().Add(-2 * time.Second)
	at := func(ms int) trace.SpanStartEventOption { return trace.WithTimestamp(t0.Add(time.Duration(ms) * time.Millisecond)) }
	end := func(ms int) trace.SpanEndOption { return trace.WithTimestamp(t0.Add(time.Duration(ms) * time.Millisecond)) }
	pii := []attribute.KeyValue{
		attribute.String("client.address", "203.0.113.77"),
		attribute.String("user_agent.original", "CANARY-UA-55aa"),
		attribute.String("url.query", "token=CANARY-QUERY-1234"),
		attribute.String("enduser.id", "CANARY-USER"),
	}

	c1, s1 := tr.Start(remoteParent(""), "GET /users/{id}", trace.WithSpanKind(trace.SpanKindServer), at(0),
		trace.WithAttributes(append(pii, attribute.String("http.route", "/users/{id}"), attribute.String("url.path", "/users/42"),
			attribute.String("http.request.method", "GET"), attribute.Int("http.response.status_code", 200))...))
	s1.AddEvent("CANARY-EVENT")
	_, s2 := tr.Start(c1, "GET /internal/nested", trace.WithSpanKind(trace.SpanKindServer), at(10),
		trace.WithAttributes(attribute.String("http.route", "/internal/nested"), attribute.String("http.request.method", "GET"), attribute.Int("http.response.status_code", 200)))
	s2.End(end(60))
	_, s3 := tr.Start(c1, "GET horizon", trace.WithSpanKind(trace.SpanKindClient), at(61),
		trace.WithAttributes(attribute.String("url.full", "https://horizon.example/accounts/x"), attribute.String("http.request.method", "GET")))
	s3.End(end(100))
	_, s4 := tr.Start(c1, "render", trace.WithSpanKind(trace.SpanKindInternal), at(100))
	s4.End(end(110))
	s1.End(end(120))

	_, s5 := tr.Start(context.Background(), "POST", trace.WithSpanKind(trace.SpanKindServer), at(200),
		trace.WithAttributes(attribute.String("url.path", "/orders/7"), attribute.String("http.request.method", "POST"), attribute.Int("http.response.status_code", 500)))
	s5.End(end(500))
	_, s6 := tr.Start(context.Background(), "op", trace.WithSpanKind(trace.SpanKindServer), at(600))
	s6.End(end(610))
	_, s7 := tr.Start(remoteParent("ot=th:c"), "GET /sampled", trace.WithSpanKind(trace.SpanKindServer), at(700),
		trace.WithAttributes(attribute.String("http.route", "/sampled"), attribute.String("http.request.method", "GET"), attribute.Int("http.response.status_code", 200)))
	s7.End(end(740))
	must(tp.Shutdown(ctx))

	tp2 := traceProvider(ctx, "forbidden-svc")
	_, s8 := tp2.Tracer("s04/sendtest").Start(context.Background(), "GET /x", trace.WithSpanKind(trace.SpanKindServer), at(800),
		trace.WithAttributes(attribute.String("http.route", "/x")))
	s8.End(end(900))
	must(tp2.Shutdown(ctx))
	fmt.Println("spans sent via", *proto)
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

// ---------------------------------------------------------------- metrics

func metrics(ctx context.Context) {
	var exp sdkmetric.Exporter
	var err error
	if *proto == "grpc" {
		exp, err = otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithEndpoint(*grpcAddr), otlpmetricgrpc.WithInsecure(), otlpmetricgrpc.WithHeaders(gw()))
	} else {
		exp, err = otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpoint(*httpAddr), otlpmetrichttp.WithInsecure(), otlpmetrichttp.WithHeaders(gw()))
	}
	must(err)
	res := resource.NewSchemaless(attribute.String("service.name", "checkout"), attribute.String("service.instance.id", "inst-1"),
		attribute.String("host.name", "CANARY-HOST-9b1c"), attribute.String("tenant.id", "FORGED-TENANT"))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp, sdkmetric.WithInterval(time.Hour))))
	m := mp.Meter("go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp")
	srv, _ := m.Float64Histogram("http.server.request.duration", metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10))
	cli, _ := m.Float64Histogram("http.client.request.duration", metric.WithUnit("s"))
	other, _ := m.Int64Counter("app.orders.created")
	for i, v := range []float64{0.012, 0.03, 0.2, 1.4} {
		srv.Record(ctx, v, metric.WithAttributes(attribute.String("http.route", "/users/{id}"), attribute.String("http.request.method", "GET"),
			attribute.Int("http.response.status_code", 200+i%2*204), attribute.String("client.address", "203.0.113.77"), attribute.String("server.address", "api.example")))
	}
	cli.Record(ctx, 0.05, metric.WithAttributes(attribute.String("server.address", "horizon.example")))
	other.Add(ctx, 3)
	must(mp.Shutdown(ctx))
	fmt.Println("metrics sent via", *proto)
}

// ---------------------------------------------------------------- burst

func onePoint(prefix string, i int) []byte {
	md := pmetric.NewMetrics()
	rm := md.ResourceMetrics().AppendEmpty()
	rm.Resource().Attributes().PutStr("service.name", "checkout")
	sm := rm.ScopeMetrics().AppendEmpty()
	sm.Scope().SetName("s04/burst")
	m := sm.Metrics().AppendEmpty()
	m.SetName("http.server.request.duration")
	m.SetUnit("s")
	h := m.SetEmptyHistogram()
	h.SetAggregationTemporality(pmetric.AggregationTemporalityDelta)
	dp := h.DataPoints().AppendEmpty()
	now := time.Now()
	dp.SetStartTimestamp(pcommon.NewTimestampFromTime(now.Add(-time.Minute)))
	dp.SetTimestamp(pcommon.NewTimestampFromTime(now))
	dp.Attributes().PutStr("http.route", fmt.Sprintf("/dur/%s/%d", prefix, i))
	dp.Attributes().PutStr("http.request.method", "GET")
	dp.Attributes().PutInt("http.response.status_code", 200)
	dp.SetCount(1)
	dp.SetSum(0.1)
	dp.ExplicitBounds().FromRaw([]float64{0.05, 0.5})
	dp.BucketCounts().FromRaw([]uint64{0, 1, 0})
	b, _ := pmetricotlp.NewExportRequestFromMetrics(md).MarshalProto()
	return b
}

func burst() {
	ok := 0
	for i := 0; i < *n; i++ {
		h := gw()
		h["x-canary-hdr"] = "CANARY-HDR-0c1d" // a header a gateway should have stripped
		res := post("/v1/metrics", onePoint(*prefix, i), h, "application/x-protobuf")
		if len(res) >= 3 && res[:3] == "200" {
			ok++
		} else {
			fmt.Println("request", i, "->", res)
		}
	}
	fmt.Printf("burst %s: %d/%d accepted (HTTP 200)\n", *prefix, ok, *n)
}
