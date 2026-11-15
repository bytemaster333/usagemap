// SPDX-License-Identifier: Apache-2.0

package integration

import (
	"bytes"
	"context"
	"encoding/base32"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/pmetric"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/batch"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/obs"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/rules"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/server"
	"github.com/bytemaster333/usagemap/services/metrics-writer/internal/store"
)

// Ports of the end-to-end test (writer test range 56180–56199, shifted by SCF_WSD_PORT_BASE).
var (
	e2eWriter  = portBase + 3
	e2eGRPC    = portBase + 4
	e2eHTTP    = portBase + 5
	e2eHealth  = portBase + 6
	e2eMetrics = portBase + 7
)

var repoRoot = func() string { d, _ := filepath.Abs("../../.."); return d }()

// flaky fails the first Apply of one tenant AFTER applying it (a commit whose answer is lost): the Collector retries
// the byte-identical request, which the ledger must skip (wire-formats §g.3).
type flaky struct {
	*store.Store
	tenant string
	fired  atomic.Bool
}

func (f *flaky) Apply(ctx context.Context, key [32]byte, p *batch.TenantPart) (store.Result, error) {
	r, err := f.Store.Apply(ctx, key, p)
	if err == nil && p.Tenant == f.tenant && len(p.Points) > 0 && f.fired.CompareAndSwap(false, true) {
		return store.Result{}, store.ErrUnavailable
	}
	return r, err
}

type writerHarness struct {
	srv    *server.Server
	reg    *obs.Registry
	cancel context.CancelFunc
	done   chan struct{}
}

func startWriter(t testing.TB, p *pkiFiles, port int, app server.Applier) *writerHarness {
	t.Helper()
	tr, err := server.NewTLSReloader(server.TLSFiles{CertFile: p.ServerCert, KeyFile: p.ServerKey, ClientCAFile: p.CA})
	if err != nil {
		t.Fatal(err)
	}
	reg := obs.New()
	s := server.New(server.Config{Addr: fmt.Sprintf("127.0.0.1:%d", port), ProbeInterval: 200 * time.Millisecond}, tr, app,
		reg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	opened := s.WaitOpen()
	ctx, cancel := context.WithCancel(context.Background())
	h := &writerHarness{srv: s, reg: reg, cancel: cancel, done: make(chan struct{})}
	go func() { _ = s.Run(ctx); close(h.done) }()
	t.Cleanup(func() { cancel(); <-h.done })
	select {
	case <-opened:
	case <-time.After(60 * time.Second): // same bound as the reopen wait; the coverage job runs every module at once
		t.Fatal("writer listener did not open")
	}
	return h
}

func otelcolBin(t testing.TB) string {
	p := os.Getenv("SCF_OTELCOL_BIN")
	if p == "" {
		p = filepath.Join(repoRoot, "collector/_build/scf-otelcol")
	}
	if _, err := os.Stat(p); err != nil {
		if os.Getenv("SCF_SKIP_COLLECTOR_E2E") == "1" {
			t.Skip("scf-otelcol not built and SCF_SKIP_COLLECTOR_E2E=1")
		}
		t.Fatalf("scf-otelcol binary not found at %s: run collector/scripts/build.sh (or set SCF_SKIP_COLLECTOR_E2E=1)", p)
	}
	return p
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

func startCollector(t testing.TB, p *pkiFiles, writerPort int) *lockedBuf {
	t.Helper()
	cmd := exec.Command(otelcolBin(t), "--config", filepath.Join(repoRoot, "collector/config/collector.yaml"))
	cmd.Dir = t.TempDir()
	cmd.Env = []string{
		fmt.Sprintf("SCF_WRITER_ENDPOINT=https://localhost:%d", writerPort),
		"SCF_MTLS_CA_FILE=" + p.CA, "SCF_MTLS_CERT_FILE=" + p.EdgeCert, "SCF_MTLS_KEY_FILE=" + p.EdgeKey,
		fmt.Sprintf("SCF_OTLP_GRPC_ENDPOINT=127.0.0.1:%d", e2eGRPC),
		fmt.Sprintf("SCF_OTLP_HTTP_ENDPOINT=127.0.0.1:%d", e2eHTTP),
		fmt.Sprintf("SCF_HEALTH_ENDPOINT=127.0.0.1:%d", e2eHealth),
		fmt.Sprintf("SCF_SELF_METRICS_PORT=%d", e2eMetrics),
		"SCF_QUEUE_DIR=" + filepath.Join(t.TempDir(), "queue"), "SCF_QUEUE_BYTES=67108864", "GOMAXPROCS=2",
	}
	logs := &lockedBuf{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	deadline := time.Now().Add(30 * time.Second)
	for {
		if resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", e2eHealth)); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return logs
			}
		}
		select {
		case <-done:
			t.Fatalf("collector exited:\n%s", logs.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("collector not healthy:\n%s", logs.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// postToCollector plays the gateway (wire-formats §f.4): content headers plus the six x-scf-* headers.
func postToCollector(t testing.TB, path string, body []byte, tenant string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d%s", e2eHTTP, path), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("x-scf-tenant-id", tenant)
	req.Header.Set("x-scf-token-id", "tok_e2e")
	req.Header.Set("x-scf-allowed-services", "*")
	req.Header.Set("x-scf-tenant-level", "1")
	req.Header.Set("x-scf-received-at", strconv.FormatInt(time.Now().UnixNano(), 10))
	req.Header.Set("x-scf-node", "edge-a1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("collector answered %d: %s", resp.StatusCode, b)
	}
}

func sdkFixtures(t testing.TB, kind string) []string {
	files, _ := filepath.Glob(filepath.Join(repoRoot, "collector/processor/scfsanitizeprocessor/testdata/sdk/*."+kind+".json"))
	if len(files) < 8 {
		t.Fatalf("expected the S-06 SDK fixtures, found %d %s files", len(files), kind)
	}
	return files
}

func shiftMetrics(md pmetric.Metrics, startDelta, delta int64, factor uint64) {
	shift := func(ts pcommon.Timestamp, d int64) pcommon.Timestamp {
		if ts == 0 {
			return 0
		}
		return pcommon.Timestamp(int64(ts) + d)
	}
	sh := func(ts pcommon.Timestamp) pcommon.Timestamp { return shift(ts, delta) }
	sst := func(ts pcommon.Timestamp) pcommon.Timestamp { return shift(ts, startDelta) }
	for _, rm := range md.ResourceMetrics().All() {
		for _, sm := range rm.ScopeMetrics().All() {
			for _, m := range sm.Metrics().All() {
				switch m.Type() {
				case pmetric.MetricTypeHistogram:
					for _, dp := range m.Histogram().DataPoints().All() {
						dp.SetStartTimestamp(sst(dp.StartTimestamp()))
						dp.SetTimestamp(sh(dp.Timestamp()))
						c := dp.BucketCounts().AsRaw()
						for i := range c {
							c[i] *= factor
						}
						dp.BucketCounts().FromRaw(c)
						dp.SetCount(dp.Count() * factor)
						dp.SetSum(dp.Sum() * float64(factor))
						dp.Exemplars().RemoveIf(func(pmetric.Exemplar) bool { return true })
					}
				case pmetric.MetricTypeSum:
					for _, dp := range m.Sum().DataPoints().All() {
						dp.SetStartTimestamp(sst(dp.StartTimestamp()))
						dp.SetTimestamp(sh(dp.Timestamp()))
					}
				case pmetric.MetricTypeGauge:
					for _, dp := range m.Gauge().DataPoints().All() {
						dp.SetTimestamp(sh(dp.Timestamp()))
					}
				}
			}
		}
	}
}

type expectation struct {
	count int64
	sumS  float64
}

// Real SDK payloads (S-06a/b) → the built Collector (scfsanitize, signal_to_metrics, persistent queue, mTLS) → the
// writer → PostgreSQL. Each metrics payload is exported twice like a real SDK (cumulative counts doubled the second
// time). The fixtures are first exports of fresh processes (start time seconds before the point), so the first
// export is counted in full (C-122) and the stored count of every service equals exactly the cumulative value of the
// second export; one request is committed and then answered as if the database was lost, and the Collector's
// byte-identical retry changes nothing.
func TestCollectorToWriterToDatabase(t *testing.T) {
	p := newPKI(t)
	tenant := newTenant(t)
	st := newStore(t, store.Options{})
	app := &flaky{Store: st, tenant: tenant}
	w := startWriter(t, p, e2eWriter, app)
	logs := startCollector(t, p, e2eWriter)

	want := map[string]*expectation{}
	now := time.Now()
	for _, f := range sdkFixtures(t, "metrics") {
		raw, _ := os.ReadFile(f)
		md, err := (&pmetric.JSONUnmarshaler{}).UnmarshalMetrics(raw)
		if err != nil {
			t.Fatal(err)
		}
		var maxTS int64
		for _, rm := range md.ResourceMetrics().All() {
			svc, _ := rm.Resource().Attributes().Get("service.name")
			for _, sm := range rm.ScopeMetrics().All() {
				for _, m := range sm.Metrics().All() {
					if m.Type() == pmetric.MetricTypeHistogram {
						for _, dp := range m.Histogram().DataPoints().All() {
							maxTS = max(maxTS, int64(dp.Timestamp()))
							if m.Name() == rules.MetricStable || m.Name() == rules.MetricLegacy {
								e := want[svc.Str()]
								if e == nil {
									e = &expectation{}
									want[svc.Str()] = e
								}
								e.count += 2 * int64(dp.Count()) // the second export's cumulative value
								f := 1.0
								if m.Unit() == "ms" {
									f = 0.001
								}
								e.sumS += 2 * dp.Sum() * f
							}
						}
					}
				}
			}
		}
		first := now.Add(-2 * time.Minute).UnixNano()
		a := cloneMetrics(md)
		shiftMetrics(a, first-maxTS, first-maxTS, 1)
		b := cloneMetrics(md)
		shiftMetrics(b, first-maxTS, first-maxTS+int64(30*time.Second), 2)
		for _, x := range []pmetric.Metrics{a, b} {
			body, _ := (&pmetric.ProtoMarshaler{}).MarshalMetrics(x)
			postToCollector(t, "/v1/metrics", body, tenant)
			time.Sleep(300 * time.Millisecond) // keep the two exports in order, as an SDK would
		}
	}
	traceServices := map[string]bool{}
	for _, f := range sdkFixtures(t, "traces") {
		raw, _ := os.ReadFile(f)
		td, err := (&ptrace.JSONUnmarshaler{}).UnmarshalTraces(raw)
		if err != nil {
			t.Fatal(err)
		}
		var maxEnd int64
		for _, rs := range td.ResourceSpans().All() {
			svc, _ := rs.Resource().Attributes().Get("service.name")
			traceServices[svc.Str()] = true
			for _, ss := range rs.ScopeSpans().All() {
				for _, sp := range ss.Spans().All() {
					maxEnd = max(maxEnd, int64(sp.EndTimestamp()))
				}
			}
		}
		d := now.Add(-time.Minute).UnixNano() - maxEnd
		for _, rs := range td.ResourceSpans().All() {
			for _, ss := range rs.ScopeSpans().All() {
				for _, sp := range ss.Spans().All() {
					sp.SetStartTimestamp(pcommon.Timestamp(int64(sp.StartTimestamp()) + d))
					sp.SetEndTimestamp(pcommon.Timestamp(int64(sp.EndTimestamp()) + d))
				}
			}
		}
		body, _ := (&ptrace.ProtoMarshaler{}).MarshalTraces(td)
		postToCollector(t, "/v1/traces", body, tenant)
	}

	// A Stellar secret seed in a request path: redacted by the sanitise step and counted as route_seed_redacted
	// (and route_redacted), so the tenant sees a rotate-your-key warning; the seed itself is stored nowhere.
	seed := testSeedStrKey()
	{
		td := ptrace.NewTraces()
		rs := td.ResourceSpans().AppendEmpty()
		rs.Resource().Attributes().PutStr("service.name", "seed-leak")
		sp := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
		sp.SetName("GET")
		sp.SetKind(ptrace.SpanKindServer)
		sp.SetTraceID(pcommon.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16})
		sp.SetSpanID(pcommon.SpanID{1, 2, 3, 4, 5, 6, 7, 8})
		end := now.Add(-time.Minute)
		sp.SetStartTimestamp(pcommon.NewTimestampFromTime(end.Add(-20 * time.Millisecond)))
		sp.SetEndTimestamp(pcommon.NewTimestampFromTime(end))
		sp.Attributes().PutStr("http.request.method", "GET")
		sp.Attributes().PutStr("url.path", "/accounts/"+seed+"/payments")
		sp.Attributes().PutInt("http.response.status_code", 200)
		body, _ := (&ptrace.ProtoMarshaler{}).MarshalTraces(td)
		postToCollector(t, "/v1/traces", body, tenant)
	}

	sdkCount := func(svc string) (int64, float64) {
		var n int64
		var s float64
		_ = superConn(t).QueryRow(context.Background(), `
SELECT COALESCE(sum(m.request_count), 0)::bigint, COALESCE(sum(m.duration_sum), 0)
  FROM scf.api_metrics_1m m JOIN scf.api_services s USING (tenant_id, service_id)
 WHERE m.tenant_id = $1 AND s.service_name = $2 AND m.source = 'sdk_metric'`, tenant, svc).Scan(&n, &s)
		return n, s
	}
	deadline := time.Now().Add(90 * time.Second)
	for {
		ok := true
		for svc, e := range want {
			if n, _ := sdkCount(svc); n < e.count {
				ok = false
			}
		}
		var spans int64
		_ = superConn(t).QueryRow(context.Background(), `SELECT count(DISTINCT service_id) FROM scf.api_metrics_1m
 WHERE tenant_id = $1 AND source = 'span_derived'`, tenant).Scan(&spans)
		if ok && spans >= int64(len(traceServices))-1 && app.fired.Load() {
			break
		}
		if time.Now().After(deadline) {
			for svc, e := range want {
				n, _ := sdkCount(svc)
				t.Logf("%s: stored %d of %d", svc, n, e.count)
			}
			rows, _ := superConn(t).Query(context.Background(), `SELECT reason, sum(count)::bigint FROM scf.api_ingest_counters WHERE tenant_id = $1 GROUP BY 1`, tenant)
			for rows.Next() {
				var r string
				var n int64
				_ = rows.Scan(&r, &n)
				t.Logf("counter %s = %d", r, n)
			}
			rows.Close()
			t.Fatalf("timed out waiting for the data (span services %d of %d, injected failure %v); collector log:\n%s",
				spans, len(traceServices), app.fired.Load(), tail(logs.String(), 4000))
		}
		time.Sleep(500 * time.Millisecond)
	}
	time.Sleep(3 * time.Second) // let any retry land, then check nothing was applied twice
	for svc, e := range want {
		n, s := sdkCount(svc)
		if n != e.count {
			t.Errorf("%s: stored %d requests, want exactly %d", svc, n, e.count)
		}
		if math.Abs(s-e.sumS) > 1e-6*math.Max(1, e.sumS) {
			t.Errorf("%s: stored duration_sum %.9f s, want %.9f s (legacy ms converted to s)", svc, s, e.sumS)
		}
		t.Logf("%s: %d requests, %.6f s", svc, n, s)
	}
	rows, err := superConn(t).Query(context.Background(), `
SELECT s.service_name, g.kind::text, g.scope_name, m.hist_kind::text, sum(m.request_count)::bigint
  FROM scf.api_metrics_1m m JOIN scf.api_services s USING (tenant_id, service_id)
  JOIN scf.api_stream_groups g ON g.tenant_id = m.tenant_id AND g.group_id = m.stream_group_id
 WHERE m.tenant_id = $1 GROUP BY 1, 2, 3, 4 ORDER BY 1, 2`, tenant)
	if err != nil {
		t.Fatal(err)
	}
	spanServices := map[string]bool{}
	for rows.Next() {
		var svc, kind, scope, hk string
		var n int64
		_ = rows.Scan(&svc, &kind, &scope, &hk, &n)
		t.Logf("stored: %-28s %-12s %-62s %-10s %d", svc, kind, scope, hk, n)
		if kind == rules.KindSpanDerived {
			spanServices[svc] = true
			if scope != rules.StoredConnectorScope {
				t.Errorf("span-derived scope stored as %q", scope)
			}
		}
	}
	rows.Close()
	if len(spanServices) == 0 {
		t.Fatal("no span-derived data stored")
	}
	if got := counter(t, tenant, rules.ReasonDuplicateBatch); got < 1 {
		t.Fatalf("duplicate_batch = %d: the Collector's retry of the committed request was not recognised", got)
	}
	if w.reg.Get(obs.ListenerCycles, "transition", "closed") < 1 {
		t.Fatal("the writer did not close its listener on the (injected) connection loss")
	}
	var reasons int64
	_ = superConn(t).QueryRow(context.Background(), `SELECT count(DISTINCT reason) FROM scf.api_ingest_counters
 WHERE tenant_id = $1 AND reason IN ('metric_not_allowed', 'client_metric_ignored', 'span_not_server', 'span_not_local_root')`, tenant).Scan(&reasons)
	if reasons == 0 {
		t.Fatal("no scf.ingest.dropped counters from the sanitise step reached api_ingest_counters")
	}
	if n := counter(t, tenant, rules.ReasonCumulativeFirstPoint); n != 0 {
		t.Fatalf("cumulative_first_point = %d: a fresh process's first export was only seeded (C-122)", n)
	}
	if n := counter(t, tenant, "route_seed_redacted"); n != 1 {
		t.Fatalf("route_seed_redacted = %d, want 1", n)
	}
	if n := rowCount(t, `SELECT count(*) FROM scf.api_routes WHERE tenant_id = $1 AND (route LIKE '%' || $2 || '%' OR route LIKE '%' || $3 || '%')`,
		tenant, seed[:16], seed[len(seed)-16:]); n != 0 {
		t.Fatal("a stored route carries part of the seed")
	}
	// Nothing personal reached the database: no query string, e-mail, IP address or seed in a stored route.
	if n := rowCount(t, `SELECT count(*) FROM scf.api_routes WHERE tenant_id = $1
   AND (route ~ '[?@]' OR route ~ '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' OR route ~* 'S[A-D][A-Z2-7]{54}')`, tenant); n != 0 {
		t.Fatalf("%d routes carry raw values", n)
	}
}

// testSeedStrKey builds a syntactically valid Stellar secret seed (version byte 18<<3, 32 payload bytes, CRC16-XMODEM)
// at run time, so no seed-shaped literal sits in the repository.
func testSeedStrKey() string {
	raw := []byte{18 << 3}
	for i := range 32 {
		raw = append(raw, byte(i*37+11))
	}
	var crc uint16
	for _, b := range raw {
		crc ^= uint16(b) << 8
		for range 8 {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	raw = append(raw, byte(crc), byte(crc>>8))
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return strings.TrimSpace(s)
}

func cloneMetrics(md pmetric.Metrics) pmetric.Metrics {
	out := pmetric.NewMetrics()
	md.CopyTo(out)
	return out
}
