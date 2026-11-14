// SPDX-License-Identifier: Apache-2.0
package collectortests

import (
	"bytes"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/bytemaster333/usagemap/collector/tests/internal/otlpsend"
	"github.com/bytemaster333/usagemap/collector/tests/internal/sink"
)

// Resource and point attributes the writer may receive (wire-formats §g.2).
var (
	allowedResource = map[string]bool{"service.name": true, "service.instance.id": true, "service.namespace": true,
		"deployment.environment.name": true, "scf.tenant.id": true, "scf.received_at_unix_nano": true, "scf.stream.instance": true,
		"scf.tenant.level": true}
	allowedPoint = map[string]bool{"scf.route": true, "scf.rules_version": true, "http.request.method": true,
		"http.response.status_code": true, "rpc.method": true, "rpc.system": true, "rpc.system.name": true,
		"otel.metric.overflow": true, "scf.reason": true, "service.name": true}
)

// checkRecord applies the §g.2 payload contract to everything the writer got.
func checkRecord(t *testing.T, r sink.Record, wantTenant string, metrics ...string) {
	t.Helper()
	if r.Path != "/v1/metrics" {
		t.Fatalf("Collector sent %s; only /v1/metrics may leave it", r.Path)
	}
	for _, h := range r.HeaderNames {
		if strings.HasPrefix(strings.ToLower(h), "x-") {
			t.Errorf("request metadata header %s forwarded to the writer", h)
		}
	}
	if loc := canaryRE.FindIndex(r.Body); loc != nil {
		t.Errorf("canary %q reached the writer", r.Body[loc[0]:loc[1]])
	}
	md, err := r.Metrics()
	if err != nil {
		t.Fatal(err)
	}
	for _, rm := range md.ResourceMetrics().All() {
		for k, v := range rm.Resource().Attributes().All() {
			if !allowedResource[k] {
				t.Errorf("resource attribute %s reached the writer", k)
			}
			if k == "scf.tenant.id" && v.Str() != wantTenant {
				t.Errorf("tenant %s, want %s", v.Str(), wantTenant)
			}
		}
		if _, ok := rm.Resource().Attributes().Get("scf.received_at_unix_nano"); !ok {
			t.Error("scf.received_at_unix_nano missing")
		}
	}
	forPoints(md, func(_ pcommon.Resource, m pmetric.Metric, attrs pcommon.Map, _ int64) {
		if !slices.Contains(metrics, m.Name()) {
			t.Errorf("metric %s reached the writer; want only %v", m.Name(), metrics)
		}
		for k := range attrs.All() {
			if !allowedPoint[k] {
				t.Errorf("point attribute %s reached the writer", k)
			}
		}
	})
}

// TestCanaryTraceLeavesOnlyDerivedMetrics: S-04's canary trace over OTLP/HTTP
// protobuf, OTLP/HTTP JSON and gRPC → only span-derived metrics and drop
// counters reach the writer; no canary value reaches the writer, the queue
// directory, the working directory or the logs (api.drop-traces, api.attribute-allowlist).
func TestCanaryTraceLeavesOnlyDerivedMetrics(t *testing.T) {
	env, ca, srv := newEnv(t)
	s := startSink(t, ca, srv)
	c := startCollector(t, env)

	now := time.Now()
	m := meta(testTenant, now)
	if err := otlpsend.HTTPTraces(ctx(t), httpBase, canaryTraces(now), m); err != nil {
		t.Fatal(err)
	}
	if err := otlpsend.HTTPTracesJSON(ctx(t), httpBase, canaryTraces(now), m); err != nil {
		t.Fatal(err)
	}
	g, err := otlpsend.DialGRPC(grpcAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if err := g.Traces(ctx(t), canaryTraces(now), m); err != nil {
		t.Fatal(err)
	}

	const sends = 3
	counts := map[string]int64{}
	waitFor(t, 20*time.Second, "derived metrics of three canary traces", func() bool {
		clear(counts)
		for _, r := range s.Records() {
			md, err := r.Metrics()
			if err != nil {
				continue
			}
			forPoints(md, func(res pcommon.Resource, mt pmetric.Metric, attrs pcommon.Map, v int64) {
				key := mt.Name()
				if rt, ok := attrs.Get("scf.route"); ok {
					key += " " + rt.Str()
				}
				if rs, ok := attrs.Get("scf.reason"); ok {
					svc, _ := attrs.Get("service.name")
					key += " " + svc.Str() + "/" + rs.Str()
				}
				counts[key] += v
			})
		}
		return counts["scf.span.server.duration /sampled"] == 4*sends &&
			counts["scf.ingest.dropped {not_allowed}/service_not_allowed"] == sends
	})
	want := map[string]int64{
		"scf.span.server.duration /users/{id}":                 sends,
		"scf.span.server.duration /orders/{int}":               sends, // every all-digit segment folds (scf-path-rules/1.1.0)
		"scf.span.server.duration {unknown}":                   sends,
		"scf.span.server.duration /sampled":                    4 * sends, // ot=th:c → adjusted count 4
		"scf.ingest.dropped checkout/span_not_local_root":      sends,
		"scf.ingest.dropped checkout/span_not_server":          2 * sends,
		"scf.ingest.dropped {not_allowed}/service_not_allowed": sends,
	}
	for k, v := range want {
		if counts[k] != v {
			t.Errorf("%s = %d, want %d", k, counts[k], v)
		}
	}
	for k := range counts {
		if _, ok := want[k]; !ok {
			t.Errorf("unexpected series %s", k)
		}
	}
	for _, r := range s.Records() {
		checkRecord(t, r, testTenant, "scf.span.server.duration", "scf.ingest.dropped")
		if bytes.Contains(r.Body, []byte("signal_to_metrics.service.instance.id")) {
			t.Error("connector instance id not removed by transform/span_derived")
		}
	}

	// Self-metrics: no span exported; the defensive filter dropped nothing; the sanitise step counted.
	if v, ok := selfMetric(t, portMetrics, "otelcol_exporter_sent_spans", nil); ok && v != 0 {
		t.Errorf("spans exported: %v", v)
	}
	if v, _ := selfMetric(t, portMetrics, "otelcol_processor_filter_spans_filtered", nil); v != 0 {
		t.Errorf("filter/server_local_roots dropped %v spans; scfsanitize should have", v)
	}
	if v, _ := selfMetric(t, portMetrics, "otelcol_processor_scfsanitize_dropped", map[string]string{"signal": "traces", "reason": "span_not_server"}); v != 2*sends {
		t.Errorf("self-metric span_not_server = %v", v)
	}

	// Nothing on disk but derived metrics; nothing written outside the queue directory; no value in the logs.
	c.stop()
	if n := scanDir(t, env.queueDir); n == 0 {
		t.Error("queue directory empty — the test did not exercise the persistent queue")
	}
	if entries, _ := os.ReadDir(env.workDir); len(entries) != 0 {
		t.Errorf("collector wrote %d entries into its working directory", len(entries))
	}
	if loc := canaryRE.FindStringIndex(c.logs.String()); loc != nil {
		t.Errorf("canary in collector logs: %q", c.logs.String()[loc[0]:loc[1]])
	}
	if strings.Contains(c.logs.String(), testTenant) {
		t.Error("tenant id in collector logs")
	}
}

// TestLogsRefused: no logs pipeline → HTTP 404 and gRPC UNIMPLEMENTED (§f.1; api.drop-logs).
func TestLogsRefused(t *testing.T) {
	env, ca, srv := newEnv(t)
	s := startSink(t, ca, srv)
	startCollector(t, env)
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "checkout")
	rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty().Body().SetStr("CANARY-LOG-7f3a")
	m := meta(testTenant, time.Now())

	st, err := otlpsend.HTTPLogs(ctx(t), httpBase, ld, m)
	if err != nil || st != http.StatusNotFound {
		t.Fatalf("HTTP /v1/logs: status %d err %v, want 404", st, err)
	}
	st, _, err = otlpsend.Post(ctx(t), httpBase, "/v1/logs", "application/json", []byte(`{"resourceLogs":[]}`), m)
	if err != nil || st != http.StatusNotFound {
		t.Fatalf("HTTP JSON /v1/logs: status %d err %v, want 404", st, err)
	}
	g, err := otlpsend.DialGRPC(grpcAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if err := g.Logs(ctx(t), ld, m); status.Code(err) != codes.Unimplemented {
		t.Fatalf("gRPC LogsService/Export: %v, want Unimplemented", err)
	}
	time.Sleep(time.Second)
	if n := len(s.Records()); n != 0 {
		t.Fatalf("writer received %d requests after logs", n)
	}
}

// TestPayloadTenantOverwritten: a payload tenant.id / scf.tenant.id never wins
// over the gateway's x-scf-tenant-id, over HTTP and gRPC (§f.5 step 1; api.attr-tenant-service).
func TestPayloadTenantOverwritten(t *testing.T) {
	env, ca, srv := newEnv(t)
	s := startSink(t, ca, srv)
	startCollector(t, env)
	now := time.Now()
	forged := func(route string) pmetric.Metrics {
		md := onePoint("checkout", route, now, map[string]any{"tenant.id": "FORGED-TENANT"})
		res := md.ResourceMetrics().At(0).Resource().Attributes()
		res.PutStr("tenant.id", "FORGED-TENANT")
		res.PutStr("scf.tenant.id", otherTenant)
		return md
	}
	if err := otlpsend.HTTPMetrics(ctx(t), httpBase, forged("/http"), meta(testTenant, now)); err != nil {
		t.Fatal(err)
	}
	g, err := otlpsend.DialGRPC(grpcAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if err := g.Metrics(ctx(t), forged("/grpc"), meta(testTenant, now)); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 20*time.Second, "two requests at the writer", func() bool { return len(s.Records()) >= 2 })
	for _, r := range s.Records() {
		checkRecord(t, r, testTenant, "http.server.request.duration")
		if bytes.Contains(r.Body, []byte(otherTenant)) {
			t.Fatal("payload scf.tenant.id survived")
		}
	}
}

// TestSDKMetricsThroughCollector: a real Go otelhttp export (S-06b fixture)
// arrives as http.server.request.duration with scf.route and the §g.2
// attributes only (api.attribute-allowlist, api.attr-route, api.attr-status-code,
// api.attr-latency, pathnorm.tenant-http-route).
func TestSDKMetricsThroughCollector(t *testing.T) {
	env, ca, srv := newEnv(t)
	s := startSink(t, ca, srv)
	startCollector(t, env)
	b, err := os.ReadFile("../processor/scfsanitizeprocessor/testdata/sdk/go-otelhttp.metrics.json")
	if err != nil {
		t.Fatal(err)
	}
	md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(b)
	if err != nil {
		t.Fatal(err)
	}
	var newest int64
	for _, r := range md.ResourceMetrics().All() {
		for _, sm := range r.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				if m.Type() == pmetric.MetricTypeHistogram {
					for _, dp := range m.Histogram().DataPoints().All() {
						newest = max(newest, int64(dp.Timestamp()))
					}
				}
			}
		}
	}
	m := meta(testTenant, time.Unix(0, newest+int64(time.Minute)))
	if err := otlpsend.HTTPMetrics(ctx(t), httpBase, md, m); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 20*time.Second, "SDK metrics at the writer", func() bool { return len(s.Records()) >= 1 })
	r := s.Records()[0]
	checkRecord(t, r, testTenant, "http.server.request.duration", "scf.ingest.dropped")
	routes := pointRoutes(t, r)
	for _, want := range []string{"/accounts/{id}", "/assets/{code}/{issuer}", "/payments", "{unknown}"} {
		if !slices.Contains(routes, want) {
			t.Errorf("route %s missing from %v", want, routes)
		}
	}
}

// TestRequestWithoutTenantIsDropped: the gateway never forwards one; if it
// did, nothing is exported and the Collector counts it (§f.4).
func TestRequestWithoutTenantIsDropped(t *testing.T) {
	env, ca, srv := newEnv(t)
	s := startSink(t, ca, srv)
	startCollector(t, env)
	now := time.Now()
	if err := otlpsend.HTTPMetrics(ctx(t), httpBase, onePoint("checkout", "/x", now, nil), otlpsend.Meta{Allowed: "*", ReceivedAt: now.UnixNano()}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 10*time.Second, "no_tenant self-metric", func() bool {
		v, _ := selfMetric(t, portMetrics, "otelcol_processor_scfsanitize_dropped", map[string]string{"reason": "no_tenant"})
		return v == 1
	})
	time.Sleep(time.Second)
	if n := len(s.Records()); n != 0 {
		t.Fatalf("writer received %d requests", n)
	}
}

// TestQueueSurvivesKill9: with the writer down, 300 acknowledged requests sit
// in the fsync'd queue; kill -9; restart; all 300 arrive exactly once. Then
// with requests in flight during kill -9, every replay is byte-identical to
// the first delivery (the writer's batch key, §g.3; C-107).
func TestQueueSurvivesKill9(t *testing.T) {
	env, ca, srv := newEnv(t)
	c := startCollector(t, env)
	now := time.Now()
	const n = 300
	for i := range n {
		if err := otlpsend.HTTPMetrics(ctx(t), httpBase, onePoint("load", "/q/"+letters(i), now, nil), meta(testTenant, now)); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	// Every request was acknowledged after it was in the persistent queue; the
	// queue is sized in bytes (C-114).
	queued, _ := selfMetric(t, portMetrics, "otelcol_exporter_queue_size", nil)
	if queued <= 0 {
		t.Fatalf("queue holds %v bytes after %d acknowledged requests", queued, n)
	}
	c.kill9()

	c = startCollector(t, env)
	if v, _ := selfMetric(t, portMetrics, "otelcol_exporter_queue_size", nil); v != queued {
		t.Errorf("queue size after kill -9 and restart = %v bytes, want %v", v, queued)
	}
	s := startSink(t, ca, srv)
	seen := map[string]int{}
	waitFor(t, 60*time.Second, "300 distinct points at the writer", func() bool {
		clear(seen)
		for _, r := range s.Records() {
			for _, rt := range pointRoutes(t, r) {
				seen[rt]++
			}
		}
		return len(seen) == n
	})
	for rt, k := range seen {
		if k != 1 {
			t.Errorf("%s delivered %d times (nothing was in flight)", rt, k)
		}
	}

	// In flight: the writer records each request, then holds its answer.
	s.Hold(4 * time.Second)
	base := len(s.Records())
	const m = 20
	for i := range m {
		if err := otlpsend.HTTPMetrics(ctx(t), httpBase, onePoint("load", "/f/"+letters(i), now, nil), meta(testTenant, now)); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, 20*time.Second, "requests in flight", func() bool { return len(s.Records()) > base })
	c.kill9()
	s.Hold(0)
	startCollector(t, env)
	byRoute := map[string][]string{}
	waitFor(t, 60*time.Second, "20 in-flight-phase points at the writer", func() bool {
		clear(byRoute)
		for _, r := range s.Records()[base:] {
			for _, rt := range pointRoutes(t, r) {
				byRoute[rt] = append(byRoute[rt], r.BodySHA256)
			}
		}
		return len(byRoute) == m
	})
	dups := 0
	for rt, hashes := range byRoute {
		for _, h := range hashes[1:] {
			dups++
			if h != hashes[0] {
				t.Errorf("%s replayed with a different body (batch key would change)", rt)
			}
		}
	}
	t.Logf("in-flight phase: %d points, %d duplicate deliveries, all byte-identical", m, dups)
}
